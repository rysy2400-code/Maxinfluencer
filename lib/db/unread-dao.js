/**
 * 未读聚合查询（Bin 工作台）
 *
 * 读取侧全部是纯 SQL：写入侧维护的 infl_event_seq / infl_card_seq /
 * assistant_message_seq 与 tiktok_user_read_state 水位直接比较，不解析 JSON。
 *
 * 口径：
 * - 会话聊天框未读 = assistant_message_seq - 已读水位
 * - 红人未读（tab 徽标 / campaign 红人数）= infl_event_seq > 已读水位
 * - 红人卡片红色数字 = infl_card_seq - 卡片已读水位（不含寄样条目）
 * - 不启用徽标的阶段（已拒绝报价、待确认寄样信息）不参与计算
 */
import { queryTikTok } from "./mysql-tiktok.js";
import { READ_SCOPE_CAMPAIGN_INFLUENCER, READ_SCOPE_SESSION } from "./user-read-state-dao.js";

/** 参与未读徽标的执行阶段（对应启用的 5 个 tab / 子 tab） */
export const UNREAD_STAGES = [
  "quote_submitted",
  "pending_creator_confirmation",
  "pending_sample",
  "script_review",
  "video_review",
  "published",
];

/** tab 徽标分组：一个红人只属于一个分组（分组之间不重叠） */
const UNREAD_TAB_GROUPS = {
  pendingPrice: ["quote_submitted", "pending_creator_confirmation"],
  pendingSample: ["pending_sample"],
  pendingDraftScript: ["script_review"],
  pendingDraftVideo: ["video_review"],
  published: ["published"],
};

export const EMPTY_UNREAD_DETAIL = {
  byStage: {
    pendingPrice: 0,
    pendingSample: 0,
    pendingDraft: 0,
    pendingDraftScript: 0,
    pendingDraftVideo: 0,
    published: 0,
  },
  byInfluencer: {},
  total: 0,
};

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function stagePlaceholders() {
  return UNREAD_STAGES.map(() => "?").join(",");
}

/**
 * 会话聊天框未读数（按真实登录用户水位）。
 * @returns {Promise<Record<string, number>>} sessionId → 未读条数
 */
export async function loadSessionChatUnread(readerUserId, advertiserUserId) {
  const uid = toInt(readerUserId);
  const ownerId = toInt(advertiserUserId);
  if (!uid || !ownerId) return {};

  const rows = await queryTikTok(
    `
    SELECT
      s.id AS session_id,
      COALESCE(s.assistant_message_seq, 0) AS msg_seq,
      COALESCE(r.last_read_seq, 0) AS read_seq
    FROM tiktok_campaign_sessions s
    LEFT JOIN tiktok_user_read_state r
      ON r.reader_user_id = ?
     AND r.scope = ?
     AND r.scope_key = s.id
    WHERE s.advertiser_user_id = ?
      AND (s.status = 'draft' OR s.published_user_hidden_at IS NULL)
    `,
    [uid, READ_SCOPE_SESSION, ownerId]
  );

  const map = {};
  for (const row of rows || []) {
    const unread = Math.max(0, Number(row.msg_seq || 0) - Number(row.read_seq || 0));
    if (unread > 0) map[String(row.session_id)] = unread;
  }
  return map;
}

/**
 * 各 campaign 的红人未读人数（有未读的红人去重计数）。
 * @returns {Promise<Record<string, number>>} campaignId → 红人数
 */
export async function loadCampaignRedUnreadCounts(readerUserId, campaignIds) {
  const uid = toInt(readerUserId);
  const ids = Array.isArray(campaignIds)
    ? [...new Set(campaignIds.map((x) => String(x || "").trim()).filter(Boolean))]
    : [];
  if (!uid || ids.length === 0) return {};

  const campaignMarks = ids.map(() => "?").join(",");
  const rows = await queryTikTok(
    `
    SELECT e.campaign_id AS campaign_id, COUNT(*) AS cnt
    FROM tiktok_campaign_execution e
    LEFT JOIN tiktok_user_read_state r
      ON r.reader_user_id = ?
     AND r.scope = ?
     AND r.scope_key = CONCAT(e.campaign_id, ':', e.tiktok_username)
    WHERE e.campaign_id IN (${campaignMarks})
      AND e.tiktok_username IS NOT NULL
      AND TRIM(e.tiktok_username) <> ''
      AND e.stage IN (${stagePlaceholders()})
      AND COALESCE(e.infl_event_seq, 0) > COALESCE(r.last_read_seq, 0)
    GROUP BY e.campaign_id
    `,
    [uid, READ_SCOPE_CAMPAIGN_INFLUENCER, ...ids, ...UNREAD_STAGES]
  );

  const map = {};
  for (const row of rows || []) {
    const n = Number(row.cnt || 0);
    if (n > 0) map[String(row.campaign_id)] = n;
  }
  return map;
}

/**
 * 单个 campaign 的未读明细：各 tab 红人数 + 每个红人的未读数。
 */
