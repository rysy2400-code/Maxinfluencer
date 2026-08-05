import { NextResponse } from "next/server";
import { queryTikTok } from "../../../../../lib/db/mysql-tiktok.js";
import { loadAnalyzedBreakdown } from "../../../../../lib/db/execution-counts-cache.js";

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** 已分析列表键集游标：{ analyzedAt: ISO, id }，与 (campaign_id, analyzed_at DESC, id DESC) 索引匹配 */
function encodeAnalyzedCursor(row) {
  if (!row || row.id == null || row.analyzed_at == null) return null;
  const analyzedAt =
    row.analyzed_at instanceof Date
      ? row.analyzed_at.toISOString()
      : String(row.analyzed_at);
  return Buffer.from(
    JSON.stringify({ analyzedAt, id: Number(row.id) })
  ).toString("base64url");
}

function decodeAnalyzedCursor(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const id = Number(parsed?.id);
    const analyzedAt = parsed?.analyzedAt ? new Date(parsed.analyzedAt) : null;
    if (!Number.isInteger(id) || id <= 0) return null;
    if (!analyzedAt || Number.isNaN(analyzedAt.getTime())) return null;
    return { id, analyzedAt };
  } catch {
    return null;
  }
}

/**
 * GET /api/campaigns/[id]/candidates
 *
 * 默认：返回该 campaign 下候选表全部行（原有行为，供「已分析红人」等全量视图）。
 *
 * 查询参数 analyzed=1：仅返回 match_analysis IS NOT NULL 的「已分析」行（执行面板 Tab），
 * 含 match_analysis、分页；与 candidate-analysis-feed 判定一致。
 *
 * - limit：默认 30，最大 50
 * - beforeId：上一页最后一条的键集游标（base64url，含 analyzedAt + id）
 * - countOnly=1：仅返回全库统计（match_analysis IS NOT NULL 总数 + 推荐/不推荐人数，与列表分组规则一致）
 * - 首屏（无 beforeId）列表响应中带 totalMatchAnalysisCount、analyzedRecommendedDbCount、analyzedNotRecommendedDbCount
 */
