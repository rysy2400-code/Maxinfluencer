import { NextResponse } from "next/server";
import { queryTikTok } from "../../../../../lib/db/mysql-tiktok.js";

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

/**
 * GET /api/campaigns/[id]/candidates
 *
 * 默认：返回该 campaign 下候选表全部行（原有行为，供「已分析红人」等全量视图）。
 *
 * 查询参数 analyzed=1：仅返回 match_analysis IS NOT NULL 的「已分析」行（执行面板 Tab），
 * 含 match_analysis、分页；与 candidate-analysis-feed 判定一致。
 *
 * - limit：默认 30，最大 50
 * - beforeId：上一页最后一条的 id，游标分页（与 candidate-analysis-feed 一致）
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
        created_at
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
    const beforeId =
      beforeIdRaw != null && beforeIdRaw !== "" && Number.isFinite(Number(beforeIdRaw))
        ? Number(beforeIdRaw)
        : null;

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
        created_at
      FROM tiktok_campaign_influencer_candidates
      WHERE campaign_id = ?
        AND match_analysis IS NOT NULL
        ${beforeId != null ? "AND id < ?" : ""}
      ORDER BY COALESCE(analyzed_at, created_at) DESC, id DESC
      LIMIT ${limit}
    `;
    const sqlParams = beforeId != null ? [campaignId, beforeId] : [campaignId];
    const rows = await queryTikTok(sql, sqlParams);

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
        matchAnalysis,
      };

      const { matchAnalysis: _snapMa, ...snapshotRest } =
        snapshot && typeof snapshot === "object" ? snapshot : {};
      return { ...snapshotRest, ...base };
    });

    const last = (rows || []).length > 0 ? rows[rows.length - 1] : null;
    const nextBeforeId = last?.id != null ? String(last.id) : null;

    return NextResponse.json({
      success: true,
      data: candidates,
      nextBeforeId,
    });
  } catch (error) {
    console.error("[Campaign Candidates API] 获取候选红人失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "获取候选红人失败" },
      { status: 500 }
    );
  }
}
