import { queryTikTok } from "./mysql-tiktok.js";

function toMysqlTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace("T", " ");
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * 记录一条红人对话消息（Bin 或红人一方）
 *
 * @param {Object} opts
 * @param {string|null} opts.influencerId - tiktok_influencer.influencer_id
 * @param {string|null} opts.campaignId - tiktok_campaign.id
 * @param {'bin'|'influencer'} opts.direction - 消息方向
 * @param {'email'} [opts.channel='email'] - 渠道，目前仅支持 email
 * @param {string|null} opts.fromEmail
 * @param {string|null} opts.toEmail
 * @param {string|null} opts.subject
 * @param {string} opts.bodyText - 已清洗后的正文
 * @param {string|null} opts.messageId
 * @param {string} opts.sourceType - seed_outreach / influencer_email_event / influencer_agent_event / llm_outbound 等
 * @param {string|null} opts.sourceEventTable - 来源事件表名
 * @param {number|null} opts.sourceEventId - 来源事件表主键 ID
 * @param {Date|string|null} opts.sentAt - 业务时间（发送/接收时间）
 */
export async function logConversationMessage(opts = {}) {
  const {
    influencerId = null,
    campaignId = null,
    direction,
    channel = "email",
    fromEmail = null,
    toEmail = null,
    subject = null,
    bodyText,
    messageId = null,
    sourceType,
    sourceEventTable = null,
    sourceEventId = null,
    sentAt = null,
    eventType = null,
    eventTime = null,
    actorType = null,
    actorId = null,
    sendMode = null,
    contentOrigin = null,
    traceId = null,
    payload = null,
  } = opts;

  if (!direction || !["bin", "influencer"].includes(direction)) {
    console.warn(
      "[InfluencerConversationDAO] logConversationMessage 缺少或非法 direction：",
      direction
    );
    return;
  }

  if (!bodyText) {
    console.warn(
      "[InfluencerConversationDAO] logConversationMessage 缺少 bodyText，已忽略。"
    );
    return;
  }

  if (!sourceType) {
    console.warn(
      "[InfluencerConversationDAO] logConversationMessage 缺少 sourceType，已忽略。"
    );
    return;
  }

  const sentAtTs = toMysqlTimestamp(sentAt);
  const eventTimeTs = toMysqlTimestamp(eventTime || sentAt || new Date());
  const inferredEventType =
    eventType || (direction === "influencer" ? "email_inbound" : "email_outbound");
  const inferredActorType =
    actorType ||
    (sourceType === "influencer_email_event"
      ? "system"
      : sourceType && sourceType.includes("human")
      ? "human"
      : "agent");
  const payloadJson = payload ? JSON.stringify(payload) : null;

  await queryTikTok(
    `
    INSERT INTO tiktok_influencer_conversation_messages (
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
      sent_at,
      event_type,
      event_time,
      actor_type,
      actor_id,
      send_mode,
      content_origin,
      trace_id,
      payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      campaign_id = COALESCE(VALUES(campaign_id), campaign_id),
      subject = COALESCE(VALUES(subject), subject),
      body_text = COALESCE(VALUES(body_text), body_text),
      source_type = COALESCE(VALUES(source_type), source_type),
      source_event_table = COALESCE(VALUES(source_event_table), source_event_table),
      source_event_id = COALESCE(VALUES(source_event_id), source_event_id),
      sent_at = COALESCE(VALUES(sent_at), sent_at),
      event_type = COALESCE(VALUES(event_type), event_type),
      event_time = COALESCE(VALUES(event_time), event_time),
      actor_type = COALESCE(VALUES(actor_type), actor_type),
      actor_id = COALESCE(VALUES(actor_id), actor_id),
      send_mode = COALESCE(VALUES(send_mode), send_mode),
      content_origin = COALESCE(VALUES(content_origin), content_origin),
      trace_id = COALESCE(VALUES(trace_id), trace_id),
      payload = COALESCE(VALUES(payload), payload)
  `,
    [
      influencerId,
      campaignId,
      direction,
      channel,
      fromEmail,
      toEmail,
      subject,
      bodyText,
      messageId,
      sourceType,
      sourceEventTable,
      sourceEventId,
      sentAtTs,
      inferredEventType,
      eventTimeTs,
      inferredActorType,
      actorId,
      sendMode,
      contentOrigin,
      traceId,
      payloadJson,
    ]
  );
}

