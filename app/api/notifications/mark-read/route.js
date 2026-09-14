import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { assertUserCanAccessSession } from "../../../../lib/auth/session-access.js";
import { assertUserCanAccessCampaign } from "../../../../lib/auth/campaign-access.js";
import {
  markInfluencerRead,
  markSessionRead,
} from "../../../../lib/db/user-read-state-dao.js";
import {
  loadInfluencerSeq,
  loadSessionMessageSeq,
} from "../../../../lib/db/unread-dao.js";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/mark-read
 *
 * Body:
 *   { scope: "session", sessionId }
 *   { scope: "campaign_influencer", campaignId, username }
 *
 * 水位按真实登录用户记账；管理员代看时读到哪算管理员自己读到哪。
 */
export async function POST(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const scope = String(body?.scope || "").trim();
    const readerUserId = auth.realUser.advertiserUserId;

    if (scope === "session") {
      const sessionId = String(body?.sessionId || "").trim();
      if (!sessionId) {
        return NextResponse.json(
          { success: false, error: "缺少 sessionId" },
          { status: 400 }
        );
      }
      const access = await assertUserCanAccessSession(sessionId, auth);
      if (!access.ok) {
        return NextResponse.json(
          { success: false, error: access.status === 404 ? "会话不存在" : "无权操作" },
          { status: access.status === 404 ? 404 : access.status === 403 ? 403 : 401 }
        );
      }
      const seq = await loadSessionMessageSeq(sessionId);
      await markSessionRead(readerUserId, sessionId, seq);
      return NextResponse.json({ success: true, scope, sessionId, seq });
    }

    if (scope === "campaign_influencer") {
      const campaignId = String(body?.campaignId || "").trim();
      const username = String(body?.username || "").trim().replace(/^@/, "");
      if (!campaignId || !username) {
        return NextResponse.json(
          { success: false, error: "缺少 campaignId 或 username" },
          { status: 400 }
        );
      }
      const access = await assertUserCanAccessCampaign(campaignId, auth);
      if (!access.ok) {
        return NextResponse.json(
          { success: false, error: access.status === 404 ? "Campaign 不存在" : "无权操作" },
          { status: access.status === 404 ? 404 : access.status === 403 ? 403 : 401 }
        );
      }
      const seq = (await loadInfluencerSeq(campaignId, username)) || {
        eventSeq: 0,
        cardSeq: 0,
      };
      await markInfluencerRead(readerUserId, campaignId, username, seq);
      return NextResponse.json({
        success: true,
        scope,
        campaignId,
        username,
        ...seq,
      });
    }

    return NextResponse.json(
      { success: false, error: "scope 非法" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[Notifications] 标记已读失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "标记已读失败" },
      { status: 500 }
    );
  }
}
