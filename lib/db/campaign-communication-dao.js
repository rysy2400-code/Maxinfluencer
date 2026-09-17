import { queryTikTok } from "./mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "./campaign-execution-keys.js";
import { listInboundAttachmentsByEmailEventIds } from "./influencer-inbound-attachments-dao.js";
import { selectDisplayableInboundAttachments } from "../influencer/inbound-attachment-urls.js";

const ASK_EVENT_TYPE = "ask_influencer_special_request";
const REPLY_EVENT_TYPE = "creator_replied_special_request";

function parseJsonColumn(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter((x) => x && typeof x === "object");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((x) => x && typeof x === "object")
      : [];
  } catch {
    return [];
  }
}

function toIso(at) {
  if (at == null) return null;
  if (at instanceof Date) {
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  }
  const raw = String(at).trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toTimeMs(at) {
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? 0 : at.getTime();
  if (at == null) return 0;
  const d = new Date(String(at).trim());
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function normalizeAttachmentMeta(rawAttachments) {
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments
    .map((att, idx) => ({
      fileName:
        typeof att?.fileName === "string" && att.fileName.trim()
          ? att.fileName.trim()
          : typeof att?.filename === "string" && att.filename.trim()
          ? att.filename.trim()
          : `附件 ${idx + 1}`,
      storageKey:
        typeof att?.storageKey === "string" ? att.storageKey.trim() : null,
      contentType: att?.contentType || null,
      sizeBytes:
        typeof att?.sizeBytes === "number" && Number.isFinite(att.sizeBytes)
          ? att.sizeBytes
          : null,
    }))
    .filter((att) => att.fileName || att.storageKey);
}

function parseAskEvent(row) {
  const p = parseJsonColumn(row?.payload) || {};
  const text =
    p.brandMessage ||
    p.requestDetail ||
    p.requestMessage ||
    p.message ||
    "";
  const status = String(row?.status || "").toLowerCase();
  const specialRequestStatus =
    p.specialRequestStatus || p.status || "pending_creator";
  return {
    key: `special-ask-${row?.id}`,
    source: "special_request",
    direction: "brand_to_creator",
    role: "advertiser",
    type: "ask",
    text: typeof text === "string" ? text.trim() : String(text || ""),
    note:
      typeof p.note === "string" && p.note.trim() ? p.note.trim() : null,
    requestType: p.requestType || null,
    specialRequestId: p.specialRequestId || p.requestId || null,
    specialRequestStatus,
    eventStatus: status,
    deadline: p.deadline || null,
    attachments: normalizeAttachmentMeta(p.attachments),
    at: toIso(row?.created_at),
    sourceEventId: row?.id ?? null,
  };
}

function parseReplyEvent(row) {
  const p = parseJsonColumn(row?.payload) || {};
  const text =
    p.creatorMessage ||
    p.influencerReply ||
    p.reply ||
    "";
  const note =
    typeof p.note === "string" && p.note.trim()
      ? p.note.trim()
      : typeof text !== "string"
      ? String(text || "")
      : null;
  const status = String(row?.status || "").toLowerCase();
  const specialRequestStatus =
    p.specialRequestStatus ||
    p.status ||
    (p.clarificationType ? "pending_brand" : null) ||
    "pending_brand";
  return {
    key: `special-reply-${row?.id}`,
    source: "special_request",
    direction: "creator_to_brand",
    role: "influencer",
    type: "reply",
    text: typeof text === "string" ? text.trim() : String(text || ""),
    note,
    clarificationType: p.clarificationType || null,
    requestType: p.requestType || null,
    specialRequestId: p.specialRequestId || p.requestId || null,
    specialRequestStatus,
    eventStatus: status,
    at: toIso(row?.created_at),
    sourceEventId: row?.id ?? null,
  };
}

function parseQuoteEntry(entry, idx) {
  const amount =
    entry.amount != null && Number.isFinite(Number(entry.amount))
      ? Number(entry.amount)
      : null;
  return {
    key: `quote-${entry.at || "item"}-${idx}`,
    source: "quote",
    role: entry.role === "influencer" ? "influencer" : "advertiser",
    type: entry.type || (entry.role === "influencer" ? "quote_submitted" : null),
    amount,
    currency: entry.currency || null,
    text:
      typeof entry.reason === "string" && entry.reason.trim()
        ? entry.reason.trim()
        : null,
    at: toIso(entry.at) || null,
    sourceEventId: entry.sourceEventId ?? null,
  };
}

function parseDeliverableEntry(entry, idx) {
  const attachment =
    entry.attachment && typeof entry.attachment === "object"
      ? {
          inboundAttachmentId:
            typeof entry.attachment.inboundAttachmentId === "number" ||
            typeof entry.attachment.inboundAttachmentId === "string"
              ? entry.attachment.inboundAttachmentId
              : null,
          filename: entry.attachment.filename || null,
          contentType: entry.attachment.contentType || null,
        }
      : null;
  return {
    key: `deliverable-${entry.at || "item"}-${idx}`,
    source: "deliverable",
    role:
      entry.role === "system"
        ? "system"
        : entry.role === "influencer"
        ? "influencer"
        : "advertiser",
    kind: entry.kind || "deliverable",
    type: entry.type || null,
    text:
      typeof entry.content === "string" && entry.content.trim()
        ? entry.content.trim()
        : null,
    link: entry.link || null,
    promoCode: entry.promoCode || null,
    attachment,
    at: toIso(entry.at) || null,
    sourceEventId: entry.sourceEventId ?? null,
    emailEventId: entry.emailEventId ?? null,
    emailSummary:
      typeof entry.emailSummary === "object" &&
      entry.emailSummary !== null &&
      (entry.emailSummary.original || entry.emailSummary.zh)
        ? {
            original: entry.emailSummary.original || null,
            zh: entry.emailSummary.zh || null,
          }
        : typeof entry.emailSummary === "string" && entry.emailSummary.trim()
          ? { original: entry.emailSummary.trim(), zh: null }
          : null,
  };
}

/**
 * 寄样条目：红人提供/确认完整寄样地址（last_event.shippingTimeline）。
 * 只用于「待寄送样品」tab 的未读判定与沟通记录展示；
 * 卡片右侧红色数字通过 infl_card_seq 计算，不含这一类。
 */
function parseShippingEntry(entry, idx) {
  return {
    key: `shipping-${entry.at || "item"}-${idx}`,
    source: "shipping",
    role: "influencer",
    kind: "shipping",
    type: entry.type || "provided",
    text: null,
    link: null,
    promoCode: null,
    attachment: null,
    at: toIso(entry.at) || null,
    sourceEventId: entry.sourceEventId ?? null,
    emailEventId: entry.emailEventId ?? null,
  };
}

function normalizeUrlForCompare(raw) {
  return String(raw || "")
    .trim()
    .replace(/[>)\]"'<>]+$/g, "");
}

/** 从原始邮件正文提取常见图片链接（Drive / Google 托管图片 / 常见图片扩展名）。 */
function extractEmailImageLinks(bodyText) {
  const text = String(bodyText || "");
  if (!text.trim()) return [];
  const found = new Set();
  const patterns = [
    /https?:\/\/(?:[\w-]+\.)*drive\.google\.com\/[^\s<>"')\]]+/gi,
    /https?:\/\/(?:[\w-]+\.)*googleusercontent\.com\/[^\s<>"')\]]+/gi,
    /https?:\/\/[^\s<>"')]+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s<>"')]*)?/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const url = normalizeUrlForCompare(m[0]);
      if (url) found.add(url);
    }
  }
  return [...found];
}

/** 给提交过脚本/视频的 deliverable 条目补原邮件上下文（摘要已在落库时写入，图片上下文仅查询拼装）。 */
async function enrichDeliverableItemsWithEmailContext(items) {
  const emailIds = [
    ...new Set(
      (items || [])
        .filter(
          (x) =>
            x?.source === "deliverable" &&
            x?.emailEventId &&
            ["script", "video_draft", "published"].includes(x?.kind)
        )
        .map((x) => Number(x.emailEventId))
        .filter((id) => id > 0)
    ),
  ];
  if (!emailIds.length) return items || [];

  const placeholders = emailIds.map(() => "?").join(",");
  const [eventRows, attMap] = await Promise.all([
    queryTikTok(
      `
      SELECT id, subject, body_text
      FROM tiktok_influencer_email_events
      WHERE id IN (${placeholders})
    `,
      emailIds
    ).catch(() => []),
    listInboundAttachmentsByEmailEventIds(emailIds).catch(() => new Map()),
  ]);

  const eventMap = new Map();
  for (const row of eventRows || []) {
    eventMap.set(Number(row.id), row);
  }

  return (items || []).map((item) => {
    if (item?.source !== "deliverable" || !item.emailEventId) return item;
    const eventId = Number(item.emailEventId);
    const event = eventMap.get(eventId);
    const attachments = attMap.get(eventId) || [];
    const imageLinks = extractEmailImageLinks(event?.body_text || "");
    // 红人邮件附件全类型展示（图片 / 视频 / PDF / Office / 未知二进制），
    // 仅过滤转发邮件本体、退信、S/MIME 签名、winmail.dat 这些系统产物。
    const displayAttachments = selectDisplayableInboundAttachments(attachments);
    if (!imageLinks.length && !displayAttachments.length) return item;
    return {
      ...item,
      emailReferences: {
        imageLinks,
        attachments: displayAttachments.map((a) => ({
          inboundAttachmentId: a.inboundAttachmentId,
          filename: a.filename || null,
          contentType: a.contentType || null,
          sizeBytes: a.sizeBytes ?? null,
        })),
      },
    };
  });
}

async function getExecutionCommunicationRow(campaignId, influencerId) {
  const rows = await queryTikTok(
    `
    SELECT tiktok_username, influencer_id, quote_negotiation, last_event
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
    LIMIT 1
    `,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
  return rows?.[0] || null;
}

function loadAgentEvents({ table, eventType, campaignId, platformId, username }) {
  const params = [
    campaignId,
    eventType,
    platformId || null,
    platformId || null,
    platformId || null,
    username || null,
    username || null,
    platformId || null,
    username || null,
  ];
  return queryTikTok(
    `
    SELECT id, campaign_id, influencer_id, event_type, status, error_message, payload, created_at
    FROM ${table}
    WHERE campaign_id = ?
      AND event_type = ?
      AND status <> 'failed'
      AND (
        (? IS NOT NULL AND TRIM(?) <> '' AND (influencer_id = ? OR influencer_id = ?))
        OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.influencerId')) = ?
        OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.platformInfluencerId')) = ?
        OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.tiktokUsername')) = ?
      )
    ORDER BY created_at ASC, id ASC
    `,
    params
  );
}

/**
 * 单张红人卡片的“沟通记录”结构化事件流。
 * 包含：品牌方/红人特殊请求事件、quote_negotiation 砍价记录、
 * last_event.deliverablesTimeline 交付记录（脚本/视频草稿/修改意见/通过/发布链接）。
 * 不包含原始往来邮件正文与 Bin 聊天会话消息（由卡片各自阶段展示）。
 */
export async function getExecutionCommunicationTimeline({
  campaignId,
  influencerId,
}) {
  const normalizedHandle = String(influencerId || "")
    .trim()
    .replace(/^@/, "");
  if (!campaignId || !normalizedHandle) {
    throw new Error("缺少 campaignId 或 influencerId");
  }

  const row = await getExecutionCommunicationRow(campaignId, normalizedHandle);
  if (!row) {
    return { success: true, items: [], total: 0 };
  }

  const username =
    typeof row.tiktok_username === "string" && row.tiktok_username.trim()
      ? row.tiktok_username.trim()
      : normalizedHandle;
  const platformId =
    typeof row.influencer_id === "string" && row.influencer_id.trim()
      ? row.influencer_id.trim()
      : null;

  const [askRows, replyRows] = await Promise.all([
    loadAgentEvents({
      table: "tiktok_influencer_agent_event",
      eventType: ASK_EVENT_TYPE,
      campaignId,
      platformId,
      username,
    }),
    loadAgentEvents({
      table: "tiktok_advertiser_agent_event",
      eventType: REPLY_EVENT_TYPE,
      campaignId,
      platformId,
      username,
    }),
  ]);

  const quoteNegotiation = normalizeArray(row.quote_negotiation);
  const lastEvent = parseJsonColumn(row.last_event) || {};
  const deliverablesTimeline = normalizeArray(lastEvent.deliverablesTimeline);
  const shippingTimeline = normalizeArray(lastEvent.shippingTimeline);

  const items = [
    ...(askRows || []).map(parseAskEvent),
    ...(replyRows || []).map(parseReplyEvent),
    ...quoteNegotiation.map(parseQuoteEntry),
    ...deliverablesTimeline.map(parseDeliverableEntry),
    ...shippingTimeline.map(parseShippingEntry),
  ];

  const enrichedItems = await enrichDeliverableItemsWithEmailContext(items);

  enrichedItems.sort((a, b) => {
    const diff = toTimeMs(b.at) - toTimeMs(a.at);
    if (diff !== 0) return diff;
    return String(b.key).localeCompare(String(a.key));
  });

  return {
    success: true,
    influencerId: username,
    items: enrichedItems,
    total: enrichedItems.length,
  };
}

/**
 * 一次性统计一组红人的特殊请求事件数，供执行进度卡片折叠态显示条数。
 * 与 getExecutionCommunicationTimeline 使用同一匹配口径（不含 failed）。
 */
export async function loadSpecialRequestCountsByUsername(
  campaignId,
  usernames
) {
  const list = Array.isArray(usernames)
    ? [...new Set(usernames.map((u) => String(u || "").trim()).filter(Boolean))]
    : [];
  if (!campaignId || list.length === 0) return {};
  const marks = list.map(() => "?").join(",");
  const rows = await queryTikTok(
    `
    SELECT
      e.tiktok_username AS username,
      COUNT(DISTINCT askEv.id) + COUNT(DISTINCT replyEv.id) AS cnt
    FROM tiktok_campaign_execution e
    LEFT JOIN tiktok_influencer_agent_event askEv
      ON askEv.campaign_id = e.campaign_id
     AND askEv.event_type = ?
     AND askEv.status <> 'failed'
     AND (
       (e.influencer_id IS NOT NULL AND TRIM(e.influencer_id) <> ''
         AND (askEv.influencer_id = e.influencer_id OR askEv.influencer_id = e.tiktok_username))
       OR JSON_UNQUOTE(JSON_EXTRACT(askEv.payload, '$.influencerId')) = e.tiktok_username
       OR JSON_UNQUOTE(JSON_EXTRACT(askEv.payload, '$.platformInfluencerId')) = e.influencer_id
       OR JSON_UNQUOTE(JSON_EXTRACT(askEv.payload, '$.tiktokUsername')) = e.tiktok_username
     )
    LEFT JOIN tiktok_advertiser_agent_event replyEv
      ON replyEv.campaign_id = e.campaign_id
     AND replyEv.event_type = ?
     AND replyEv.status <> 'failed'
     AND (
       (e.influencer_id IS NOT NULL AND TRIM(e.influencer_id) <> ''
         AND (replyEv.influencer_id = e.influencer_id OR replyEv.influencer_id = e.tiktok_username))
       OR JSON_UNQUOTE(JSON_EXTRACT(replyEv.payload, '$.tiktokUsername')) = e.tiktok_username
       OR JSON_UNQUOTE(JSON_EXTRACT(replyEv.payload, '$.influencerId')) = e.tiktok_username
       OR JSON_UNQUOTE(JSON_EXTRACT(replyEv.payload, '$.influencerId')) = e.influencer_id
       OR JSON_UNQUOTE(JSON_EXTRACT(replyEv.payload, '$.platformInfluencerId')) = e.influencer_id
     )
    WHERE e.campaign_id = ?
      AND e.tiktok_username IN (${marks})
    GROUP BY e.tiktok_username
    `,
    [ASK_EVENT_TYPE, REPLY_EVENT_TYPE, campaignId, ...list]
  );
  const map = {};
  for (const r of rows || []) {
    if (r?.username) map[String(r.username)] = Number(r.cnt || 0);
  }
  return map;
}
