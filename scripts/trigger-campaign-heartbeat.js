#!/usr/bin/env node
/**
 * 对指定 campaign 手动触发 N 次执行心跳（仅该 campaign，不跑其它 running）。
 *
 * 用法：
 *   node scripts/trigger-campaign-heartbeat.js CAMP-xxx 3
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { runExecutionForCampaignById } from "../lib/heartbeat/execution-heartbeat.js";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const campaignId = process.argv[2];
const times = Math.max(1, Number(process.argv[3] || 1) || 1);

if (!campaignId) {
  console.error("用法: node scripts/trigger-campaign-heartbeat.js <campaignId> [times]");
  process.exit(1);
}

function getTodayRunId(id, now = new Date()) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `${id}-${day}`;
}

async function latestKeywordsForRun(campaignId, runId, afterId = 0) {
  const rows = await queryTikTok(
    `
    SELECT id, keyword, platform, keyword_type AS keywordType, status, created_at AS createdAt
    FROM tiktok_influencer_search_task
    WHERE campaign_id = ?
      AND run_id = ?
      AND id > ?
    ORDER BY id ASC
  `,
    [campaignId, runId, afterId]
  );
  return rows || [];
}

async function main() {
  const now = new Date();
  const runId = getTodayRunId(campaignId, now);
  let lastTaskId = 0;
  const rows = await queryTikTok(
    `SELECT COALESCE(MAX(id), 0) AS maxId FROM tiktok_influencer_search_task WHERE campaign_id = ?`,
    [campaignId]
  );
  lastTaskId = Number(rows?.[0]?.maxId || 0);

  console.log(`[trigger] campaign=${campaignId} times=${times} runId=${runId} lastTaskId=${lastTaskId}`);

  const dispatched = [];
  for (let i = 1; i <= times; i += 1) {
    console.log(`\n[trigger] === heartbeat ${i}/${times} ===`);
    try {
      await runExecutionForCampaignById(campaignId, new Date());
    } catch (err) {
      console.error(`[trigger] heartbeat ${i} error:`, err?.message || err);
    }

    const newTasks = await latestKeywordsForRun(campaignId, runId, lastTaskId);
    for (const t of newTasks) {
      dispatched.push(t);
      lastTaskId = Math.max(lastTaskId, Number(t.id));
      console.log(
        `[trigger] dispatched: id=${t.id} platform=${t.platform} keyword="${t.keyword}" type=${t.keywordType} status=${t.status}`
      );
    }
    if (!newTasks.length) {
      console.log("[trigger] 本轮未新增搜索任务（可能并发已满或今日目标已满）");
    }
  }

  console.log("\n[trigger] === summary ===");
  if (!dispatched.length) {
    console.log("未生成新关键词任务。");
  } else {
    dispatched.forEach((t, idx) => {
      console.log(`${idx + 1}. [${t.platform}] ${t.keyword} (${t.keywordType}, ${t.status})`);
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[trigger] failed:", err);
    process.exit(1);
  });
