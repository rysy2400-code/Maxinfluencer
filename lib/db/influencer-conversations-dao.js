import { queryTikTok } from "./mysql-tiktok.js";

function encodeListCursor({ sortTime, influencerId }) {
  if (!sortTime || !influencerId) return null;
  return Buffer.from(
    JSON.stringify({ sortTime, influencerId: String(influencerId) }),
    "utf8"
  ).toString("base64url");
}

function decodeListCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), "base64url").toString("utf8");
    const obj = JSON.parse(raw);
    if (!obj || !obj.sortTime || obj.influencerId == null) return null;
    return {
      sortTime: obj.sortTime,
      influencerId: String(obj.influencerId),
    };
  } catch {
    return null;
  }
}

function normalizeLimit(limit, defaultValue = 40, maxValue = 100) {
  const n = Number(limit || defaultValue);
  if (Number.isNaN(n)) return defaultValue;
  return Math.max(1, Math.min(maxValue, Math.floor(n)));
}

function searchPattern(q) {
  const s = String(q || "").trim();
  if (!s) return null;
  return `%${s.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

/**
 * 仅包含有对话记录的红人（conversation_messages 至少一条）
 */
export async function listInfluencerConversations({
  q = null,
  cursor = null,
  limit = 40,
} = {}) {
  const pageSize = normalizeLimit(limit);
  const decoded = decodeListCursor(cursor);
  const like = searchPattern(q);

  const params = [];
  let cursorSql = "";
  if (decoded) {
    cursorSql = `AND (
      last_event_time < ?
      OR (last_event_time = ? AND influencer_id < ?)
    )`;
    params.push(decoded.sortTime, decoded.sortTime, decoded.influencerId);
  }

  let searchSql = "";
  if (like) {
    searchSql = `AND (
      l.influencer_id LIKE ?
      OR IFNULL(i.username, '') LIKE ?
      OR IFNULL(i.display_name, '') LIKE ?
      OR IFNULL(i.influencer_email, '') LIKE ?
    )`;
    params.push(like, like, like, like);
  }

  const sql = `
    WITH latest AS (
      SELECT
        m.influencer_id,
        COALESCE(m.event_time, m.sent_at, m.created_at) AS last_event_time,
        m.subject AS last_subject,
        m.body_text AS last_body_text,
        m.event_type AS last_event_type,
        ROW_NUMBER() OVER (
          PARTITION BY m.influencer_id
          ORDER BY COALESCE(m.event_time, m.sent_at, m.created_at) DESC, m.id DESC
        ) AS rn
      FROM tiktok_influencer_conversation_messages m
    )
    SELECT
      l.influencer_id,
      l.last_event_time,
      l.last_subject,
      l.last_body_text,
      l.last_event_type,
      i.display_name,
      i.username,
      i.influencer_email,
      i.handover_mode
    FROM latest l
    LEFT JOIN tiktok_influencer i ON i.influencer_id = l.influencer_id
    WHERE l.rn = 1
    ${cursorSql}
    ${searchSql}
    ORDER BY l.last_event_time DESC, l.influencer_id DESC
    LIMIT ${pageSize + 1}
  `;

  const rows = await queryTikTok(sql, params);
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeListCursor({
          sortTime: last.last_event_time,
          influencerId: last.influencer_id,
        })
      : null;

  const items = pageRows.map((r) => ({
    influencerId: r.influencer_id,
    displayName: r.display_name || null,
    username: r.username || null,
    email: r.influencer_email || null,
    handoverMode: r.handover_mode || "assist",
    lastEventTime: r.last_event_time,
    lastPreview: {
      eventType: r.last_event_type || null,
      subject: r.last_subject || null,
      bodyText: r.last_body_text || null,
    },
  }));

  return { items, hasMore, nextCursor };
}

export async function getLatestInboundMessageId(influencerId) {
  if (!influencerId) return null;
  const rows = await queryTikTok(
    `
    SELECT message_id
    FROM tiktok_influencer_conversation_messages
    WHERE influencer_id = ?
      AND (
        event_type = 'email_inbound'
        OR (event_type IS NULL AND direction = 'influencer' AND channel = 'email')
      )
      AND message_id IS NOT NULL
      AND TRIM(message_id) <> ''
    ORDER BY COALESCE(event_time, sent_at, created_at) DESC, id DESC
    LIMIT 1
  `,
    [influencerId]
  );
  return rows?.[0]?.message_id || null;
}
