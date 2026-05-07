import { NextResponse } from "next/server";
import { queryTikTok } from "../../../../../lib/db/mysql-tiktok.js";

/**
 * GET /api/campaigns/[id]/candidates
 * 返回某个 campaign 的已分析候选红人列表（用于前端“已分析红人”视图）
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
  } catch (error) {
    console.error("[Campaign Candidates API] 获取候选红人失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "获取候选红人失败" },
      { status: 500 }
    );
  }
}

