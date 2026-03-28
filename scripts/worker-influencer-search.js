/**
 * Scraper Worker：从 tiktok_influencer_search_task 消费任务并执行补货。
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// 加载环境变量（.env 再 .env.local）
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function getCampaignById(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT
      id,
      product_info AS productInfo,
      campaign_info AS campaignInfo,
      influencer_profile AS influencerProfile,
      influencers_per_day AS influencersPerDay
    FROM tiktok_campaign
    WHERE id = ?
    LIMIT 1
  `,
    [campaignId]
  );
  if (!rows || !rows[0]) return null;

  const row = rows[0];
  function parseJsonOrObject(v) {
    if (v == null) return null;
    if (typeof v === "object") return v;
    if (typeof v !== "string") return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }

  return {
    id: row.id,
    influencersPerDay: Number(row.influencersPerDay || 0) || 0,
    productInfo: parseJsonOrObject(row.productInfo) || {},
    campaignInfo: parseJsonOrObject(row.campaignInfo) || {},
    influencerProfile: parseJsonOrObject(row.influencerProfile) || null,
  };
}

async function claimOnePendingTask(workerId) {
  const rows = await queryTikTok(
    `
    SELECT id, campaign_id, payload
    FROM tiktok_influencer_search_task
    WHERE status = 'pending'
    ORDER BY priority DESC, id ASC
    LIMIT 1
  `,
    []
  );
  if (!rows || !rows[0]) return null;
  const task = rows[0];

  const updateResult = await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET status = 'processing',
        worker_id = ?,
        started_at = NOW(),
        attempt_count = attempt_count + 1,
        updated_at = NOW()
    WHERE id = ?
      AND status = 'pending'
  `,
    [workerId, task.id]
  );

  if (!updateResult || Number(updateResult.affectedRows || 0) === 0) return null;
  return task;
}

async function markTaskStatus(id, status, errorMessage = null) {
  await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET status = ?,
        error_message = ?,
        finished_at = NOW(),
        updated_at = NOW()
    WHERE id = ?
  `,
    [status, errorMessage, id]
  );
}

function parseJsonOrObject(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function processTask(task) {
  const campaignId = task.campaign_id;
  const payload = parseJsonOrObject(task.payload) || {};
  const requestedBatch = Number(payload.targetBatchSize || 0) || 0;

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    await markTaskStatus(task.id, "failed", `未找到 campaign: ${campaignId}`);
    return;
  }

  const { productInfo, campaignInfo, influencerProfile, influencersPerDay } = campaign;
  const [{ generateSearchKeywords }, { searchAndExtractInfluencers }] =
    await Promise.all([
      import("../lib/tools/influencer-functions/generate-search-keywords.js"),
      import("../lib/tools/influencer-functions/search-and-extract-influencers.js"),
    ]);

  const kwResult = await generateSearchKeywords({
    productInfo,
    campaignInfo,
    influencerProfile,
    userMessage: payload.userMessage || "",
  });

  if (
    !kwResult?.success ||
    !Array.isArray(kwResult.search_queries) ||
    kwResult.search_queries.length === 0
  ) {
    await markTaskStatus(task.id, "failed", "生成搜索关键词失败或为空");
    return;
  }

  const target = Math.max(requestedBatch, influencersPerDay * 2, 10);
  const result = await searchAndExtractInfluencers(
    {
      keywords: { search_queries: kwResult.search_queries },
      platforms: campaignInfo.platforms || ["TikTok"],
      countries:
        campaignInfo.countries ||
        (campaignInfo.region ? [campaignInfo.region] : []),
      productInfo,
      campaignInfo,
      influencerProfile,
      campaignId,
    },
    {
      maxResults: target,
      maxEnrichCount: target,
      enrichProfileData: true,
      onStepUpdate: null,
    }
  );

  if (result?.success && Array.isArray(result.influencers)) {
    console.log(
      `[worker-influencer-search] 任务完成 id=${task.id}, campaign=${campaignId}, analyzed=${result.influencers.length}`
    );
    await markTaskStatus(task.id, "succeeded", null);
    return;
  }

  await markTaskStatus(
    task.id,
    "failed",
    `搜索/分析未得到有效红人: ${JSON.stringify(result || {}).slice(0, 400)}`
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const workerId = process.env.SEARCH_WORKER_ID || `search-worker-${process.pid}`;
  const idleSleepMs = Math.max(
    Number(process.env.SEARCH_WORKER_IDLE_SLEEP_MS || 3000) || 3000,
    500
  );
  const loopMode = String(process.env.SEARCH_WORKER_LOOP || "true") !== "false";

  console.log(
    `[worker-influencer-search] 启动 workerId=${workerId}, loop=${loopMode}, idleSleepMs=${idleSleepMs}`
  );

  do {
    let processed = false;
    try {
      const task = await claimOnePendingTask(workerId);
      if (task) {
        processed = true;
        await processTask(task);
      }
    } catch (err) {
      console.error("[worker-influencer-search] 处理任务时出错：", err?.message || err);
    }

    if (!loopMode) break;
    if (!processed) await sleep(idleSleepMs);
  } while (true);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[worker-influencer-search] 运行出错：", err?.message || err);
    process.exit(1);
  });

