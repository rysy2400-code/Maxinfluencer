import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { canSwitchAccounts, canSwitchToTarget } from "../../../../lib/auth/account-switch.js";
import { getAdvertiserUserById } from "../../../../lib/db/tiktok-advertiser-dao.js";
import { setAdvertiserAuthCookie } from "../../../../lib/auth/advertiser-auth-cookie.js";
import { insertAdminActionLog } from "../../../../lib/db/admin-action-log-dao.js";
import { normalizeAdvertiserBalance } from "../../../../lib/utils/advertiser-balance.js";

export const dynamic = "force-dynamic";

/** POST /api/admin/switch  Body: { advertiserUserId: number } */
export async function POST(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }
    if (!canSwitchAccounts(auth.realUser)) {
      return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const targetId = Number(body.advertiserUserId);
    if (!Number.isFinite(targetId)) {
      return NextResponse.json({ success: false, error: "缺少 advertiserUserId" }, { status: 400 });
    }

    const targetRow = await getAdvertiserUserById(targetId);
    if (!targetRow || !targetRow.is_active) {
      return NextResponse.json({ success: false, error: "目标账户不存在或已停用" }, { status: 400 });
    }
    if (!canSwitchToTarget(auth.realUser, targetRow)) {
      return NextResponse.json({ success: false, error: "无权切换到该账户" }, { status: 403 });
    }

    const res = NextResponse.json({
      success: true,
      user: {
        companyName: targetRow.company_name,
        username: targetRow.username,
        isAdmin: auth.realUser.isAdmin,
        isCompanyAdmin: auth.realUser.isCompanyAdmin,
        isActingAs: targetId !== auth.realUser.advertiserUserId,
        realUser: {
          companyName: auth.realUser.companyName,
          username: auth.realUser.username,
        },
        balance: normalizeAdvertiserBalance(targetRow.balance_amount, targetRow.balance_currency),
      },
    });

    await setAdvertiserAuthCookie(res, req, {
      realUserId: auth.realUser.advertiserUserId,
      actingAsUserId: targetId,
    });

    await insertAdminActionLog({
      realAdvertiserUserId: auth.realUser.advertiserUserId,
      effectiveAdvertiserUserId: targetId,
      action: "switch_to",
      meta: {
        companyName: targetRow.company_name,
        username: targetRow.username,
      },
    });

    return res;
  } catch (error) {
    console.error("[admin/switch]", error);
    return NextResponse.json(
      { success: false, error: error.message || "切换失败" },
      { status: 500 }
    );
  }
}
