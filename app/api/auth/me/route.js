import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "../../../../lib/auth/advertiser-auth-http.js";
import { normalizeAdvertiserBalance } from "../../../../lib/utils/advertiser-balance.js";
import { getAdvertiserUserById } from "../../../../lib/db/tiktok-advertiser-dao.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const auth = await getAuthenticatedAdvertiserUser(req);
    if (!auth) {
      return NextResponse.json({ success: false, authenticated: false }, { status: 401 });
    }
    const row = await getAdvertiserUserById(auth.effectiveUser.advertiserUserId);
    const balance = normalizeAdvertiserBalance(row?.balance_amount, row?.balance_currency);
    return NextResponse.json({
      success: true,
      authenticated: true,
      user: {
        companyName: auth.effectiveUser.companyName,
        username: auth.effectiveUser.username,
        isAdmin: auth.realUser.isAdmin,
        isCompanyAdmin: auth.realUser.isCompanyAdmin,
        isActingAs: auth.isActingAs,
        realUser: {
          companyName: auth.realUser.companyName,
          username: auth.realUser.username,
        },
        balance,
      },
    });
  } catch (error) {
    console.error("[auth/me]", error);
    return NextResponse.json(
      { success: false, error: error.message || "读取失败" },
      { status: 500 }
    );
  }
}
