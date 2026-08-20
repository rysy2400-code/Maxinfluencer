// 平台 influencer_id 归一化：把 handle / 用户名 / display_name 统一成 tiktok_influencer.influencer_id
import { queryTikTok } from "../db/mysql-tiktok.js";

const NORMALIZE_CACHE = new Map();

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

/**
 * 输入任意标识（平台 influencer_id / username / display_name / handle），
 * 返回规范平台 influencer_id；找不到返回 null。
 * 带进程内缓存，避免同一批事件反复查库。
 * @param {string|null|undefined} idOrHandle
 * @returns {Promise<string|null>}
 */
export async function normalizeCanonicalInfluencerId(idOrHandle) {
  const key = normalizeKey(idOrHandle);
  if (!key) return null;
  if (NORMALIZE_CACHE.has(key)) return NORMALIZE_CACHE.get(key);

  const rows = await queryTikTok(
    `SELECT influencer_id FROM tiktok_influencer
     WHERE influencer_id = ?
        OR LOWER(TRIM(username)) = ?
        OR LOWER(TRIM(display_name)) = ?
     LIMIT 1`,
    [key, key, key]
  );
  const canonical = rows && rows[0] ? rows[0].influencer_id : null;
  NORMALIZE_CACHE.set(key, canonical);
  return canonical;
}

export function clearNormalizeCache() {
  NORMALIZE_CACHE.clear();
}
