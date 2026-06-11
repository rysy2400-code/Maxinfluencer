import { queryTikTok } from "../db/mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../db/campaign-execution-keys.js";

/**
 * 聊天消息中的可点击执行看板红人标记，前端解析为跳转到对应红人卡片。
 * @param {string} username - TikTok handle（不含 @）
 */
export function formatExecInfluencerMention(username) {
  const u = String(username || "")
    .trim()
    .replace(/^@/, "");
  if (!u) return "红人";
  return `[EXEC:@${u}]`;
}

/**
 * 平台侧红人主键（TikTok 数字 userId、YouTube channel id 等），不是可展示的 @handle。
 * @param {string|null|undefined} key
 */
export function isPlatformCreatorId(key) {
  const k = String(key || "")
    .trim()
    .replace(/^@/, "");
  if (!k) return false;
  if (/^\d+$/.test(k)) return true;
  if (/^UC[\w-]{10,}$/i.test(k)) return true;
  return false;
}

/**
 * 按 campaign + 红人键（handle 或 platform userId）反查 tiktok_username。
 * @param {string} campaignId
 * @param {string} influencerKey
 * @returns {Promise<string|null>}
 */
export async function resolveTiktokUsernameForExecution(campaignId, influencerKey) {
  const cid = String(campaignId || "").trim();
  const key = String(influencerKey || "")
    .trim()
    .replace(/^@/, "");
  if (!cid || !key) return null;

  const rows = await queryTikTok(
    `
    SELECT tiktok_username
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
    LIMIT 1
  `,
    [cid, ...paramsExecutionCreatorMatch(key)]
  );
  let username = rows?.[0]?.tiktok_username;
  if (!username && /^UC[\w-]{10,}$/i.test(key)) {
    const ciRows = await queryTikTok(
      `
      SELECT tiktok_username
      FROM tiktok_campaign_execution
      WHERE campaign_id = ?
        AND influencer_id IS NOT NULL
        AND LOWER(influencer_id) = LOWER(?)
      LIMIT 1
    `,
      [cid, key]
    );
    username = ciRows?.[0]?.tiktok_username;
  }
  if (username) {
    return String(username).trim().replace(/^@/, "");
  }

  if (!isPlatformCreatorId(key)) return key;
  return null;
}
