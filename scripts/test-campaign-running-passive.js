/**
 * running_passive 模式：状态切换、导入门禁、心跳不派搜索任务
 *
 * 用法：node scripts/test-campaign-running-passive.js
 * 可选：CAMPAIGN_ID=xxx node scripts/test-campaign-running-passive.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { getCampaignById, updateCampaign } from "../lib/db/campaign-dao.js";
import {
  executeCampaignExecutionTool,
  CAMPAIGN_STATUS_UI_LABEL,
} from "../lib/tools/campaign-execution/campaign-execution-tools.js";
import {
  isActiveRunningStatus,
  skipsSearchDispatch,
  allowsInfluencerListImport,
} from "../lib/campaign/campaign-status.js";
import { runExecutionForCampaignById } from "../lib/heartbeat/execution-heartbeat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const CAMPAIGN_ID = process.env.CAMPAIGN_ID || "CAMP-1781189169673-I97DAPHV2";

function ok(name, pass, detail = "") {
  const mark = pass ? "✅" : "❌";
  console.log(`${mark} ${name}${detail ? `: ${detail}` : ""}`);
  return pass;
}

async function countPendingSearchTasks(campaignId) {
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n FROM tiktok_influencer_search_task
     WHERE campaign_id = ? AND status IN ('pending','processing')`,
    [campaignId]
  );
  return Number(rows?.[0]?.n || 0);
}

async function countSearchTasksAfterId(campaignId, afterId) {
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n FROM tiktok_influencer_search_task
     WHERE campaign_id = ? AND id > ?`,
    [campaignId, afterId]
  );
  return Number(rows?.[0]?.n || 0);
}

async function maxSearchTaskId(campaignId) {
  const rows = await queryTikTok(
    `SELECT COALESCE(MAX(id), 0) AS maxId FROM tiktok_influencer_search_task WHERE campaign_id = ?`,
    [campaignId]
  );
  return Number(rows?.[0]?.maxId || 0);
}

async function main() {
  console.log(`\n========== running_passive 测试 campaign=${CAMPAIGN_ID} ==========\n`);

  let campaign = await getCampaignById(CAMPAIGN_ID);
  if (!campaign) {
    console.error("Campaign 不存在，请设置 CAMPAIGN_ID");
    process.exit(1);
  }

  const originalStatus = campaign.status;
  const originalBeforePause = campaign.statusBeforePause ?? null;

  const results = [];

  // 1. 模块 helper
  results.push(ok("isActiveRunningStatus(running)", isActiveRunningStatus("running")));
  results.push(
    ok("isActiveRunningStatus(running_passive)", isActiveRunningStatus("running_passive"))
  );
  results.push(ok("skipsSearchDispatch(running_passive)", skipsSearchDispatch("running_passive")));
  results.push(
    ok("!skipsSearchDispatch(running)", !skipsSearchDispatch("running"))
  );
  results.push(
    ok("allowsImport(running_passive)", allowsInfluencerListImport("running_passive"))
  );
  results.push(
    ok("!allowsImport(paused)", !allowsInfluencerListImport("paused"))
  );

  // 2. 标签
  results.push(
    ok(
      "工作笔记 label running",
      CAMPAIGN_STATUS_UI_LABEL.running === "自主分析联系红人"
    )
  );
  results.push(
    ok(
      "工作笔记 label running_passive",
      CAMPAIGN_STATUS_UI_LABEL.running_passive === "只按名单分析联系红人"
    )
  );

  // 3. to_passive / to_auto
  if (campaign.status !== "running") {
    await updateCampaign(CAMPAIGN_ID, { status: "running", statusBeforePause: null });
    campaign = await getCampaignById(CAMPAIGN_ID);
  }

  const pendingBeforePassive = await countPendingSearchTasks(CAMPAIGN_ID);
  const maxIdBeforePassive = await maxSearchTaskId(CAMPAIGN_ID);

  const toPassive = await executeCampaignExecutionTool(
    "set_campaign_status",
    { action: "to_passive" },
    { campaignId: CAMPAIGN_ID }
  );
  campaign = await getCampaignById(CAMPAIGN_ID);
  results.push(ok("to_passive success", toPassive.success === true));
  results.push(ok("status=running_passive", campaign.status === "running_passive"));
  const pendingAfterPassive = await countPendingSearchTasks(CAMPAIGN_ID);
  results.push(
    ok(
      "to_passive 不 cancel pending 搜索",
      pendingAfterPassive >= pendingBeforePassive,
      `before=${pendingBeforePassive} after=${pendingAfterPassive}`
    )
  );

  // 4. 心跳不新增搜索
  await runExecutionForCampaignById(CAMPAIGN_ID, new Date());
  const newTasksAfterPassiveHb = await countSearchTasksAfterId(
    CAMPAIGN_ID,
    maxIdBeforePassive
  );
  results.push(
    ok(
      "running_passive 心跳不新增搜索任务",
      newTasksAfterPassiveHb === 0,
      `newTasks=${newTasksAfterPassiveHb}`
    )
  );

  // 5. pause / resume 回到 running_passive
  const pauseRes = await executeCampaignExecutionTool(
    "set_campaign_status",
    { action: "pause" },
    { campaignId: CAMPAIGN_ID }
  );
  campaign = await getCampaignById(CAMPAIGN_ID);
  results.push(ok("pause from running_passive", pauseRes.success && campaign.status === "paused"));
  results.push(
    ok(
      "status_before_pause=running_passive",
      campaign.statusBeforePause === "running_passive"
    )
  );

  const resumeRes = await executeCampaignExecutionTool(
    "set_campaign_status",
    { action: "resume" },
    { campaignId: CAMPAIGN_ID }
  );
  campaign = await getCampaignById(CAMPAIGN_ID);
  results.push(
    ok(
      "resume 回到 running_passive",
      resumeRes.success && campaign.status === "running_passive"
    )
  );

  // 6. to_auto 不立即新增搜索（同一 tick 内对比 maxId）
  const maxIdBeforeAuto = await maxSearchTaskId(CAMPAIGN_ID);
  const toAuto = await executeCampaignExecutionTool(
    "set_campaign_status",
    { action: "to_auto" },
    { campaignId: CAMPAIGN_ID }
  );
  campaign = await getCampaignById(CAMPAIGN_ID);
  results.push(ok("to_auto success", toAuto.success === true));
  results.push(ok("status=running", campaign.status === "running"));
  const newTasksAfterAuto = await countSearchTasksAfterId(CAMPAIGN_ID, maxIdBeforeAuto);
  results.push(
    ok(
      "to_auto 不立即新增搜索任务",
      newTasksAfterAuto === 0,
      `newTasks=${newTasksAfterAuto}`
    )
  );

  // 恢复原始状态
  await updateCampaign(CAMPAIGN_ID, {
    status: originalStatus,
    statusBeforePause: originalBeforePause,
  });

  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\n========== 结果: ${passed}/${total} 通过 ==========\n`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