export async function GET(req, { params }) {
  try {
    const { id: campaignId } = params;

    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaign ID" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const analyzedMode =
      searchParams.get("analyzed") === "1" || searchParams.get("analyzed") === "true";
    const countOnly =
      searchParams.get("countOnly") === "1" || searchParams.get("countOnly") === "true";

    if (analyzedMode && countOnly) {
      const breakdown = await loadAnalyzedBreakdown(campaignId);
      if (!breakdown) {
        return NextResponse.json({
          success: true,
          totalMatchAnalysisCount: 0,
          analyzedRecommendedDbCount: 0,
          analyzedNotRecommendedDbCount: 0,
        });
      }
      return NextResponse.json({
        success: true,
        totalMatchAnalysisCount: breakdown.totalMatchAnalysisCount,
        analyzedRecommendedDbCount: breakdown.analyzedRecommendedDbCount,
        analyzedNotRecommendedDbCount: breakdown.analyzedNotRecommendedDbCount,
      });
    }

    if (!analyzedMode) {
      const rows = await queryTikTok(
        `
      SELECT
        tiktok_username,
        influencer_id AS platform_influencer_id,
        influencer_snapshot,
        match_score,
        should_contact,
        analysis_summary,
        analyzed_at,
        picked_at,
        created_at,
        source
      FROM tiktok_campaign_influencer_candidates
      WHERE campaign_id = ?
      ORDER BY
        picked_at IS NULL DESC,
        COALESCE(match_score, 0) DESC,
        analyzed_at DESC,
        created_at DESC
    `,
        [campaignId]
      );

      const candidates = (rows || []).map((r) => {
        let snapshot;
        try {
          snapshot =
            typeof r.influencer_snapshot === "string"
              ? JSON.parse(r.influencer_snapshot || "{}")
              : r.influencer_snapshot || {};
        } catch {
          snapshot = {};
        }

        return {
          influencerId: r.tiktok_username,
          platformInfluencerId: r.platform_influencer_id || null,
          matchScore: typeof r.match_score === "number" ? r.match_score : null,
          shouldContact: !!r.should_contact,
          analysisSummary: r.analysis_summary || "",
          analyzedAt: r.analyzed_at,
          pickedAt: r.picked_at,
          createdAt: r.created_at,
          source: r.source || "web_search",
          snapshot,
        };
      });

      return NextResponse.json({
        success: true,
        data: candidates,
      });
    }

    const limitRaw = Number(searchParams.get("limit") || 30);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 30, 1), 50);
    const beforeIdRaw = searchParams.get("beforeId");
    const cursor = decodeAnalyzedCursor(beforeIdRaw);

    const sql = `
      SELECT
        id,
        tiktok_username,
        influencer_id AS platform_influencer_id,
        influencer_snapshot,
        match_score,
        should_contact,
        analysis_summary,
        match_analysis,
        analyzed_at,
        picked_at,
        created_at,
        source
      FROM tiktok_campaign_influencer_candidates
      WHERE campaign_id = ?
        AND match_analysis IS NOT NULL
        ${cursor ? "AND (analyzed_at < ? OR (analyzed_at = ? AND id < ?))" : ""}
      ORDER BY analyzed_at DESC, id DESC
      LIMIT ${limit}
    `;
    const sqlParams = cursor
      ? [campaignId, cursor.analyzedAt, cursor.analyzedAt, cursor.id]
      : [campaignId];

    let totalMatchAnalysisCount = null;
    let analyzedRecommendedDbCount = null;
    let analyzedNotRecommendedDbCount = null;
    const countPromise =
      cursor == null ? loadAnalyzedBreakdown(campaignId) : Promise.resolve(null);

    const [breakdown, rows] = await Promise.all([
      countPromise ?? Promise.resolve(null),
      queryTikTok(sql, sqlParams),
    ]);

    if (breakdown) {
      totalMatchAnalysisCount = breakdown.totalMatchAnalysisCount;
      analyzedRecommendedDbCount = breakdown.analyzedRecommendedDbCount;
      analyzedNotRecommendedDbCount = breakdown.analyzedNotRecommendedDbCount;
    }

    const candidates = (rows || []).map((r) => {
      const snapshot =
        parseJson(r.influencer_snapshot) ||
        (typeof r.influencer_snapshot === "object" && r.influencer_snapshot) ||
        {};
      const matchAnalysisCol = parseJson(r.match_analysis);
      const matchAnalysis =
        matchAnalysisCol && typeof matchAnalysisCol === "object"
          ? matchAnalysisCol
          : snapshot.matchAnalysis && typeof snapshot.matchAnalysis === "object"
            ? snapshot.matchAnalysis
            : null;

      const base = {
        id: r.tiktok_username,
        candidateRowId: r.id,
        platformInfluencerId: r.platform_influencer_id || null,
        matchScore: typeof r.match_score === "number" ? r.match_score : null,
        shouldContact: !!r.should_contact,
        analysisSummary: r.analysis_summary || "",
        analyzedAt: r.analyzed_at,
        pickedAt: r.picked_at,
        createdAt: r.created_at,
        source: r.source || "web_search",
        matchAnalysis,
      };

      return { ...snapshot, ...base };
    });

    const last = (rows || []).length > 0 ? rows[rows.length - 1] : null;
    const nextBeforeId = last ? encodeAnalyzedCursor(last) : null;

    const payload = {
      success: true,
      data: candidates,
      nextBeforeId,
    };
    if (totalMatchAnalysisCount != null) {
      payload.totalMatchAnalysisCount = totalMatchAnalysisCount;
    }
    if (analyzedRecommendedDbCount != null && analyzedNotRecommendedDbCount != null) {
      payload.analyzedRecommendedDbCount = analyzedRecommendedDbCount;
      payload.analyzedNotRecommendedDbCount = analyzedNotRecommendedDbCount;
    }
    return NextResponse.json(payload);
  } catch (error) {
    console.error("[Campaign Candidates API] 获取候选红人失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "获取候选红人失败" },
      { status: 500 }
    );
  }
}
