/**
 * tiktok_campaign_execution 按红人定位：业务侧常传 TikTok handle 或平台 userId。
 * 列 tiktok_username = handle；influencer_id = 与 tiktok_influencer.influencer_id 一致的 userId（可空）。
 */
export const SQL_EXECUTION_CREATOR_MATCH =
  "(tiktok_username = ? OR influencer_id = ?)";

/** JOIN / 子查询中带表别名 e 时使用 */
export const SQL_EXECUTION_CREATOR_MATCH_E =
  "(e.tiktok_username = ? OR e.influencer_id = ?)";

/** @param {string|null|undefined} key */
export function paramsExecutionCreatorMatch(key) {
  const k = key == null ? "" : String(key).trim();
  return [k, k];
}
