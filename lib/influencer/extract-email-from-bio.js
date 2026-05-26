/**
 * 从红人简介文本中提取首个邮箱（TikTok / Instagram 共用）
 * @param {unknown} bio
 * @returns {string|null}
 */
export function extractEmailFromBio(bio) {
  if (typeof bio !== "string" || !bio.includes("@")) return null;
  let s = bio.trim();
  s = s.replace(/"\s*,\s*"email"\s*:\s*"/gi, " ");
  const re =
    /\b([a-zA-Z0-9](?:[-a-zA-Z0-9._+%]*[a-zA-Z0-9])?@(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})\b/;
  const m = s.match(re);
  if (!m) return null;
  return m[1].toLowerCase();
}
