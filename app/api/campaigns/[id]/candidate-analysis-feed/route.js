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
 * GET /api/campaigns/[id]/candidate-analysis-feed?limit=5&beforeId=123
 * 分页返回已有 match_analysis 的候选红人（用于刷新后历史；INSERT IGNORE 后仅首次入库有记录）
 */
export async function GET(req, { params }) {
  try {
    const campaignId = params?.id;
    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaign ID" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const limitRaw = Number(searchParams.get("limit") || 5);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 5, 1), 50);
    const beforeIdRaw = searchParams.get("beforeId");
    const beforeId =
      beforeIdRaw != null && beforeIdRaw !== "" && Number.isFinite(Number(beforeIdRaw))
        ? Number(beforeIdRaw)
        : null;

    const sql = `
      SELECT
        id,
        tiktok_username AS influencerId,
        influencer_id AS platformInfluencerId,
        match_score AS matchScore,
        should_contact AS shouldContact,
        analysis_summary AS analysisSummary,
        match_analysis AS matchAnalysisRaw,
        analyzed_at AS analyzedAt
      FROM tiktok_campaign_influencer_candidates
      WHERE campaign_id = ?
        AND match_analysis IS NOT NULL
        ${beforeId != null ? "AND id < ?" : ""}
      ORDER BY COALESCE(analyzed_at, created_at) DESC, id DESC
      LIMIT ${limit}
    `;
    const sqlParams = beforeId != null ? [campaignId, beforeId] : [campaignId];
    const rows = await queryTikTok(sql, sqlParams);

    const items = (rows || []).map((r) => ({
      id: r.id,
      influencerId: r.influencerId,
      platformInfluencerId: r.platformInfluencerId || null,
      matchScore: r.matchScore,
      shouldContact: r.shouldContact,
      analysisSummary: r.analysisSummary,
      matchAnalysis: parseJson(r.matchAnalysisRaw),
      analyzedAt: r.analyzedAt,
    }));

    const last = items.length > 0 ? items[items.length - 1] : null;
    const nextBeforeId = last?.id != null ? String(last.id) : null;

    return NextResponse.json({
      success: true,
      campaignId,
      items,
      nextBeforeId,
    });
  } catch (error) {
    console.error("[candidate-analysis-feed]", error);
    return NextResponse.json(
      { success: false, error: error.message || "查询失败" },
      { status: 500 }
    );
  }
}
