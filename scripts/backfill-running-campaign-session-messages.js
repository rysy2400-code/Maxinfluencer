/**
 * 批量修复「进行中」campaign 会话历史消息：
 * 1. 特殊请求：红人 @platformUserId → 可点击 [EXEC:@tiktok_username]
 * 2. 执行进度汇报：Campaign CAMP-xxx → 左侧栏 session.title
 *
 * 使用：
 *   node scripts/backfill-running-campaign-session-messages.js
 *   node scripts/backfill-running-campaign-session-messages.js --dry-run
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import {
  getCampaignSessionById,
  updateCampaignSession,
} from "../lib/db/campaign-session-dao.js";
import {
  buildExecutionUsernameLookup,
  repairSessionMessages,
  resolveHandleFromLookup,
} from "../lib/execution/repair-bin-message-content.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const dryRun = process.argv.includes("--dry-run");

async function loadCampaignsWithSpecialRequestMessages() {
  const rows = await queryTikTok(
    `
    SELECT
      c.id AS campaignId,
      c.session_id AS sessionId,
      c.status AS campaignStatus,
      s.title AS sessionTitle
    FROM tiktok_campaign c
    INNER JOIN tiktok_campaign_sessions s ON s.id = c.session_id
    WHERE c.session_id IS NOT NULL
      AND TRIM(c.session_id) <> ''
      AND JSON_SEARCH(s.messages, 'one', '%【特殊请求%', NULL, '$[*].content') IS NOT NULL
    ORDER BY c.created_at ASC
  `
  );
  return rows || [];
}

async function loadExecutionRows(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT tiktok_username, influencer_id
    FROM tiktok_campaign_execution
    WHERE campaign_id = ?
  `,
    [campaignId]
  );
  return rows || [];
}

function resolveCampaignDisplayName(sessionTitle) {
  const title = String(sessionTitle || "").trim();
  return title || "未命名 Campaign";
}

async function backfill() {
  const campaigns = await loadCampaignsWithSpecialRequestMessages();
  if (!campaigns.length) {
    console.log("[BackfillSessionMessages] 无含特殊请求消息的 campaign，跳过。");
    return;
  }

  console.log(
    `[BackfillSessionMessages] 共 ${campaigns.length} 个含特殊请求的 campaign${dryRun ? "（dry-run）" : ""}。`
  );

  let sessionsUpdated = 0;
  let messagesRepaired = 0;

  for (const row of campaigns) {
    const campaignId = row.campaignId;
    const sessionId = row.sessionId;
    const displayName = resolveCampaignDisplayName(row.sessionTitle);

    const session = await getCampaignSessionById(sessionId);
    if (!session) {
      console.warn(`  跳过 ${campaignId}：会话 ${sessionId} 不存在`);
      continue;
    }

    const lookup = buildExecutionUsernameLookup(await loadExecutionRows(campaignId));
    const resolveHandle = (key) => resolveHandleFromLookup(key, lookup);

    const { messages: repairedMessages, changedCount } = repairSessionMessages(
      session.messages,
      { resolveHandle, campaignDisplayName: displayName }
    );

    if (changedCount === 0) continue;

    messagesRepaired += changedCount;
    console.log(
      `  ${campaignId} / ${displayName}：修复 ${changedCount} 条消息（session ${sessionId}）`
    );

    if (!dryRun) {
      const result = await updateCampaignSession(sessionId, {
        messages: repairedMessages,
      });
      if (!result.success) {
        console.error(`    写入失败: ${result.message}`);
        continue;
      }
    }
    sessionsUpdated += 1;
  }

  console.log(
    `\n[BackfillSessionMessages] 完成：${sessionsUpdated} 个会话、${messagesRepaired} 条消息${dryRun ? "（未写库）" : " 已写库"}。`
  );
}

backfill().catch((err) => {
  console.error("[BackfillSessionMessages] 失败:", err);
  process.exit(1);
});
