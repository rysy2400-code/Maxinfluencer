/**
 * 未读提示：已读水位 DAO
 *
 * 水位一律按「真实登录用户」记账（调用方传 auth.realUser.advertiserUserId）。
 * 管理员代看（actingAs）时读到哪算管理员自己读到哪，不影响被代看账号。
 */
import { queryTikTok } from "./mysql-tiktok.js";

export const READ_SCOPE_SESSION = "session";
export const READ_SCOPE_CAMPAIGN_INFLUENCER = "campaign_influencer";

export function influencerReadScopeKey(campaignId, username) {
  return `${String(campaignId || "").trim()}:${String(username || "").trim()}`;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 批量读取水位。
 * @returns {Map<string, { lastReadSeq: number, lastReadCardSeq: number, lastReadAt: string|null }>}
 */
export async function getReadStateMap(readerUserId, scope, scopeKeys) {
  const uid = toInt(readerUserId);
  const keys = Array.isArray(scopeKeys)
    ? [...new Set(scopeKeys.map((k) => String(k || "").trim()).filter(Boolean))]
    : [];
  const map = new Map();
  if (!uid || !scope || keys.length === 0) return map;

  const marks = keys.map(() => "?").join(",");
  const rows = await queryTikTok(
    `
    SELECT scope_key, last_read_seq, last_read_card_seq, last_read_at
    FROM tiktok_user_read_state
    WHERE reader_user_id = ?
      AND scope = ?
      AND scope_key IN (${marks})
    `,
    [uid, scope, ...keys]
  );
  for (const row of rows || []) {
    map.set(String(row.scope_key), {
      lastReadSeq: Number(row.last_read_seq || 0),
      lastReadCardSeq: Number(row.last_read_card_seq || 0),
      lastReadAt: row.last_read_at || null,
    });
  }
  return map;
}

export async function getReadState(readerUserId, scope, scopeKey) {
  const map = await getReadStateMap(readerUserId, scope, [scopeKey]);
  return map.get(String(scopeKey)) || null;
}

/**
 * 推进会话聊天框水位。seq 取会话当前的 assistant_message_seq。
 * 水位只增不减（GREATEST），并发/重放都不会回退。
 */
export async function markSessionRead(readerUserId, sessionId, seq) {
  const uid = toInt(readerUserId);
  const key = String(sessionId || "").trim();
  if (!uid || !key) return { success: false, message: "缺少 readerUserId 或 sessionId" };
  await queryTikTok(
    `
    INSERT INTO tiktok_user_read_state
      (reader_user_id, scope, scope_key, last_read_seq, last_read_card_seq, last_read_at)
    VALUES (?, ?, ?, ?, 0, NOW())
    ON DUPLICATE KEY UPDATE
      last_read_seq = GREATEST(last_read_seq, VALUES(last_read_seq)),
      last_read_at = NOW()
    `,
    [uid, READ_SCOPE_SESSION, key, toInt(seq)]
  );
  return { success: true };
}

/**
 * 推进单个红人卡片的沟通记录水位。
 * @param {number} eventSeq  对应 tiktok_campaign_execution.infl_event_seq
 * @param {number} cardSeq   对应 tiktok_campaign_execution.infl_card_seq
 */
export async function markInfluencerRead(
  readerUserId,
  campaignId,
  username,
  { eventSeq = 0, cardSeq = 0 } = {}
) {
  const uid = toInt(readerUserId);
  const key = influencerReadScopeKey(campaignId, username);
  if (!uid || !campaignId || !String(username || "").trim()) {
    return { success: false, message: "缺少 readerUserId / campaignId / username" };
  }
  await queryTikTok(
    `
    INSERT INTO tiktok_user_read_state
      (reader_user_id, scope, scope_key, last_read_seq, last_read_card_seq, last_read_at)
    VALUES (?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      last_read_seq = GREATEST(last_read_seq, VALUES(last_read_seq)),
      last_read_card_seq = GREATEST(last_read_card_seq, VALUES(last_read_card_seq)),
      last_read_at = NOW()
    `,
    [
      uid,
      READ_SCOPE_CAMPAIGN_INFLUENCER,
      key,
      toInt(eventSeq),
      toInt(cardSeq),
    ]
  );
  return { success: true };
}
