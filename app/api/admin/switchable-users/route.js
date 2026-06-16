import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { canSwitchAccounts, canSwitchToTarget } from "../../../../lib/auth/account-switch.js";
import { listSwitchableAdvertiserUsers } from "../../../../lib/db/tiktok-advertiser-dao.js";

export const dynamic = "force-dynamic";

/** GET /api/admin/switchable-users?q=&limit=50 */
export async function GET(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }
    if (!canSwitchAccounts(auth.realUser)) {
      return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q") || "";
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const isPlatformAdmin = !!auth.realUser.isAdmin;

    const users = await listSwitchableAdvertiserUsers({
      q,
      limit,
      excludeUserId: auth.isActingAs ? null : auth.realUser.advertiserUserId,
      advertiserId: isPlatformAdmin ? null : auth.realUser.advertiserId,
      membersOnly: !isPlatformAdmin,
    });

    return NextResponse.json({ success: true, users, count: users.length });
  } catch (error) {
    console.error("[admin/switchable-users]", error);
    return NextResponse.json(
      { success: false, error: error.message || "查询失败" },
      { status: 500 }
    );
  }
}
