import {
  verifyAdvertiserToken,
  COOKIE_NAME,
  INBOX_COOKIE_NAME,
} from "./advertiser-jwt.js";
import { getAdvertiserUserById } from "../db/tiktok-advertiser-dao.js";

/** @param {Request} request @param {string} cookieName */
export function readCookieValue(request, cookieName) {
  const c = request.headers.get("cookie");
  if (!c) return null;
  const parts = c.split(";").map((p) => p.trim());
  const prefix = `${cookieName}=`;
  for (const p of parts) {
    if (p.startsWith(prefix)) return decodeURIComponent(p.slice(prefix.length));
  }
  return null;
}

/** @param {Request} request */
export function readAuthCookieValue(request) {
  return readCookieValue(request, COOKIE_NAME);
}

/** @param {object | null | undefined} row */
function userFromRow(row) {
  if (!row) return null;
  return {
    advertiserUserId: row.id,
    advertiserId: row.advertiser_id,
    username: row.username,
    companyName: row.company_name,
    isAdmin: !!row.is_admin,
  };
}

/**
 * @param {{ advertiserUserId: number, advertiserId: number, username: string, companyName: string, isAdmin: boolean, actingAsUserId?: number | null }} claims
 */
async function buildAuthContextFromClaims(claims) {
  const realRow = await getAdvertiserUserById(claims.advertiserUserId);
  if (!realRow || !realRow.is_active) return null;
  const realUser = userFromRow(realRow);
  if (!realUser) return null;

  let effectiveUser = realUser;
  let isActingAs = false;

  if (claims.actingAsUserId != null && Number.isFinite(claims.actingAsUserId)) {
    if (!realUser.isAdmin) return null;
    const targetRow = await getAdvertiserUserById(claims.actingAsUserId);
    if (!targetRow || !targetRow.is_active) return null;
    const targetUser = userFromRow(targetRow);
    if (!targetUser) return null;
    effectiveUser = targetUser;
    isActingAs = targetUser.advertiserUserId !== realUser.advertiserUserId;
  }

  return {
    realUser,
    effectiveUser,
    isActingAs,
    advertiserUserId: effectiveUser.advertiserUserId,
    advertiserId: effectiveUser.advertiserId,
    username: effectiveUser.username,
    companyName: effectiveUser.companyName,
    isAdmin: realUser.isAdmin,
  };
}

/**
 * 解析首页 Campaign Cookie JWT 并校验用户仍有效（is_active）
 * @param {Request} request
 */
export async function getAuthenticatedAdvertiserUser(request) {
  const raw = readAuthCookieValue(request);
  const claims = await verifyAdvertiserToken(raw);
  if (!claims) return null;
  return buildAuthContextFromClaims(claims);
}

/**
 * 解析红人收件箱独立 Cookie（仅管理员登录时签发）
 * @param {Request} request
 */
export async function getAuthenticatedInboxAdmin(request) {
  const raw = readCookieValue(request, INBOX_COOKIE_NAME);
  const claims = await verifyAdvertiserToken(raw);
  if (!claims || !claims.isAdmin) return null;
  const row = await getAdvertiserUserById(claims.advertiserUserId);
  if (!row || !row.is_active || !row.is_admin) return null;
  return userFromRow(row);
}
