/**
 * Scraper Worker：从 tiktok_influencer_search_task 消费任务并执行补货。
 */

import dotenv from "dotenv";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { createWorkLiveStepBridge } from "../lib/utils/work-live-step-bridge.js";
import { publishWorkLiveFromWorker } from "../lib/realtime/work-live-worker-publisher.js";
import { runExecutionHeartbeatTick } from "../lib/heartbeat/execution-heartbeat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// 加载环境变量（.env 再 .env.local）
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function detectWorkerIp() {
  const preferred = String(process.env.SEARCH_WORKER_IP || "").trim();
  if (preferred) return preferred;
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const entries of Object.values(nets || {})) {
    for (const info of entries || []) {
      if (!info || info.family !== "IPv4" || info.internal) continue;
      candidates.push(info.address);
    }
  }
  return candidates[0] || null;
}

const CURRENT_WORKER_ID =
  process.env.SEARCH_WORKER_ID || `search-worker-${process.pid}`;
const CURRENT_WORKER_HOST =
  process.env.SEARCH_WORKER_HOST || process.env.HOSTNAME || null;
const CURRENT_WORKER_IP = detectWorkerIp();

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

async function getCampaignById(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT
      id,
      session_id AS sessionId,
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
  return {
    id: row.id,
    sessionId: row.sessionId || row.session_id || null,
    influencersPerDay: Number(row.influencersPerDay || 0) || 0,
    productInfo: parseJsonOrObject(row.productInfo) || {},
    campaignInfo: parseJsonOrObject(row.campaignInfo) || {},
    influencerProfile: parseJsonOrObject(row.influencerProfile) || null,
  };
}

function calcKeywordScore(metrics = {}) {
  const enrichSuccessCount = Number(metrics.enrichSuccessCount || 0);
  const analyzeRecommendedCount = Number(metrics.analyzeRecommendedCount || 0);
  const failCount = Number(metrics.failCount || 0);
  const matchRate = enrichSuccessCount > 0 ? analyzeRecommendedCount / enrichSuccessCount : 0;
  return matchRate * 10 + enrichSuccessCount * 0.05 - failCount * 0.2;
}

async function upsertKeywordRunResult({
  campaignId,
  sessionId,
  runId,
  taskId,
  keyword,
  keywordType = "new",
  workerId,
  workerHost,
  workerIp,
  metrics = {},
}) {
  if (!campaignId || !runId || !keyword) return;
  const score = calcKeywordScore(metrics);

  await queryTikTok(
    `
    INSERT INTO tiktok_keyword_run_result (
      campaign_id,
      session_id,
      run_id,
      task_id,
      keyword,
      keyword_type,
      assigned_worker,
      assigned_worker_host,
      assigned_worker_ip,
      search_count,
      enrich_success_count,
      analyze_recommended_count,
      insert_candidate_count,
      fail_count,
      fail_reason,
      elapsed_ms,
      score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      assigned_worker = VALUES(assigned_worker),
      assigned_worker_host = VALUES(assigned_worker_host),
      search_count = VALUES(search_count),
      enrich_success_count = VALUES(enrich_success_count),
      analyze_recommended_count = VALUES(analyze_recommended_count),
      insert_candidate_count = VALUES(insert_candidate_count),
      fail_count = VALUES(fail_count),
      fail_reason = VALUES(fail_reason),
      elapsed_ms = VALUES(elapsed_ms),
      score = VALUES(score),
      updated_at = NOW()
  `,
    [
      campaignId,
      sessionId || null,
      runId,
      taskId || null,
      keyword,
      keywordType || "new",
      workerId || null,
      workerHost || null,
      workerIp || null,
      Number(metrics.searchCount || 0),
      Number(metrics.enrichSuccessCount || 0),
      Number(metrics.analyzeRecommendedCount || 0),
      Number(metrics.insertCandidateCount || 0),
      Number(metrics.failCount || 0),
      metrics.failReason || null,
      metrics.elapsedMs == null ? null : Number(metrics.elapsedMs),
      Number(score || 0),
    ]
  );
}

