/**
 * 产品链接归一化与判重工具。
 *
 * 判重规则（用户确认）：去掉 https://、www.、尾部斜杠，统一小写后再比较。
 */

/**
 * 归一化产品链接。
 * @param {unknown} link
 * @returns {string|null} 归一化后的链接；无法归一化时返回 null
 */
export function normalizeProductLink(link) {
  if (link == null) return null;
  let s = String(link).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^www\./i, "");
  s = s.replace(/\/+$/, "");
  return s || null;
}

/**
 * 判断两个产品链接是否为同一链接（按归一化规则）。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function isSameProductLink(a, b) {
  const na = normalizeProductLink(a);
  const nb = normalizeProductLink(b);
  if (!na || !nb) return false;
  return na === nb;
}
