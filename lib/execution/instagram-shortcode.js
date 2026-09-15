/**
 * Instagram shortcode ↔ 数字 media id 互转。
 *
 * Instagram 私有接口 /api/v1/media/{id}/info/ 只认数字 media id，
 * 而链接里是 base64 字母表的 shortcode（如 DdQ5YvdpMUz → 3985938059104666931）。
 */

export const IG_SHORTCODE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** shortcode → 数字 media id；非法字符返回 null */
export function igShortcodeToMediaId(shortcode) {
  const sc = String(shortcode || "").trim();
  if (!sc) return null;
  let id = 0n;
  for (const ch of sc) {
    const v = IG_SHORTCODE_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    id = id * 64n + BigInt(v);
  }
  return id > 0n ? id.toString() : null;
}

/** 数字 media id → shortcode（回写/校验用） */
export function igMediaIdToShortcode(mediaId) {
  const raw = String(mediaId || "").trim();
  if (!/^\d+$/.test(raw)) return null;
  let n = BigInt(raw);
  if (n <= 0n) return null;
  let out = "";
  while (n > 0n) {
    const rem = Number(n % 64n);
    out = IG_SHORTCODE_ALPHABET[rem] + out;
    n /= 64n;
  }
  return out;
}
