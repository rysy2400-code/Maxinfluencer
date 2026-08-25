/** 候选/执行红人来源：用户导入名单 */
export const INFLUENCER_SOURCE_USER = "user_upload";

/** 候选/执行红人来源：平台搜索发现 */
export const INFLUENCER_SOURCE_PLATFORM = "web_search";

/** 候选红人来源：用户导入的「仅排重/不联系」名单 */
export const INFLUENCER_SOURCE_EXCLUDE = "user_exclude";

/**
 * @param {unknown} source
 * @returns {typeof INFLUENCER_SOURCE_USER | typeof INFLUENCER_SOURCE_PLATFORM}
 */
export function normalizeInfluencerSource(source) {
  const s = String(source || "").trim();
  if (s === INFLUENCER_SOURCE_USER) return INFLUENCER_SOURCE_USER;
  if (s === INFLUENCER_SOURCE_EXCLUDE) return INFLUENCER_SOURCE_EXCLUDE;
  return INFLUENCER_SOURCE_PLATFORM;
}

/**
 * @param {unknown} source
 * @returns {"用户" | "平台" | "用户排除"}
 */
export function formatInfluencerSourceLabel(source) {
  const s = String(source || "").trim();
  if (s === INFLUENCER_SOURCE_EXCLUDE) return "用户排除";
  return normalizeInfluencerSource(source) === INFLUENCER_SOURCE_USER ? "用户" : "平台";
}

/**
 * @param {unknown} source
 */
export function isUserImportedSource(source) {
  const s = String(source || "").trim();
  return (
    s === INFLUENCER_SOURCE_USER ||
    s === INFLUENCER_SOURCE_EXCLUDE ||
    normalizeInfluencerSource(source) === INFLUENCER_SOURCE_USER
  );
}
