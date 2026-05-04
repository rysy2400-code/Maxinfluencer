import { queryTikTok } from "./mysql-tiktok.js";
import { encodeCursor, decodeCursor } from "../utils/cursor.js";
import {
  parseTimelinePayload,
  toSafeTimelinePayload,
} from "../utils/timeline-payload-safe.js";

const SORT_EXPR = "COALESCE(event_time, sent_at, created_at)";

function normalizeLimit(limit, defaultValue = 30, maxValue = 100) {
  const n = Number(limit || defaultValue);
  if (Number.isNaN(n)) return defaultValue;
  return Math.max(1, Math.min(maxValue, Math.floor(n)));
}

function normalizeEventTypes(eventTypes) {
  if (!eventTypes) return [];
  if (Array.isArray(eventTypes)) return eventTypes.filter(Boolean);
  return String(eventTypes)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function listTimelineEvents({
  influencerId,
  cursor = null,
  limit = 30,
  campaignId = null,
  eventTypes = null,
  debug = false,
}) {
  const pageSize = normalizeLimit(limit);
  const decodedCursor = decodeCursor(cursor);
  const normalizedEventTypes = normalizeEventTypes(eventTypes);

  const where = ["influencer_id = ?"];
  const params = [influencerId];

  if (campaignId) {
    where.push("campaign_id = ?");
    params.push(campaignId);
  }

  if (normalizedEventTypes.length > 0) {
    const placeholders = normalizedEventTypes.map(() => "?").join(", ");
    where.push(`event_type IN (${placeholders})`);
    params.push(...normalizedEventTypes);
  }

  if (decodedCursor) {
    where.push(`(${SORT_EXPR} < ? OR (${SORT_EXPR} = ? AND id < ?))`);
    params.push(decodedCursor.sortTime, decodedCursor.sortTime, decodedCursor.id);
  }

  const rows = await queryTikTok(
    `
      SELECT
        id,
        influencer_id,
        campaign_id,
        direction,
        channel,
        from_email,
        to_email,
        subject,
        body_text,
        message_id,
        source_type,
        source_event_table,
        source_event_id,
        event_type,
        event_time,
        actor_type,
        actor_id,
        send_mode,
        content_origin,
        trace_id,
        payload,
        sent_at,
        created_at,
        ${SORT_EXPR} AS sort_time
      FROM tiktok_influencer_conversation_messages
      WHERE ${where.join(" AND ")}
      ORDER BY sort_time DESC, id DESC
      LIMIT ${pageSize + 1}
    `,
    params
  );

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  const items = pageRows.map((r) => {
    const payloadRaw = parseTimelinePayload(r.payload);
    const item = {
      id: r.id,
      influencerId: r.influencer_id,
      campaignId: r.campaign_id,
      eventType: r.event_type,
      actorType: r.actor_type,
      actorId: r.actor_id,
      eventTime: r.event_time || r.sent_at || r.created_at,
      direction: r.direction,
      channel: r.channel,
      fromEmail: r.from_email,
      toEmail: r.to_email,
      subject: r.subject,
      bodyText: r.body_text,
      messageId: r.message_id,
      sourceType: r.source_type,
      sourceEventTable: r.source_event_table,
      sourceEventId: r.source_event_id,
      sendMode: r.send_mode,
      contentOrigin: r.content_origin,
      traceId: r.trace_id,
      payloadSafe: toSafeTimelinePayload(payloadRaw),
    };
    if (debug) {
      item.payload = payloadRaw;
    }
    return item;
  });

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore
    ? encodeCursor({
        sortTime: lastRow.sort_time,
        id: lastRow.id,
      })
    : null;

  return {
    items,
    hasMore,
    nextCursor,
  };
}

function parseJsonOrObject(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function nonEmptyStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s === "未知" || /^unknown$/i.test(s)) return null;
  return s;
}

/** product_info JSON 字段名在历史上不完全一致，做多键兼容 */
function pickBrandProductFromSnapshot(pi) {
  if (!pi || typeof pi !== "object") return { brandName: null, productName: null };
  const brand =
    nonEmptyStr(pi.brand) ??
    nonEmptyStr(pi.brandName) ??
    nonEmptyStr(pi.brand_name);
  const product =
    nonEmptyStr(pi.product) ??
    nonEmptyStr(pi.productName) ??
    nonEmptyStr(pi.product_name);
  return { brandName: brand, productName: product };
}

export async function listActiveCampaignCards({ influencerId, limit = 100 }) {
  const pageSize = normalizeLimit(limit, 50, 200);
  const rows = await queryTikTok(
    `
      SELECT
        e.campaign_id,
        e.stage,
        e.flat_fee,
        c.product_info
      FROM tiktok_campaign_execution e
      JOIN tiktok_campaign c ON c.id = e.campaign_id
      WHERE e.influencer_id = ?
      ORDER BY e.updated_at DESC
      LIMIT ${pageSize}
    `,
    [influencerId]
  );

  return (rows || []).map((r) => {
    const productInfo = parseJsonOrObject(r.product_info) || {};
    const { brandName, productName } = pickBrandProductFromSnapshot(productInfo);
    return {
      campaignId: r.campaign_id,
      brandName,
      productName,
      stage: r.stage || null,
      price: r.flat_fee == null ? null : Number(r.flat_fee),
    };
  });
}

