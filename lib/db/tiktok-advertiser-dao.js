import { queryTikTok } from "./mysql-tiktok.js";
import bcrypt from "bcryptjs";

/**
 * 按展示名精确查找广告主（name 与登录「公司名」一致，建议对接时统一 trim）
 */
export async function findAdvertiserByDisplayName(name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return null;
  const rows = await queryTikTok(`SELECT id, name FROM tiktok_advertiser WHERE name = ? LIMIT 1`, [n]);
  return rows?.[0] || null;
}

export async function findUserByAdvertiserAndUsername(advertiserId, username) {
  const u = typeof username === "string" ? username.trim() : "";
  if (!advertiserId || !u) return null;
  const rows = await queryTikTok(
    `SELECT id, advertiser_id, username, password_hash, is_active, is_admin
     FROM tiktok_advertiser_user
     WHERE advertiser_id = ? AND username = ?
     LIMIT 1`,
    [advertiserId, u]
  );
  return rows?.[0] || null;
}

export async function getAdvertiserUserById(id) {
  const rows = await queryTikTok(
    `SELECT u.id, u.advertiser_id, u.username, u.is_active, u.is_admin, a.name AS company_name
     FROM tiktok_advertiser_user u
     INNER JOIN tiktok_advertiser a ON a.id = u.advertiser_id
     WHERE u.id = ?
     LIMIT 1`,
    [id]
  );
  return rows?.[0] || null;
}

export async function verifyPassword(plain, passwordHash) {
  if (!plain || !passwordHash) return false;
  return bcrypt.compare(plain, passwordHash);
}

export function hashPasswordForStorage(plain) {
  return bcrypt.hashSync(plain, 10);
}
