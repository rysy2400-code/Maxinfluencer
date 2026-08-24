#!/usr/bin/env node
/**
 * 手动修复 Seko × @AIMinds46 最新还价回复（2026-08-19 inbound）。
 *
 * 背景：
 * - 邮件事件 tiktok_influencer_email_events.id=3272840 在 LLM 决策阶段失败
 *   （DeepSeek 返回空 content，llm-client 兜底为「抱歉，我暂时无法回复。」，
 *   JSON.parse 报错），导致红人 "$1,200 USD" 的新报价未写入 quote_negotiation，
 *   广告主聊天框也没有生成特殊请求。
 * - 邮件正文已由 poll-influencer-replies 写入 conversation timeline
 *   （tiktok_influencer_conversation_messages.id=3160242，campaign_id 为 NULL），
 *   缺的是报价记录与品牌侧通知。
 *
 * 修复方式（复用正式 pipeline，不直接改 execution 表）：
 * 1. 入队 execution_update_suggested：newStage=quote_submitted、flatFeeUSD=1200
 *    （quote_negotiation 追加红人最新报价，flat_fee 同步为 1200，stage 保持 quote_submitted）
 * 2. 入队 creator_replied_special_request：pending_brand，
 *    在广告主聊天框追加 1 条「特殊请求 · 待您决策」，传达红人报价。
 * 3. 原邮件事件标记为 skipped（注明已人工修复），避免重复进入 LLM 流程。
 *
 * 执行：
 *   node scripts/repair-seko-aiminds46-counter.mjs
 *   node scripts/process-campaign-agent-events.js
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const CAMPAIGN_ID = "CAMP-1786094962956-CQDQ4FHHG";
const INFLUENCER_ID = "UC05TAFT-somQ0esV1x6rUgQ";
const TIKTOK_USERNAME = "AIMinds46";
const EMAIL_EVENT_ID = 3272840;
const RECEIVED_AT = "2026-08-19T15:23:24.000Z";
const FLAT_FEE_USD = 1200;

const NOTE_UPDATE =
  "红人回应品牌方 $1,000 还价：愿意以 $1,200 USD 折扣价承接 1 条 Seko 专属 " +
  "YouTube 视频（红人常规价更高，考虑 Seko 长线合作给出折扣）。" +
  "已将报价同步品牌方，等待品牌确认后再推进。" +
  `（修复自邮件事件 ${EMAIL_EVENT_ID}）`;

const CREATOR_MESSAGE =
  "I can offer a discounted rate of $1,200 USD for this collaboration. " +
  "My usual rate for a dedicated video is higher, but I'm happy to offer this " +
  "discount considering the potential for a longer-term collaboration with Seko. " +
  "Let me know if that works for the team, and we can move forward.";

const NOTE_SPECIAL_REQUEST =
  "红人回应品牌方 $1,000 还价并提出 $1,200 USD 折扣报价（Seko 专属 YouTube 视频，" +
  "考虑长线合作）；等待品牌方决定是否接受或继续协商。" +
  `（修复自邮件事件 ${EMAIL_EVENT_ID}）`;

async function loadEmailEvent(eventId) {
  const rows = await queryTikTok(
    `SELECT id, influencer_id, message_id, from_email, to_email, subject, body_text, received_at
       FROM tiktok_influencer_email_events WHERE id = ?`,
    [eventId]
  );
  return rows?.[0] || null;
}

async function alreadyRepaired() {
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n
       FROM tiktok_advertiser_agent_event
      WHERE campaign_id = ?
        AND influencer_id = ?
        AND JSON_SEARCH(payload, 'one', ?) IS NOT NULL`,
    [CAMPAIGN_ID, INFLUENCER_ID, String(EMAIL_EVENT_ID)]
  );
  return Number(rows?.[0]?.n || 0) > 0;
}

async function enqueueEvent({ eventType, payload }) {
  const r = await queryTikTok(
    `INSERT INTO tiktok_advertiser_agent_event (
       campaign_id, influencer_id, event_type, payload, status
     ) VALUES (?, ?, ?, ?, 'pending')`,
    [CAMPAIGN_ID, INFLUENCER_ID, eventType, JSON.stringify(payload)]
  );
  return r?.insertId || null;
}

async function main() {
  if (await alreadyRepaired()) {
    console.log("[Repair] 已存在同源修复事件，跳过（幂等）。");
    return;
  }

  const emailEvent = await loadEmailEvent(EMAIL_EVENT_ID);
  if (!emailEvent) {
    throw new Error(`邮件事件不存在：${EMAIL_EVENT_ID}`);
  }

  const emailPayload = {
    id: emailEvent.id,
    messageId: emailEvent.message_id,
    subject: emailEvent.subject || "",
    fromEmail: emailEvent.from_email,
    toEmail: emailEvent.to_email,
    bodyText: emailEvent.body_text || "",
  };
  const common = {
    campaignId: CAMPAIGN_ID,
    influencerId: INFLUENCER_ID,
    tiktokUsername: TIKTOK_USERNAME,
    source: "manual_repair",
    sourceEventId: EMAIL_EVENT_ID,
    sourceMessageId: emailEvent.message_id,
    createdAt: new Date().toISOString(),
  };

  const updateEventId = await enqueueEvent({
    eventType: "execution_update_suggested",
    payload: {
      ...common,
      type: "execution_update_suggested",
      newStage: "quote_submitted",
      flatFeeUSD: FLAT_FEE_USD,
      currency: "USD",
      quoteAt: RECEIVED_AT,
      note: NOTE_UPDATE,
      emailEvent: emailPayload,
    },
  });
  console.log(`[Repair] 已入队 execution_update_suggested: ${updateEventId}`);

  const specialEventId = await enqueueEvent({
    eventType: "creator_replied_special_request",
    payload: {
      ...common,
      type: "creator_replied_special_request",
      specialRequestId: null,
      specialRequestStatus: "pending_brand",
      creatorMessage: CREATOR_MESSAGE,
      note: NOTE_SPECIAL_REQUEST,
    },
  });
  console.log(`[Repair] 已入队 creator_replied_special_request: ${specialEventId}`);

  await queryTikTok(
    `UPDATE tiktok_influencer_email_events
        SET status = 'skipped',
            error_message = ?,
            updated_at = NOW()
      WHERE id = ?`,
    [
      "已人工修复：LLM 决策 JSON 解析失败后，手动入队 execution_update_suggested / creator_replied_special_request 并落库。",
      EMAIL_EVENT_ID,
    ]
  );
  console.log(`[Repair] 邮件事件 ${EMAIL_EVENT_ID} 已标记为 skipped。`);
  console.log("[Repair] 下一步运行 node scripts/process-campaign-agent-events.js 落库。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Repair] 运行出错:", err);
    process.exit(1);
  });
