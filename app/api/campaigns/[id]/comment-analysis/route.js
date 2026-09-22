import { NextResponse } from "next/server";
import { queryTikTok } from "../../../../../lib/db/mysql-tiktok.js";
import { getCommentAnalyses } from "../../../../../lib/db/comment-analysis-store.js";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessCampaign } from "../../../../../lib/auth/campaign-access.js";

const SUPPORTED_PLATFORMS = ["tiktok", "instagram"];

/**
 * GET /api/campaigns/[id]/comment-analysis
 * 返回该 campaign 待审核价格红人的「评论数据分析」结果（LLM 语义分析，离线批量生成）。
 */
export async function GET(req, { params }) {
  try {
    const { id: campaignId } = params;
    if (!campaignId) {
      return NextResponse.json({ success: false, error: "缺少 campaign ID" }, { status: 400 });
    }
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "未登录" }, { status: 401 });
    }
    const access = await assertUserCanAccessCampaign(campaignId, auth);
    if (!access?.ok) {
      return NextResponse.json(
        { success: false, error: "无权访问该 campaign" },
        { status: access?.status || 403 }
      );
    }

    const rows = await queryTikTok(
      `SELECT tiktok_username AS username, platform
       FROM tiktok_campaign_execution
       WHERE campaign_id = ?
         AND stage IN ('quote_submitted','quote_rejected')
         AND platform IN (${SUPPORTED_PLATFORMS.map(() => "?").join(",")})`,
      [campaignId, ...SUPPORTED_PLATFORMS]
    );
    const byPlatform = { tiktok: [], instagram: [] };
    for (const r of rows) {
      const p = String(r.platform || "").toLowerCase();
      if (byPlatform[p]) byPlatform[p].push(r.username);
    }

    const analyses = {};
    for (const platform of SUPPORTED_PLATFORMS) {
      analyses[platform] = await getCommentAnalyses(platform, byPlatform[platform]);
    }
    const covered =
      Object.keys(analyses.tiktok).length + Object.keys(analyses.instagram).length;
    return NextResponse.json({
      success: true,
      campaignId,
      coverage: { total: rows.length, covered, pending: Math.max(0, rows.length - covered) },
      analyses,
    });
  } catch (error) {
    console.error("[Comment Analysis API] 获取评论数据分析失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "获取评论数据分析失败" },
      { status: 500 }
    );
  }
}
