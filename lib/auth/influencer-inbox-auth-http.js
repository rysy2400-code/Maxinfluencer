import { NextResponse } from "next/server";
import { getAuthenticatedInboxAdmin } from "./advertiser-auth-http.js";

/**
 * @param {Request} req
 */
export async function requireInboxAdmin(req) {
  const admin = await getAuthenticatedInboxAdmin(req);
  if (!admin) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: "需要管理员登录红人收件箱" },
        { status: 401 }
      ),
    };
  }
  return { ok: true, admin };
}
