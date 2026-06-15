import {
  signAdvertiserToken,
  COOKIE_NAME,
  INBOX_COOKIE_NAME,
  MAX_AGE_SEC,
  cookieIsSecure,
} from "./advertiser-jwt.js";
import { getAdvertiserUserById } from "../db/tiktok-advertiser-dao.js";

/**
 * @param {import("next/server").NextResponse} res
 * @param {Request} req
 * @param {{ realUserId: number, actingAsUserId?: number | null }} options
 */
export async function setAdvertiserAuthCookie(res, req, { realUserId, actingAsUserId = null }) {
  const row = await getAdvertiserUserById(realUserId);
  if (!row || !row.is_active) {
    throw new Error("用户无效或已停用");
  }
  const token = await signAdvertiserToken({
    advertiserUserId: row.id,
    advertiserId: row.advertiser_id,
    username: row.username,
    companyName: row.company_name,
    isAdmin: !!row.is_admin,
    actingAsUserId,
  });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieIsSecure(req),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
  return token;
}

/**
 * @param {import("next/server").NextResponse} res
 * @param {Request} req
 * @param {number} adminUserId
 */
export async function setInboxAuthCookie(res, req, adminUserId) {
  const row = await getAdvertiserUserById(adminUserId);
  if (!row || !row.is_active || !row.is_admin) {
    throw new Error("需要管理员账号");
  }
  const token = await signAdvertiserToken({
    advertiserUserId: row.id,
    advertiserId: row.advertiser_id,
    username: row.username,
    companyName: row.company_name,
    isAdmin: true,
  });
  res.cookies.set(INBOX_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieIsSecure(req),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
  return token;
}

/** @param {import("next/server").NextResponse} res @param {Request} req */
export function clearAdvertiserAuthCookie(res, req) {
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: cookieIsSecure(req),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** @param {import("next/server").NextResponse} res @param {Request} req */
export function clearInboxAuthCookie(res, req) {
  res.cookies.set(INBOX_COOKIE_NAME, "", {
    httpOnly: true,
    secure: cookieIsSecure(req),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
