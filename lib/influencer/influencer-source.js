/** 候选/执行红人来源：用户导入名单 */
export const INFLUENCER_SOURCE_USER = "user_upload";

/** 候选/执行红人来源：平台搜索发现 */
export const INFLUENCER_SOURCE_PLATFORM = "web_search";

/**
 * @param {unknown} source
 * @returns {typeof INFLUENCER_SOURCE_USER | typeof INFLUENCER_SOURCE_PLATFORM}
 */
export function normalizeInfluencerSource(source) {
  const s = String(source || "").trim();
  if (s === INFLUENCER_SOURCE_USER) return INFLUENCER_SOURCE_USER;
  return INFLUENCER_SOURCE_PLATFORM;
}

/**
 * @param {unknown} source
 * @returns {"用户" | "平台"}
 */
export function formatInfluencerSourceLabel(source) {
  return normalizeInfluencerSource(source) === INFLUENCER_SOURCE_USER ? "用户" : "平台";
}

/**
 * @param {unknown} source
 */
export function isUserImportedSource(source) {
  return normalizeInfluencerSource(source) === INFLUENCER_SOURCE_USER;
}
