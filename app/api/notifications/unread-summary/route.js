import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { loadUnreadSummary } from "../../../../lib/db/unread-dao.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/unread-summary
 *
 * 侧栏未读汇总：每个 session 的「Bin 聊天未读条数 + 红人未读红人数」。
 * 可见范围按当前实际查看的账号（代看时为被代看账号）判定，
 * 已读水位按真实登录用户各自计算。
 */
export async function GET(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }

    const sessions = await loadUnreadSummary(
      auth.realUser.advertiserUserId,
      auth.effectiveUser.advertiserUserId
    );

    return NextResponse.json({ success: true, sessions });
  } catch (error) {
    console.error("[Notifications] 未读汇总失败:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "获取未读汇总失败" },
      { status: 500 }
    );
  }
}
