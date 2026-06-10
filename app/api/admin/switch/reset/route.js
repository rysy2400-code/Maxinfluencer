import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { setAdvertiserAuthCookie } from "../../../../lib/auth/advertiser-auth-cookie.js";
import { insertAdminActionLog } from "../../../../lib/db/admin-action-log-dao.js";
import { normalizeAdvertiserBalance } from "../../../../lib/utils/advertiser-balance.js";
import { getAdvertiserUserById } from "../../../../lib/db/tiktok-advertiser-dao.js";

export const dynamic = "force-dynamic";

/** POST /api/admin/switch/reset */
export async function POST(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, error: "请先登录" }, { status: 401 });
    }
    if (!auth.realUser?.isAdmin) {
      return NextResponse.json({ success: false, error: "无权限" }, { status: 403 });
    }

    const realRow = await getAdvertiserUserById(auth.realUser.advertiserUserId);
    if (!realRow) {
      return NextResponse.json({ success: false, error: "用户不存在" }, { status: 400 });
    }

    const res = NextResponse.json({
      success: true,
      user: {
        companyName: realRow.company_name,
        username: realRow.username,
        isAdmin: true,
        isActingAs: false,
        realUser: {
          companyName: realRow.company_name,
          username: realRow.username,
        },
        balance: normalizeAdvertiserBalance(realRow.balance_amount, realRow.balance_currency),
      },
    });

    await setAdvertiserAuthCookie(res, req, {
      realUserId: auth.realUser.advertiserUserId,
      actingAsUserId: null,
    });

    if (auth.isActingAs) {
      await insertAdminActionLog({
        realAdvertiserUserId: auth.realUser.advertiserUserId,
        effectiveAdvertiserUserId: auth.realUser.advertiserUserId,
        action: "switch_reset",
        meta: {
          companyName: realRow.company_name,
          username: realRow.username,
        },
      });
    }

    return res;
  } catch (error) {
    console.error("[admin/switch/reset]", error);
    return NextResponse.json(
      { success: false, error: error.message || "切回失败" },
      { status: 500 }
    );
  }
}
