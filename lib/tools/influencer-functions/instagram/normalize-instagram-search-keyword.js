/**
 * Instagram keyword SERP 仅对单个 hashtag 有效，如 #student → explore/search/keyword/?q=%23student
 */

export function normalizeInstagramSearchKeyword(keyword) {
  const raw = String(keyword || "").trim();
  if (!raw) return raw;

  let tag = raw.startsWith("#") ? raw.slice(1) : raw;
  // 多词短语（历史脏数据）：取首 token 并补 #，避免搜索 URL 完全无效
  tag = tag.split(/\s+/)[0];
  tag = tag.replace(/[^A-Za-z0-9_]/g, "");
  if (!tag) return raw.startsWith("#") ? raw : `#${raw}`;
  return `#${tag}`;
}

export function buildInstagramKeywordSearchUrl(keyword) {
  const q = normalizeInstagramSearchKeyword(keyword);
  return `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`;
}
