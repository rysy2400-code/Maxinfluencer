import { queryTikTok } from "./mysql-tiktok.js";
import {
  isBounceEmail,
  normalizeEmailAddress,
  normalizeMessageId,
} from "../email/email-delivery-classification.js";

export function mysqlTime(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  }
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function payloadObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

export async function recordOutreachFact(message) {
  const campaignId = String(message.campaignId || "").trim();
  const influencerId = String(message.influencerId || "").trim();
  const messageId = normalizeMessageId(message.messageId);
  const senderEmail = normalizeEmailAddress(message.fromEmail);
  const senderDomain = senderEmail.split("@")[1] || "";
  const sentAt = mysqlTime(message.sentAt || message.eventTime);
  if (!campaignId || !influencerId || !messageId || !senderEmail || !senderDomain || !sentAt) return false;

  await queryTikTok(
    `INSERT INTO email_outreach_delivery_fact (
       campaign_id, influencer_id, outreach_message_id, sender_email,
       sender_domain, recipient_email, sent_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       recipient_email = COALESCE(VALUES(recipient_email), recipient_email),
       sent_at = LEAST(sent_at, VALUES(sent_at))`,
    [campaignId, influencerId, messageId, senderEmail, senderDomain,
      normalizeEmailAddress(message.toEmail) || null, sentAt]
  );
  return true;
}

async function findAttributableFact(message) {
  const payload = payloadObject(message.payload);
  const receivedAt = mysqlTime(message.sentAt || message.eventTime);
  const inReplyTo = normalizeMessageId(
    message.inReplyTo || payload?.email?.inReplyTo || payload?.email?.in_reply_to
  );
  if (inReplyTo) {
    const exact = await queryTikTok(
      `SELECT id FROM email_outreach_delivery_fact
       WHERE outreach_message_id = ? AND sent_at <= ?
       LIMIT 1`,
      [inReplyTo, receivedAt]
    );
    if (exact?.[0]) return { factId: exact[0].id, method: "in_reply_to", confidence: "exact" };
  }

  const influencerId = String(message.influencerId || "").trim();
  const campaignId = String(message.campaignId || "").trim();
  if (influencerId && campaignId && receivedAt) {
    const candidates = await queryTikTok(
      `SELECT id FROM email_outreach_delivery_fact
       WHERE influencer_id = ? AND campaign_id = ? AND sent_at <= ?
       ORDER BY sent_at DESC LIMIT 2`,
      [influencerId, campaignId, receivedAt]
    );
    if (candidates?.length === 1) {
      return { factId: candidates[0].id, method: "campaign_influencer", confidence: "high" };
    }
  }
  return null;
}

export async function recordInboundAttribution(message) {
  const inboundMessageId = normalizeMessageId(message.messageId);
  const receivedAt = mysqlTime(message.sentAt || message.eventTime);
  if (!inboundMessageId || !receivedAt) return false;

  const payload = payloadObject(message.payload);
  const bounce = isBounceEmail({
    fromEmail: message.fromEmail,
    subject: message.subject,
    bodyText: message.bodyText,
    rawHeaders: payload?.email?.rawHeaders,
  });
  const match = await findAttributableFact(message);
  const recipientEmail = normalizeEmailAddress(message.toEmail) || null;

  await queryTikTok(
    `INSERT INTO email_inbound_attribution_audit (
       inbound_message_id, recipient_email, sender_email, received_at,
       inbound_type, attribution_status, outreach_fact_id, match_method
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       recipient_email = VALUES(recipient_email),
       sender_email = VALUES(sender_email),
       received_at = VALUES(received_at),
       inbound_type = VALUES(inbound_type),
       attribution_status = VALUES(attribution_status),
       outreach_fact_id = VALUES(outreach_fact_id),
       match_method = VALUES(match_method)`,
    [inboundMessageId, recipientEmail, normalizeEmailAddress(message.fromEmail) || null,
      receivedAt, bounce ? "bounce" : "reply", match ? "matched" : "unattributed",
      match?.factId || null, match?.method || null]
  );

  if (!match) return false;
  const assignment = bounce
    ? `bounce_message_id = COALESCE(bounce_message_id, ?), bounce_at = LEAST(COALESCE(bounce_at, ?), ?)`
    : `first_reply_message_id = COALESCE(first_reply_message_id, ?), first_reply_at = LEAST(COALESCE(first_reply_at, ?), ?)`;
  await queryTikTok(
    `UPDATE email_outreach_delivery_fact SET ${assignment},
       match_method = ?, match_confidence = ? WHERE id = ?`,
    [inboundMessageId, receivedAt, receivedAt, match.method, match.confidence, match.factId]
  );
  return true;
}

export async function syncEmailDeliveryFactForConversation(message) {
  if (message.direction === "bin" && message.sourceType === "seed_outreach") {
    return recordOutreachFact(message);
  }
  if (message.direction === "influencer" && (message.eventType === "email_inbound" || message.sourceType === "influencer_email_event")) {
    return recordInboundAttribution(message);
  }
  return false;
}
