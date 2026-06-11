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
 * 按 campaign + 红人键（handle 或 platform userId）反查 tiktok_username。
 * @param {string} campaignId
 * @param {string} influencerKey
 * @returns {Promise<string|null>}
 */
export async function resolveTiktokUsernameForExecution(campaignId, influencerKey) {
  const cid = String(campaignId || "").trim();
  const key = String(influencerKey || "").trim();
  if (!cid || !key) return null;

  if (!/^\d+$/.test(key)) {
    return key.replace(/^@/, "");
  }

  const rows = await queryTikTok(
    `
    SELECT tiktok_username
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
    LIMIT 1
  `,
    [cid, ...paramsExecutionCreatorMatch(key)]
  );
  const username = rows?.[0]?.tiktok_username;
  return username ? String(username).trim().replace(/^@/, "") : null;
}
