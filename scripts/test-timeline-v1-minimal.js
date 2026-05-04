/**
 * 最小稳定验收：验证 conversation 时间线 v1 写入/去重/排序
 * - 不依赖 IMAP / SMTP / LLM
 *
 * 使用方式：
 *   node scripts/test-timeline-v1-minimal.js [influencerId]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { logConversationMessage } from "../lib/db/influencer-conversation-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const influencerId = process.argv[2] || "test_rysy_1";
  const traceId = `trace-test-timeline-v1-${Date.now().toString(36)}`;
  const messageId = `<test-timeline-v1-${Date.now()}@binfluencer.test>`;

  console.log("========== timeline v1 minimal test ==========");
  console.log("influencerId:", influencerId);
  console.log("traceId:", traceId);
  console.log("messageId:", messageId);

  // 1) 模拟写入一条 inbound（使用 DAO，确保 ON DUPLICATE 生效）
  await logConversationMessage({
    influencerId,
    campaignId: null,
    direction: "influencer",
    channel: "email",
    fromEmail: "creator@example.com",
    toEmail: "annie@binfluencer.online",
    subject: "Re: Test",
    bodyText: "I can do $200 per video. Sounds good.",
    messageId,
    sourceType: "influencer_email_event",
    sourceEventTable: "tiktok_influencer_email_events",
    sourceEventId: null,
    sentAt: new Date(),
    eventType: "email_inbound",
    eventTime: new Date(),
    actorType: "system",
    traceId,
    payload: {
      test: true,
      kind: "minimal_inbound",
      createdAt: nowIso(),
    },
  });

  // 2) 再写入同一条 inbound（验证去重：不应新增行）
  await logConversationMessage({
    influencerId,
    campaignId: null,
    direction: "influencer",
    channel: "email",
    fromEmail: "creator@example.com",
    toEmail: "annie@binfluencer.online",
    subject: "Re: Test (duplicate)",
    bodyText: "I can do $200 per video. Sounds good. (dup)",
    messageId,
    sourceType: "influencer_email_event",
    sourceEventTable: "tiktok_influencer_email_events",
    sourceEventId: null,
    sentAt: new Date(),
    eventType: "email_inbound",
    eventTime: new Date(),
    actorType: "system",
    traceId,
    payload: {
      test: true,
      kind: "minimal_inbound_dup",
      createdAt: nowIso(),
    },
  });

  // 3) 写入一条 agent_action（同 traceId，验证多事件与排序字段）
  await logConversationMessage({
    influencerId,
    campaignId: null,
    direction: "bin",
    channel: "email",
    fromEmail: "system@binfluencer.online",
    toEmail: "creator@example.com",
    subject: null,
    bodyText: "[agent_action] wrote advertiser_agent_event: price_pending_approval",
    messageId: `action:${messageId}:write_adv_event`,
    sourceType: "influencer_agent_event",
    sourceEventTable: "tiktok_advertiser_agent_event",
    sourceEventId: null,
    sentAt: new Date(),
    eventType: "agent_action",
    eventTime: new Date(Date.now() + 1000),
    actorType: "agent",
    traceId,
    payload: {
      actionName: "write_advertiser_agent_event",
      createdAt: nowIso(),
    },
  });

  const rows = await queryTikTok(
    `
      SELECT id, influencer_id, message_id, event_type, actor_type, event_time, created_at
      FROM tiktok_influencer_conversation_messages
      WHERE influencer_id = ? AND trace_id = ?
      ORDER BY COALESCE(event_time, sent_at, created_at) ASC
    `,
    [influencerId, traceId]
  );

  const cnt = await queryTikTok(
    `
      SELECT COUNT(*) AS cnt
      FROM tiktok_influencer_conversation_messages
      WHERE influencer_id = ? AND message_id = ?
    `,
    [influencerId, messageId]
  );

  console.log("\n--- Assertions ---");
  console.log("dedupe (inbound count should be 1):", cnt?.[0]?.cnt);
  console.log("events (should include email_inbound + agent_action):");
  console.log(JSON.stringify(rows, null, 2));

  console.log("\n========== done ==========");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[test-timeline-v1-minimal] failed:", err?.message || err);
    process.exit(1);
  });

