import { queryTikTok } from "./mysql-tiktok.js";
import bcrypt from "bcryptjs";

/**
 * 按展示名精确查找广告主（name 与登录「公司名」一致，建议对接时统一 trim）
 */
export async function findAdvertiserByDisplayName(name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return null;
  const rows = await queryTikTok(
    `SELECT id, name, balance_amount, balance_currency FROM tiktok_advertiser WHERE name = ? LIMIT 1`,
    [n]
  );
  return rows?.[0] || null;
}

export async function findUserByAdvertiserAndUsername(advertiserId, username) {
  const u = typeof username === "string" ? username.trim() : "";
  if (!advertiserId || !u) return null;
  const rows = await queryTikTok(
    `SELECT id, advertiser_id, username, password_hash, is_active, is_admin, is_company_admin
     FROM tiktok_advertiser_user
     WHERE advertiser_id = ? AND username = ?
     LIMIT 1`,
    [advertiserId, u]
  );
  return rows?.[0] || null;
}

export async function getAdvertiserUserById(id) {
  const rows = await queryTikTok(
    `SELECT u.id, u.advertiser_id, u.username, u.is_active, u.is_admin, u.is_company_admin,
            a.name AS company_name, a.balance_amount, a.balance_currency
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

/**
 * 管理员切换账户：列出可切换的 active 用户
 * @param {{ q?: string, limit?: number, excludeUserId?: number | null, advertiserId?: number | null, membersOnly?: boolean }} options
 */
export async function listSwitchableAdvertiserUsers({
  q = "",
  limit = 50,
  excludeUserId = null,
  advertiserId = null,
  membersOnly = false,
} = {}) {
  const safeLimit = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), 200);
  const term = typeof q === "string" ? q.trim() : "";
  let sql = `
    SELECT u.id, u.username, u.is_admin, u.is_company_admin, a.id AS advertiser_id, a.name AS company_name
    FROM tiktok_advertiser_user u
    INNER JOIN tiktok_advertiser a ON a.id = u.advertiser_id
    WHERE u.is_active = 1
  `;
  const params = [];
  if (excludeUserId != null && Number.isFinite(Number(excludeUserId))) {
    sql += " AND u.id <> ?";
    params.push(Number(excludeUserId));
  }
  if (advertiserId != null && Number.isFinite(Number(advertiserId))) {
    sql += " AND u.advertiser_id = ?";
    params.push(Number(advertiserId));
  }
  if (membersOnly) {
    sql += " AND u.is_admin = 0 AND u.is_company_admin = 0";
  }
  if (term) {
    sql += " AND (a.name LIKE ? OR u.username LIKE ?)";
    const like = `%${term.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    params.push(like, like);
  }
  sql += ` ORDER BY a.name ASC, u.username ASC LIMIT ${safeLimit}`;
  const rows = await queryTikTok(sql, params);
  return (rows || []).map((row) => ({
    advertiserUserId: row.id,
    advertiserId: row.advertiser_id,
    username: row.username,
    companyName: row.company_name,
    isAdmin: !!row.is_admin,
    isCompanyAdmin: !!row.is_company_admin,
  }));
}
