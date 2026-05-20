import { NextResponse } from "next/server";
import { getCampaignBySessionId } from "../../../../../lib/db/campaign-dao.js";
import { getAuthenticatedAdvertiserUser } from "../../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessSession } from "../../../../../lib/auth/session-access.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/campaign
 * 按会话 id 解析 tiktok_campaign（执行面板以 session 为权威来源，避免 context.campaignId 脏数据）
 */
export async function GET(req, { params }) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }

    const { id: sessionId } = params;
    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: "缺少会话 ID" },
        { status: 400 }
      );
    }

    const access = await assertUserCanAccessSession(sessionId, auth);
    if (!access.ok) {
      return NextResponse.json(
        {
          success: false,
          error: access.status === 403 ? "无权访问该会话" : "会话不存在",
        },
        { status: access.status }
      );
    }

    const campaign = await getCampaignBySessionId(sessionId);
    if (!campaign) {
      return NextResponse.json(
        { success: false, error: "该会话尚未关联已发布的 Campaign" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      campaignId: campaign.id,
      sessionId: campaign.sessionId,
      status: campaign.status,
      influencersPerDay: campaign.influencersPerDay,
    });
  } catch (error) {
    console.error("[Sessions Campaign API] 解析 campaign 失败:", error);
    return NextResponse.json(
      { success: false, error: error.message || "解析 Campaign 失败" },
      { status: 500 }
    );
  }
}