export async function loadCampaignUnreadDetail(readerUserId, campaignId) {
  const uid = toInt(readerUserId);
  const cid = String(campaignId || "").trim();
  if (!uid || !cid) return { ...EMPTY_UNREAD_DETAIL };

  const rows = await queryTikTok(
    `
    SELECT
      e.tiktok_username AS username,
      e.stage AS stage,
      COALESCE(e.infl_event_seq, 0) AS event_seq,
      COALESCE(e.infl_card_seq, 0) AS card_seq,
      COALESCE(r.last_read_seq, 0) AS read_seq,
      COALESCE(r.last_read_card_seq, 0) AS read_card_seq
    FROM tiktok_campaign_execution e
    LEFT JOIN tiktok_user_read_state r
      ON r.reader_user_id = ?
     AND r.scope = ?
     AND r.scope_key = CONCAT(e.campaign_id, ':', e.tiktok_username)
    WHERE e.campaign_id = ?
      AND e.tiktok_username IS NOT NULL
      AND TRIM(e.tiktok_username) <> ''
      AND e.stage IN (${stagePlaceholders()})
    `,
    [uid, READ_SCOPE_CAMPAIGN_INFLUENCER, cid, ...UNREAD_STAGES]
  );

  const byInfluencer = {};
  const badgeStageCounts = {
    pendingPrice: 0,
    pendingSample: 0,
    pendingDraftScript: 0,
    pendingDraftVideo: 0,
    published: 0,
  };
  let total = 0;

  for (const row of rows || []) {
    const username = String(row.username || "").trim();
    if (!username) continue;
    const eventUnread = Math.max(
      0,
      Number(row.event_seq || 0) - Number(row.read_seq || 0)
    );
    const cardUnread = Math.max(
      0,
      Number(row.card_seq || 0) - Number(row.read_card_seq || 0)
    );
    if (eventUnread <= 0 && cardUnread <= 0) continue;

    byInfluencer[username] = { eventUnread, cardUnread };

    if (eventUnread > 0) {
      total += 1;
      const stage = String(row.stage || "");
      for (const [groupKey, stages] of Object.entries(UNREAD_TAB_GROUPS)) {
        if (stages.includes(stage)) {
          badgeStageCounts[groupKey] += 1;
          break;
        }
      }
    }
  }

  return {
    byStage: {
      pendingPrice: badgeStageCounts.pendingPrice,
      pendingSample: badgeStageCounts.pendingSample,
      pendingDraft:
        badgeStageCounts.pendingDraftScript + badgeStageCounts.pendingDraftVideo,
      pendingDraftScript: badgeStageCounts.pendingDraftScript,
      pendingDraftVideo: badgeStageCounts.pendingDraftVideo,
      published: badgeStageCounts.published,
    },
    byInfluencer,
    total,
  };
}

/**
 * 读取单个红人当前的未读计数基准（用于标记已读时对齐水位）。
 */
export async function loadInfluencerSeq(campaignId, username) {
  const cid = String(campaignId || "").trim();
  const handle = String(username || "").trim().replace(/^@/, "");
  if (!cid || !handle) return null;
  const rows = await queryTikTok(
    `
    SELECT
      COALESCE(infl_event_seq, 0) AS event_seq,
      COALESCE(infl_card_seq, 0) AS card_seq
    FROM tiktok_campaign_execution
    WHERE campaign_id = ?
      AND (tiktok_username = ? OR influencer_id = ?)
    LIMIT 1
    `,
    [cid, handle, handle]
  );
  if (!rows || !rows[0]) return null;
  return {
    eventSeq: Number(rows[0].event_seq || 0),
    cardSeq: Number(rows[0].card_seq || 0),
  };
}

/**
 * 读取会话当前的 Bin 消息计数（用于标记已读时对齐水位）。
 */
export async function loadSessionMessageSeq(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return 0;
  const rows = await queryTikTok(
    `
    SELECT COALESCE(assistant_message_seq, 0) AS msg_seq
    FROM tiktok_campaign_sessions
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );
  return Number(rows?.[0]?.msg_seq || 0);
}

/**
 * 侧栏用的未读汇总：每个 session 的「聊天未读 + 红人未读红人数」。
 *
 * 可见范围按 advertiserUserId（代看时传被代看账号）判定；
 * 水位按 readerUserId（真实登录用户）计算。
 *
 * @returns {Promise<Record<string, { chat: number, red: number, total: number }>>}
 */
export async function loadUnreadSummary(readerUserId, advertiserUserId) {
  const uid = toInt(readerUserId);
  const ownerId = toInt(advertiserUserId);
  if (!uid || !ownerId) return {};

  const rows = await queryTikTok(
    `
    SELECT
      s.id AS session_id,
      COALESCE(s.assistant_message_seq, 0) AS msg_seq,
      COALESCE(r.last_read_seq, 0) AS read_seq,
      (
        SELECT tc.id FROM tiktok_campaign tc
        WHERE tc.session_id = s.id AND tc.status <> 'deleted'
        ORDER BY tc.created_at DESC
        LIMIT 1
      ) AS campaign_id
    FROM tiktok_campaign_sessions s
    LEFT JOIN tiktok_user_read_state r
      ON r.reader_user_id = ?
     AND r.scope = ?
     AND r.scope_key = s.id
    WHERE s.advertiser_user_id = ?
      AND (s.status = 'draft' OR s.published_user_hidden_at IS NULL)
    `,
    [uid, READ_SCOPE_SESSION, ownerId]
  );

  const sessionRows = rows || [];
  const campaignIds = [
    ...new Set(
      sessionRows
        .map((row) => (row.campaign_id == null ? "" : String(row.campaign_id).trim()))
        .filter(Boolean)
    ),
  ];
  const redCounts = campaignIds.length
    ? await loadCampaignRedUnreadCounts(uid, campaignIds)
    : {};

  const summary = {};
  for (const row of sessionRows) {
    const sessionId = String(row.session_id);
    const chat = Math.max(
      0,
      Number(row.msg_seq || 0) - Number(row.read_seq || 0)
    );
    const campaignId =
      row.campaign_id == null ? "" : String(row.campaign_id).trim();
    const red = campaignId ? Number(redCounts[campaignId] || 0) : 0;
    const total = chat + red;
    if (total > 0) summary[sessionId] = { chat, red, total };
  }
  return summary;
}
