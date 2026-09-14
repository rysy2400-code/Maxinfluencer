import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessCampaign } from "../../../../lib/auth/campaign-access.js";
import {
  EMPTY_UNREAD_DETAIL,
  loadCampaignUnreadDetail,
} from "../../../../lib/db/unread-dao.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/unread-detail?campaignId=xxx
 *
 * 单个 campaign 的未读明细：
 * - byStage：各 tab / 子 tab 的未读红人数
 * - byInfluencer：每个红人的 eventUnread（tab 判定）/ cardUnread（卡片红色数字）
 */
export async function GET(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const campaignId = String(searchParams.get("campaignId") || "").trim();
    if (!campaignId) {
      return NextResponse.json(
        { success: false, error: "缺少 campaignId" },
        { status: 400 }
      );
    }

    const access = await assertUserCanAccessCampaign(campaignId, auth);
    if (!access.ok) {
      const status = access.status === 404 ? 404 : access.status === 403 ? 403 : 401;
      return NextResponse.json(
        { success: false, error: status === 404 ? "Campaign 不存在" : "无权查看" },
        { status }
      );
    }

    const detail = await loadCampaignUnreadDetail(
      auth.realUser.advertiserUserId,
      campaignId
    );

    return NextResponse.json({ success: true, campaignId, ...detail });
  } catch (error) {
    console.error("[Notifications] 未读明细失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取未读明细失败" },
      { status: 500 }
    );
  }
}
