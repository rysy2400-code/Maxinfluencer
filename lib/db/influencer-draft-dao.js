import { logConversationMessage } from "./influencer-conversation-dao.js";
import { queryTikTok } from "./mysql-tiktok.js";

function sanitizeMessageIdPart(value, fallback = "unknown", maxLength = 64) {
  const s = value == null ? "" : String(value).trim();
  return (s || fallback).replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, maxLength);
}

export function buildDraftMessageId({
  sourceEventTable = null,
  sourceEventId = null,
  sourceType = null,
  triggerType = null,
  traceId = null,
}) {
  const source = sanitizeMessageIdPart(sourceEventTable || sourceType || "draft", "draft", 64);
  const event = sanitizeMessageIdPart(sourceEventId || traceId || "manual", "manual", 72);
  const trigger = sanitizeMessageIdPart(triggerType || sourceType || "outbound", "outbound", 64);
  return `draft:${source}:${event}:${trigger}`;
}

export async function logDraftOutboundMessage({
  influencerId,
  campaignId = null,
  fromEmail = null,
  toEmail = null,
  subject = null,
  bodyText,
  sourceType,
  sourceEventTable = null,
  sourceEventId = null,
  triggerType = null,
  traceId = null,
  payload = {},
}) {
  const messageId = buildDraftMessageId({
    sourceEventTable,
    sourceEventId,
    sourceType,
    triggerType,
    traceId,
  });
  const now = new Date();

  await logConversationMessage({
    influencerId,
    campaignId,
    direction: "bin",
    channel: "email",
    fromEmail,
    toEmail,
    subject,
    bodyText,
    messageId,
    sourceType,
    sourceEventTable,
    sourceEventId,
    sentAt: null,
    eventType: "draft_outbound",
    eventTime: now,
    actorType: "agent",
    sendMode: "human_review_required",
    contentOrigin: "agent_generated",
    traceId,
    payload: {
      kind: "draft_outbound",
      status: "drafted",
      ...(payload || {}),
      draft: {
        status: "pending",
        triggerType: triggerType || sourceType || "outbound",
        sourceEventTable,
        sourceEventId,
        generatedAt: now.toISOString(),
        handoverMode: "assist",
        ...(payload?.draft || {}),
      },
      email: {
        to: toEmail,
        subject,
        inReplyTo: payload?.email?.inReplyTo || null,
        messageId: null,
        ...(payload?.email || {}),
      },
    },
  });

  return { messageId };
}

export async function markDraftOutboundSent({
  draftEventId,
  sentMessageId = null,
  sentAt = new Date(),
}) {
  if (!draftEventId) return false;
  const sentIso =
    sentAt instanceof Date ? sentAt.toISOString() : new Date(sentAt).toISOString();
  const rows = await queryTikTok(
    `
    UPDATE tiktok_influencer_conversation_messages
    SET
      payload = JSON_SET(
        COALESCE(payload, JSON_OBJECT()),
        '$.status', 'approved_sent',
        '$.draft.status', 'approved_sent',
        '$.draft.sentAt', ?,
        '$.draft.sentMessageId', ?
      )
    WHERE id = ? AND event_type = 'draft_outbound'
  `,
    [sentIso, sentMessageId || null, draftEventId]
  );
  return Number(rows?.affectedRows || 0) > 0;
}
