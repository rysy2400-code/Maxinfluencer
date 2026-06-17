import { NextResponse } from "next/server";
import { getAuthenticatedAdvertiserUser } from "./advertiser-auth-http.js";

/**
 * 账单 API：公司管理员或平台管理员（realUser）
 * 数据范围：effectiveUser.advertiserId
 * @param {Request} req
 */
export async function requireBillingAccess(req) {
  const auth = await getAuthenticatedAdvertiserUser(req);
  if (!auth) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: "请先登录" }, { status: 401 }),
    };
  }
  if (!auth.realUser.isCompanyAdmin && !auth.realUser.isAdmin) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: "需要公司管理员权限" }, { status: 403 }),
    };
  }
  return { ok: true, auth };
}
