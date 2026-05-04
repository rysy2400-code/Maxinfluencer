import { verifyAdvertiserToken, COOKIE_NAME } from "./advertiser-jwt.js";
import { getAdvertiserUserById } from "../db/tiktok-advertiser-dao.js";

/** @param {Request} request */
export function readAuthCookieValue(request) {
  const c = request.headers.get("cookie");
  if (!c) return null;
  const parts = c.split(";").map((p) => p.trim());
  const prefix = `${COOKIE_NAME}=`;
  for (const p of parts) {
    if (p.startsWith(prefix)) return decodeURIComponent(p.slice(prefix.length));
  }
  return null;
}

/**
 * 解析 Cookie JWT 并校验用户仍有效（is_active）
 * @param {Request} request
 * @returns {Promise<{ advertiserUserId: number, advertiserId: number, username: string, companyName: string, isAdmin: boolean } | null>}
 */
export async function getAuthenticatedAdvertiserUser(request) {
  const raw = readAuthCookieValue(request);
  const claims = await verifyAdvertiserToken(raw);
  if (!claims) return null;
  const row = await getAdvertiserUserById(claims.advertiserUserId);
  if (!row) return null;
  if (!row.is_active) return null;
  return {
    advertiserUserId: row.id,
    advertiserId: row.advertiser_id,
    username: row.username,
    companyName: row.company_name,
    isAdmin: !!row.is_admin,
  };
}
