/**
 * 完整测试：正常执行 + 特殊请求流程
 * 覆盖：品牌端聊天框、Agent 系统、给红人发的邮件
 *
 * 使用方式：node scripts/test-full-flow.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "../lib/db/campaign-execution-keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TEST_INFLUENCER_ID = "test_rysy_1";

function runScript(name) {
  console.log(`\n>>> 执行: node scripts/${name}`);
  const r = spawnSync("node", [`scripts/${name}`], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (r.status !== 0) {
    throw new Error(`${name} 退出码 ${r.status}`);
  }
}

async function main() {
  console.log("========== 完整流程测试 ==========\n");

  // 检查会话表是否存在
  const tables = await queryTikTok(
    "SHOW TABLES LIKE 'tiktok_campaign_sessions'",
    []
  );
  if (!tables?.length) {
    const alt = await queryTikTok("SHOW TABLES LIKE 'campaign_sessions'", []);
    console.log("  会话表: tiktok_campaign_sessions 不存在" + (alt?.length ? "，存在 campaign_sessions（当前 DAO 使用 tiktok_campaign_sessions）" : ""));
  } else {
    console.log("  会话表: tiktok_campaign_sessions 存在 ✓\n");
  }

  const campaigns = await queryTikTok(
    `SELECT id, session_id FROM tiktok_campaign ORDER BY created_at DESC LIMIT 1`,
    []
  );
  const campaignId = campaigns?.[0]?.id || null;
  let sessionId = campaigns?.[0]?.session_id || null;

  if (!campaignId) {
    console.error("未找到 campaign，请先运行 seed 脚本。");
    process.exit(1);
  }

  // 若 campaign 有 session_id 但 tiktok_campaign_sessions 中无该会话，则插入一条空会话以便追加 Bin 消息
  if (sessionId) {
    const sess = await queryTikTok(
      "SELECT id FROM tiktok_campaign_sessions WHERE id = ? LIMIT 1",
      [sessionId]
    );
    if (!sess?.length) {
      await queryTikTok(
        `INSERT INTO tiktok_campaign_sessions (id, title, status, messages, context, created_at, updated_at)
         VALUES (?, ?, 'published', '[]', '{}', NOW(), NOW())`,
        [sessionId, `Campaign ${campaignId}`]
      );
      console.log("  已为 session_id 创建空会话:", sessionId, "\n");
    }
  }

  const inf = await queryTikTok(
    `SELECT influencer_id FROM tiktok_influencer WHERE influencer_id = ? LIMIT 1`,
    [TEST_INFLUENCER_ID]
  );
  if (!inf?.length) {
    console.error("未找到测试红人 test_rysy_1，请先运行 node scripts/seed-test-influencer-rysy-email.js");
    process.exit(1);
  }

  const specialRequestId = `SR-TEST-${Date.now().toString(36)}`;

  // Step 1: 插入特殊请求事件
  console.log("\n--- Step 1: 插入 ask_influencer_special_request ---");
  await queryTikTok(
    `
    INSERT INTO tiktok_influencer_agent_event (influencer_id, campaign_id, event_type, payload, status)
    VALUES (?, ?, 'ask_influencer_special_request', ?, 'pending')
  `,
    [
      TEST_INFLUENCER_ID,
      campaignId,
      JSON.stringify({
        campaignId,
        influencerId: TEST_INFLUENCER_ID,
        specialRequestId,
        specialRequestStatus: "pending_creator",
        requestDirection: "brand_to_creator",
        brandMessage:
          "品牌方希望看看红人是否愿意 300 刀 2 条视频 + 200 刀再 1 条，并把发布时间从 3 月 15 日改到 3 月 20 日。",
      }),
    ]
  );
  console.log("  已插入，specialRequestId:", specialRequestId);

  // Step 2: InfluencerAgent 消费 → 发邮件给红人
  console.log("\n--- Step 2: InfluencerAgent 发特殊请求邮件给红人 ---");
  runScript("process-influencer-agent-events.js");

  // 验证：对话历史应有 ask_influencer_special_request
  const conv1 = await queryTikTok(
    `SELECT id, source_type, LEFT(body_text, 60) as preview FROM tiktok_influencer_conversation_messages
     WHERE influencer_id = ? AND source_type = 'ask_influencer_special_request' ORDER BY id DESC LIMIT 1`,
    [TEST_INFLUENCER_ID]
  );
  console.log("  对话历史验证:", conv1?.length ? "✓ 已写入" : "✗ 未找到");

  // Step 3: 模拟红人回复（插入一条 email event，避免依赖真实收件）
  console.log("\n--- Step 3: 模拟红人同意回复 ---");
  const simMessageId = `<test-simulated-${Date.now()}@binfluencer.test>`;
  await queryTikTok(
    `
    INSERT IGNORE INTO tiktok_influencer_email_events
    (influencer_id, message_id, from_email, to_email, subject, body_text, status)
    VALUES (?, ?, 'rysy2400@gmail.com', 'annie@binfluencer.online', 'Re: Binfluencer x Rysy Test | Social Media Collaboration',
            'I agree to 300 for 2 + 200 for 1 more, and will post on March 20.', 'pending')
  `,
    [TEST_INFLUENCER_ID, simMessageId]
  );
  console.log("  已插入模拟回复，message_id:", simMessageId);

  // 写入对话表（与 poll 行为一致）
  const evIdRows = await queryTikTok(
    "SELECT id FROM tiktok_influencer_email_events WHERE message_id = ? LIMIT 1",
    [simMessageId]
  );
  const evId = evIdRows?.[0]?.id || null;
  await queryTikTok(
    `
    INSERT INTO tiktok_influencer_conversation_messages
    (influencer_id, campaign_id, direction, channel, from_email, to_email, subject, body_text, message_id, source_type, source_event_table, source_event_id, event_type, event_time, actor_type, trace_id, payload)
    VALUES (?, ?, 'influencer', 'email', 'rysy2400@gmail.com', 'annie@binfluencer.online',
            'Re: Binfluencer x Rysy Test | Social Media Collaboration',
            'I agree to 300 for 2 + 200 for 1 more, and will post on March 20.',
            ?, 'influencer_email_event', 'tiktok_influencer_email_events', ?, 'email_inbound', NOW(), 'system', ?, ?)
  `,
    [
      TEST_INFLUENCER_ID,
      campaignId,
      simMessageId,
      evId,
      `trace:${simMessageId}`,
      JSON.stringify({
        kind: "email_inbound",
        status: "succeeded",
        email: { messageId: simMessageId },
        test: true,
      }),
    ]
  );

  // Step 4: 处理红人邮件事件 → 产出 creator_replied_special_request
  console.log("\n--- Step 4: 处理红人邮件，产出 creator_replied_special_request ---");
  runScript("process-influencer-email-events.js");

  const evt = await queryTikTok(
    `SELECT id, event_type, payload FROM tiktok_advertiser_agent_event
     WHERE event_type = 'creator_replied_special_request' ORDER BY id DESC LIMIT 1`,
    []
  );
  console.log("  tiktok_advertiser_agent_event 验证:", evt?.length ? "✓ 已写入" : "✗ 未找到");
  if (evt?.[0]?.payload) {
    const p = typeof evt[0].payload === "string" ? JSON.parse(evt[0].payload) : evt[0].payload;
    console.log("    specialRequestStatus:", p?.specialRequestStatus);
    console.log("    creatorMessage:", (p?.creatorMessage || "").slice(0, 50) + "...");
  }

  // Step 5: CampaignExecutionAgent 消费 → 更新执行表 + 追加 Bin 消息到 session
  console.log("\n--- Step 5: CampaignExecutionAgent 更新执行表并通知品牌 ---");
  runScript("process-campaign-agent-events.js");

  // 验证：执行表 last_event
  const exec = await queryTikTok(
    `SELECT last_event FROM tiktok_campaign_execution WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}`,
    [campaignId, ...paramsExecutionCreatorMatch(TEST_INFLUENCER_ID)]
  );
  const lastEvent = exec?.[0]?.last_event;
  const le = typeof lastEvent === "string" ? JSON.parse(lastEvent || "{}") : lastEvent || {};
  const hasResolved = !!le?.specialRequestResolved;
  console.log("  执行表 last_event 验证:", hasResolved ? "✓ 含 specialRequestResolved" : "✗ 未找到");

  // 验证：session 中是否有 Bin 消息
  if (sessionId) {
    try {
      const sess = await queryTikTok(
        `SELECT messages FROM tiktok_campaign_sessions WHERE id = ?`,
        [sessionId]
      );
      const msgs = sess?.[0]?.messages;
      const arr = typeof msgs === "string" ? JSON.parse(msgs || "[]") : msgs || [];
      const binMsg = arr.find((m) => m?.name === "Bin" && /特殊请求已达成/.test(m?.content || ""));
      console.log("  品牌端聊天框验证:", binMsg ? "✓ Bin 消息已追加" : "✗ 未找到");
      if (binMsg) {
        console.log("    消息预览:", (binMsg.content || "").slice(0, 80) + "...");
      }
    } catch (e) {
      if (e?.code === "ER_NO_SUCH_TABLE" || e?.message?.includes("doesn't exist")) {
        console.log("  品牌端聊天框验证: 跳过（tiktok_campaign_sessions 表不存在）");
      } else {
        throw e;
      }
    }
  } else {
    console.log("  品牌端聊天框验证: 跳过（campaign 无 session_id）");
  }

  console.log("\n========== 测试完成 ==========");
  console.log("\n请检查：");
  console.log("  1. 红人邮箱 rysy2400@gmail.com 是否收到特殊请求邮件");
  console.log("  2. 前端打开该 Campaign 聊天，是否看到 Bin 的「特殊请求已达成一致」消息");
  console.log("  3. Campaign 执行详情中 last_event 是否包含 specialRequestResolved");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