async function claimOnePendingTask(workerId) {
  const workerHost = CURRENT_WORKER_HOST;
  const workerIp = CURRENT_WORKER_IP;
  const inflightRows = await queryTikTok(
    `
    SELECT id
    FROM tiktok_influencer_search_task
    WHERE status = 'processing'
      AND (
        (worker_id IS NOT NULL AND worker_id = ?)
        OR (worker_host IS NOT NULL AND worker_host = ?)
        OR (worker_ip IS NOT NULL AND worker_ip = ?)
      )
    LIMIT 1
  `,
    [workerId, workerHost, workerIp]
  );
  if (inflightRows && inflightRows[0]) return null;

  const rows = await queryTikTok(
    `
    SELECT id, campaign_id, session_id, run_id, keyword, keyword_type, payload
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
        worker_host = ?,
        worker_ip = ?,
        started_at = NOW(),
        attempt_count = attempt_count + 1,
        updated_at = NOW()
    WHERE id = ?
      AND status = 'pending'
  `,
    [workerId, workerHost, workerIp, task.id]
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
async function processTask(task) {
  const campaignId = task.campaign_id;
  const payload = parseJsonOrObject(task.payload) || {};
  const requestedBatch = Number(payload.targetBatchSize || 0) || 0;
  const taskKeyword = task.keyword || payload.keyword || null;
  const taskKeywordType = task.keyword_type || payload.keywordType || "new";
  const runId = task.run_id || payload.runId || null;
  const keywordReason = String(payload.keywordReason || "").trim();
  const taskStartMs = Date.now();

  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    await markTaskStatus(task.id, "failed", `未找到 campaign: ${campaignId}`);
    return;
  }

  const { productInfo, campaignInfo, influencerProfile, influencersPerDay, sessionId } =
    campaign;

  const publishKeywordNote = async ({ status, extractedCount = null, matchedCount = null, error = null }) => {
    if (!sessionId) return;
    try {
      await publishWorkLiveFromWorker(sessionId, {
        type: "work_note_keyword_summary",
        data: {
          taskId: task.id,
          time: new Date().toISOString(),
          keyword: taskKeyword || payload.keyword || "",
          reasonText: keywordReason || "该关键词更贴近当前 campaign 的目标受众方向。",
          extractedCount:
            extractedCount == null || Number.isNaN(Number(extractedCount))
              ? null
              : Number(extractedCount),
          matchedCount:
            matchedCount == null || Number.isNaN(Number(matchedCount))
              ? null
              : Number(matchedCount),
          status,
          error: error ? String(error).slice(0, 180) : null,
        },
      });
    } catch {
      // ignore work-note publish errors
    }
  };

  await publishKeywordNote({ status: "started" });

  let onStepUpdate = null;
  if (sessionId) {
    const source = {
      workerId: process.env.SEARCH_WORKER_ID || `search-worker-${process.pid}`,
      workerHost: process.env.SEARCH_WORKER_HOST || process.env.HOSTNAME || null,
    };
    const bridge = createWorkLiveStepBridge((ev) => {
      const wrapped = {
        ...ev,
        data: ev?.data && typeof ev.data === "object" ? { ...ev.data, source } : ev?.data,
      };
      publishWorkLiveFromWorker(sessionId, wrapped).catch(() => {});
    });
    onStepUpdate = (raw) => {
      try {
        bridge(raw);
      } catch {
        // ignore bridge errors
      }
    };
  }

  const [{ generateSearchKeywords }, { searchAndExtractInfluencers }] =
    await Promise.all([
      import("../lib/tools/influencer-functions/generate-search-keywords.js"),
      import("../lib/tools/influencer-functions/search-and-extract-influencers.js"),
    ]);

  const kwResult = taskKeyword
    ? { success: true, search_queries: [taskKeyword] }
    : await generateSearchKeywords({
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
    await upsertKeywordRunResult({
      campaignId,
      sessionId,
      runId: runId || `${campaignId}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
      taskId: task.id,
      keyword: taskKeyword || "(llm_empty)",
      keywordType: taskKeywordType,
      workerId: CURRENT_WORKER_ID,
      workerHost: CURRENT_WORKER_HOST,
      workerIp: CURRENT_WORKER_IP,
      metrics: { failCount: 1, failReason: "keyword_empty", elapsedMs: Date.now() - taskStartMs },
    });
    await publishKeywordNote({
      status: "failed",
      error: "生成搜索关键词失败或为空",
    });
    return;
  }

  const defaultTarget = Math.max(influencersPerDay * 2, 10);
  const target = requestedBatch > 0 ? requestedBatch : defaultTarget;
  let result = null;
  try {
    result = await searchAndExtractInfluencers(
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
        onStepUpdate,
      }
    );
  } catch (err) {
    const failMsg = `searchAndExtractInfluencers throw: ${String(err?.message || err).slice(0, 300)}`;
    console.error(
      "[worker-influencer-search] searchAndExtract throw trace:",
      {
        taskId: task.id,
        campaignId,
        keyword: taskKeyword || kwResult.search_queries?.[0] || null,
        errorMessage: err?.message || String(err),
        errorStack: err?.stack || null,
      }
    );
    await markTaskStatus(task.id, "failed", failMsg);
    await upsertKeywordRunResult({
      campaignId,
      sessionId,
      runId: runId || `${campaignId}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
      taskId: task.id,
      keyword: taskKeyword || kwResult.search_queries?.[0] || "(auto)",
      keywordType: taskKeywordType,
      workerId: CURRENT_WORKER_ID,
      workerHost: CURRENT_WORKER_HOST,
      workerIp: CURRENT_WORKER_IP,
      metrics: {
        failCount: 1,
        failReason: String(err?.message || "search_throw").slice(0, 255),
        elapsedMs: Date.now() - taskStartMs,
      },
    });
    await publishKeywordNote({
      status: "failed",
      error: String(err?.message || "search_throw"),
    });
    return;
  }

  if (result?.success && Array.isArray(result.influencers)) {
    console.log(
      `[worker-influencer-search] 任务完成 id=${task.id}, campaign=${campaignId}, analyzed=${result.influencers.length}`
    );
    await markTaskStatus(task.id, "succeeded", null);

    const influencers = Array.isArray(result.influencers) ? result.influencers : [];
    const recommendedCount = influencers.filter((x) => x && x.isRecommended).length;
    const enrichedCount = influencers.filter(
      (x) => x && (x.profileDataReady || x.analysisReady || (typeof x.analysis === "string" && x.analysis.trim()))
    ).length;
    const searchCount = Number(result?.stats?.videoCount || result?.videos?.length || 0);
    await upsertKeywordRunResult({
      campaignId,
      sessionId,
      runId: runId || `${campaignId}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
      taskId: task.id,
      keyword: taskKeyword || kwResult.search_queries?.[0] || "(auto)",
      keywordType: taskKeywordType,
      workerId: CURRENT_WORKER_ID,
      workerHost: CURRENT_WORKER_HOST,
      workerIp: CURRENT_WORKER_IP,
      metrics: {
        searchCount,
        enrichSuccessCount: enrichedCount,
        analyzeRecommendedCount: recommendedCount,
        insertCandidateCount: enrichedCount,
        failCount: 0,
        elapsedMs: Date.now() - taskStartMs,
      },
    });
    await publishKeywordNote({
      status: "finished",
      extractedCount: enrichedCount,
      matchedCount: recommendedCount,
    });
    return;
  }

  const resultErrorRaw =
    result?.error && typeof result.error === "object"
      ? JSON.stringify(result.error)
      : String(result?.error || "");
  const failMsg = `搜索/分析未得到有效红人: err=${resultErrorRaw.slice(0, 180)} raw=${JSON.stringify(
    result || {}
  ).slice(0, 220)}`;
  console.error(
    "[worker-influencer-search] searchAndExtract result not successful:",
    JSON.stringify(
      {
        taskId: task.id,
        campaignId,
        keyword: taskKeyword || kwResult.search_queries?.[0] || null,
        result,
      },
      null,
      2
    )
  );
  await markTaskStatus(task.id, "failed", failMsg);
  await upsertKeywordRunResult({
    campaignId,
    sessionId,
    runId: runId || `${campaignId}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
    taskId: task.id,
    keyword: taskKeyword || kwResult.search_queries?.[0] || "(auto)",
    keywordType: taskKeywordType,
    workerId: CURRENT_WORKER_ID,
    workerHost: CURRENT_WORKER_HOST,
    workerIp: CURRENT_WORKER_IP,
    metrics: {
      searchCount: Number(result?.videos?.length || 0),
      enrichSuccessCount: Number(result?.influencers?.length || 0),
      analyzeRecommendedCount: Number((result?.influencers || []).filter((x) => x && x.isRecommended).length || 0),
      insertCandidateCount: Number(result?.influencers?.length || 0),
      failCount: 1,
      failReason: String(result?.error || "search_failed").slice(0, 255),
      elapsedMs: Date.now() - taskStartMs,
    },
  });
  await publishKeywordNote({
    status: "failed",
    extractedCount: Number(result?.influencers?.length || 0),
    matchedCount: Number((result?.influencers || []).filter((x) => x && x.isRecommended).length || 0),
    error: String(result?.error || "search_failed"),
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const workerId = CURRENT_WORKER_ID;
  const idleSleepMs = Math.max(
    Number(process.env.SEARCH_WORKER_IDLE_SLEEP_MS || 3000) || 3000,
    500
  );
  const loopMode = String(process.env.SEARCH_WORKER_LOOP || "true") !== "false";

  console.log(
    `[worker-influencer-search] 启动 workerId=${workerId}, host=${CURRENT_WORKER_HOST || "unknown"}, ip=${CURRENT_WORKER_IP || "unknown"}, loop=${loopMode}, idleSleepMs=${idleSleepMs}`
  );

  do {
    let processed = false;
    try {
      const task = await claimOnePendingTask(workerId);
      if (task) {
        processed = true;
        await processTask(task);

        // 滚动补位：任一任务完成后，立即触发一次调度心跳（不等 15 分钟）
        if (String(process.env.SEARCH_WORKER_TRIGGER_HEARTBEAT || "true") !== "false") {
          try {
            await runExecutionHeartbeatTick(new Date());
          } catch (hbErr) {
            console.warn(
              "[worker-influencer-search] 任务后触发 execution heartbeat 失败：",
              hbErr?.message || hbErr
            );
          }
        }
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

