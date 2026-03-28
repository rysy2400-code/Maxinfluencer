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
      sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    ]
  );
}

