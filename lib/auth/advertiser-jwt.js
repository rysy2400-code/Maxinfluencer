import * as jose from "jose";

const COOKIE_NAME = "maxin_advertiser_auth";
const MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 天

function getSecretKey() {
  const s = process.env.AUTH_JWT_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_JWT_SECRET 未设置或过短（生产环境必填）");
    }
    return new TextEncoder().encode("dev-only-insecure-secret-change-me");
  }
  return new TextEncoder().encode(s);
}

export { COOKIE_NAME, MAX_AGE_SEC };

/**
 * @param {{ advertiserUserId: number, advertiserId: number, username: string, companyName: string, isAdmin: boolean }} claims
 */
export async function signAdvertiserToken(claims) {
  const key = getSecretKey();
  return new jose.SignJWT({
    aid: claims.advertiserId,
    un: claims.username,
    cn: claims.companyName,
    adm: claims.isAdmin ? 1 : 0,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(claims.advertiserUserId))
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SEC}s`)
    .sign(key);
}

/** @returns {Promise<{ advertiserUserId: number, advertiserId: number, username: string, companyName: string, isAdmin: boolean } | null>} */
export async function verifyAdvertiserToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const key = getSecretKey();
    const { payload } = await jose.jwtVerify(token, key);
    const advertiserUserId = parseInt(String(payload.sub), 10);
    const rawAid = payload.aid;
    const advertiserId =
      typeof rawAid === "number" && Number.isFinite(rawAid)
        ? rawAid
        : parseInt(String(rawAid ?? ""), 10);
    if (!Number.isFinite(advertiserUserId) || !Number.isFinite(advertiserId)) return null;
    return {
      advertiserUserId,
      advertiserId,
      username: typeof payload.un === "string" ? payload.un : "",
      companyName: typeof payload.cn === "string" ? payload.cn : "",
      isAdmin: payload.adm === 1 || payload.adm === true,
    };
  } catch {
    return null;
  }
}

export function cookieIsSecure() {
  if (process.env.AUTH_COOKIE_SECURE === "0") return false;
  if (process.env.AUTH_COOKIE_SECURE === "1") return true;
  return process.env.NODE_ENV === "production";
}
