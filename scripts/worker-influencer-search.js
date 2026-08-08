/**
 * Scraper Worker：从 tiktok_influencer_search_task 消费任务并执行补货。
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";
import { createWorkLiveStepBridge } from "../lib/utils/work-live-step-bridge.js";
import { publishWorkLiveFromWorker } from "../lib/realtime/work-live-worker-publisher.js";
import { detectPrimaryIpv4 } from "../lib/utils/net-ip.js";
import { resolveAllowedCountriesFromCampaign } from "../lib/influencer/campaign-country-codes.js";
import {
  normalizePlatformSlug,
  resolveCampaignPlatforms,
} from "../lib/influencer/resolve-campaign-platforms.js";
import { runInCdpLoop } from "../lib/cdp/cdp-loop-context.js";
import { isCdp9222Parallel, resolveCdp9222Mode } from "../lib/cdp/connect-cdp-9222.js";
import {
  fetchSearchTaskWorkNoteMetrics,
  setSearchTaskFinalMetrics,
} from "../lib/db/campaign-candidates-dao.js";
import { consumeKeywordSignalForSearch } from "../lib/db/campaign-keyword-signals-dao.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// 加载环境变量（.env 再 .env.local）
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function setDefaultEnv(key, value) {
  if (process.env[key] == null || String(process.env[key]).trim() === "") {
    process.env[key] = String(value);
  }
}

function applyTiktokLiteProductionDefaults() {
  setDefaultEnv("SCRAPER_MODE", "lite");
  setDefaultEnv("CDP_ENDPOINT", "http://127.0.0.1:9222");
  setDefaultEnv("CDP_ENDPOINT_ENRICH", "http://127.0.0.1:9223");
  setDefaultEnv("TT_LITE_ENRICH_CDP", process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223");
  setDefaultEnv("TT_LITE_COUNTRY_CDP", process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223");
  setDefaultEnv("TT_LITE_STRICT_API_ONLY_NO_GOTO", "1");
  setDefaultEnv("TT_LITE_TAB_POOL_SIZE", "1");
  setDefaultEnv("TT_LITE_COUNTRY_CONCURRENCY", "10");
  // TikTok /api/post/item_list 会在 1tab/10 连续请求后短时返回 200 空列表；
  // 生产默认先保守串行，后续用压测数据再提高到 2/3/5。
  setDefaultEnv("LITE_TT_ENRICH_CONCURRENCY", "1");
  setDefaultEnv("LITE_TT_ENRICH_CONCURRENCY_MAX", "1");
  setDefaultEnv("TT_LITE_POST_ITEM_RETRIES", "2");
  setDefaultEnv("TT_LITE_EMPTY_ITEMS_COOLDOWN_MS", "15000");
  setDefaultEnv("TT_LITE_PROFILE_BETWEEN_MIN_MS", "3000");
  setDefaultEnv("TT_LITE_PROFILE_BETWEEN_MAX_MS", "5000");
  setDefaultEnv("TT_LITE_COUNTRY_SEARCH_ALT_VIDEOS", "1");
  setDefaultEnv("TT_SEARCH_MAX_INFLUENCERS", "500");
  setDefaultEnv("SEARCH_MAX_POOL_SIZE", "500");
  setDefaultEnv("TT_LITE_SEARCH_MAX_PAGES", "80");
  setDefaultEnv("TT_LITE_MAX_VIDEOS", "50");
  setDefaultEnv("LITE_DISABLE_SCREENSHOTS", "true");
  setDefaultEnv("LITE_ENRICH_SCREENSHOTS", "false");
}

function detectWorkerIp() {
  return detectPrimaryIpv4({ preferEnvKey: "SEARCH_WORKER_IP" });
}

const CURRENT_WORKER_HOST =
  process.env.SEARCH_WORKER_HOST || process.env.HOSTNAME || null;
const CURRENT_WORKER_IP = detectWorkerIp();

function workerIpToken() {
  return String(CURRENT_WORKER_IP || "unknown").replace(/\./g, "-");
}

/** @param {'tiktok'|'instagram'|'youtube'} platformSlug */
function workerIdForPlatform(platformSlug) {
  return `search-worker-${workerIpToken()}-${platformSlug}`;
}

function resolveSearchWorkerSlots() {
  return Math.min(3, Math.max(1, Number(process.env.SEARCH_WORKER_SLOTS) || 1));
}

function resolveWorkerPlatforms() {
  const raw = process.env.SEARCH_WORKER_PLATFORMS || "tiktok,instagram,youtube";
  return raw
    .split(",")
    .map((s) => normalizePlatformSlug(s.trim()))
    .filter(Boolean);
}

function taskPlatformFromPayload(payload) {
  if (!payload || payload.platform == null || payload.platform === "") return null;
  return normalizePlatformSlug(payload.platform);
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

async function getCampaignById(campaignId) {
  const rows = await queryTikTok(
    `
    SELECT
      id,
      session_id AS sessionId,
      product_info AS productInfo,
      campaign_info AS campaignInfo,
      influencer_profile AS influencerProfile,
      keyword_strategy AS keywordStrategy,
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
    keywordStrategy: (() => {
      const raw =
        row.keywordStrategy ??
        row.keywordstrategy ??
        row.keyword_strategy ??
        row.KEYWORD_STRATEGY;
      return typeof raw === "string" ? raw.trim() : null;
    })(),
  };
}

function calcKeywordScore(metrics = {}) {
  const enrichSuccessCount = Number(metrics.enrichSuccessCount || 0);
  const analyzeRecommendedCount = Number(metrics.analyzeRecommendedCount || 0);
  const failCount = Number(metrics.failCount || 0);
  const matchRate = enrichSuccessCount > 0 ? analyzeRecommendedCount / enrichSuccessCount : 0;
  return matchRate * 10 + enrichSuccessCount * 0.05 - failCount * 0.2;
}

function safeCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function countInfluencers(influencers, predicate) {
  return (Array.isArray(influencers) ? influencers : []).filter(predicate).length;
}

function deriveSearchTaskMetricsFromResult(result = {}) {
  const influencers = Array.isArray(result.influencers) ? result.influencers : [];
  const stats = result.stats || {};
  const country = result.countryFilter || stats.countryFilter || {};
  const searchFoundCount = Math.max(
    safeCount(stats.searchChannelCount),
    safeCount(stats.influencerCount),
    safeCount(result.savedCount),
    influencers.length
  );
  const profileBrowsedCount = Math.max(
    safeCount(stats.enrichedCount),
    countInfluencers(
      influencers,
      (inf) => !!(inf?.profileDataReady || inf?.profile_data || inf?.viewsData || inf?.engagement)
    )
  );
  const analyzedCount = Math.max(
    safeCount(stats.analyzedCount),
    countInfluencers(
      influencers,
      (inf) => typeof inf?.isRecommended === "boolean" || !!inf?.analysisReady
    )
  );
  const recommendedCount = Math.max(
    safeCount(stats.recommendedCount),
    countInfluencers(influencers, (inf) => inf?.isRecommended === true)
  );
  const contactableCount = countInfluencers(
    influencers,
    (inf) => inf?.isRecommended === true && !!(inf?.email || inf?.hasEmail)
  );
  return {
    searchFoundCount,
    profileBrowsedCount,
    analyzedCount,
    recommendedCount,
    contactableCount,
    skipCountryUnknownCount: safeCount(country.unknown),
    skipCountryMismatchCount: safeCount(country.mismatch),
  };
}

function mergeSearchTaskMetrics(...items) {
  const out = {
    searchFoundCount: 0,
    profileBrowsedCount: 0,
    analyzedCount: 0,
    recommendedCount: 0,
    contactableCount: 0,
    skipCountryUnknownCount: 0,
    skipCountryMismatchCount: 0,
    newRecommendedInsertCount: 0,
  };
  for (const item of items) {
    if (!item) continue;
    for (const key of Object.keys(out)) {
      out[key] = Math.max(out[key], safeCount(item[key]));
    }
  }
  return out;
}

async function upsertKeywordRunResult({
  campaignId,
  sessionId,
  runId,
  taskId,
  keyword,
  keywordType = "new",
  platform = "tiktok",
  workerId,
  workerHost,
  workerIp,
  metrics = {},
}) {
  if (!campaignId || !runId || !keyword) return;
  const score = calcKeywordScore(metrics);
  const platformSlug = String(platform || "tiktok").trim().toLowerCase() || "tiktok";

  await queryTikTok(
    `
    INSERT INTO tiktok_keyword_run_result (
      campaign_id,
      session_id,
      run_id,
      task_id,
      keyword,
      platform,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      task_id = VALUES(task_id),
      assigned_worker = VALUES(assigned_worker),
      assigned_worker_host = VALUES(assigned_worker_host),
      assigned_worker_ip = VALUES(assigned_worker_ip),
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
      platformSlug,
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

async function countProcessingOnWorkerIp() {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS c
    FROM (
      SELECT id FROM tiktok_influencer_search_task
      WHERE status = 'processing' AND worker_ip IS NOT NULL AND worker_ip = ?
      UNION ALL
      SELECT id FROM tiktok_influencer_import_task
      WHERE status = 'processing' AND worker_ip IS NOT NULL AND worker_ip = ?
    ) t
  `,
    [CURRENT_WORKER_IP, CURRENT_WORKER_IP]
  );
  return Number(rows?.[0]?.c ?? rows?.[0]?.C ?? 0) || 0;
}

async function hasInflightForPlatform(platformSlug, platformWorkerId) {
  const rows = await queryTikTok(
    `
    SELECT id
    FROM tiktok_influencer_search_task
    WHERE status = 'processing'
      AND worker_id = ?
      AND worker_ip = ?
    LIMIT 1
  `,
    [platformWorkerId, CURRENT_WORKER_IP]
  );
  return Boolean(rows?.[0]);
}

const PENDING_CLAIM_SCAN_LIMIT = 40;

function isSearchImportTaskLoopEnabled() {
  return String(process.env.SEARCH_IMPORT_TASK_LOOP ?? "true").toLowerCase() !== "false";
}

/** 有 pending 导入任务时，搜索 loop 让出 slot 给 importTaskLoop（与 DB priority 150>100 一致） */
async function hasPendingImportTask() {
  if (!isSearchImportTaskLoopEnabled()) return false;
  const rows = await queryTikTok(
    `
    SELECT id FROM tiktok_influencer_import_task
    WHERE status = 'pending'
    LIMIT 1
  `,
    []
  );
  return Boolean(rows?.[0]);
}

/**
 * @param {'tiktok'|'instagram'|'youtube'} platformSlug
 * @param {string} platformWorkerId
 */
async function claimOnePendingTaskForPlatform(platformSlug, platformWorkerId) {
  const slots = resolveSearchWorkerSlots();
  if (await hasInflightForPlatform(platformSlug, platformWorkerId)) return null;
  if ((await countProcessingOnWorkerIp()) >= slots) return null;
  if (await hasPendingImportTask()) return null;

  // mysql2 预处理不支持 LIMIT ?（ER_WRONG_ARGUMENTS），limit 为常量整数
  const rows = await queryTikTok(
    `
    SELECT id, campaign_id, session_id, run_id, keyword, keyword_type, payload
    FROM tiktok_influencer_search_task
    WHERE status = 'pending'
      AND (
        platform = ?
        OR (
          (platform IS NULL OR platform = '')
          AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.platform')) = ?
        )
      )
    ORDER BY priority DESC, id ASC
    LIMIT ${PENDING_CLAIM_SCAN_LIMIT}
  `,
    [platformSlug, platformSlug]
  );
  if (!rows?.length) return null;

  for (const row of rows) {
    const payload = parseJsonOrObject(row.payload) || {};
    const taskPlatform = taskPlatformFromPayload(payload);
    if (!taskPlatform) {
      await markTaskStatus(row.id, "failed", "missing payload.platform");
      continue;
    }
    if (taskPlatform !== platformSlug) continue;

    const updateResult = await queryTikTok(
      `
      UPDATE tiktok_influencer_search_task
      SET status = 'processing',
          worker_id = ?,
          worker_host = ?,
          worker_ip = ?,
          last_progress_at = NOW(),
          progress_search_found_count = 0,
          progress_profile_browsed_count = 0,
          progress_analyzed_count = 0,
          progress_recommended_count = 0,
          progress_contactable_count = 0,
          progress_skip_country_unknown_count = 0,
          progress_skip_country_mismatch_count = 0,
          started_at = NOW(),
          attempt_count = attempt_count + 1,
          updated_at = NOW()
      WHERE id = ?
        AND status = 'pending'
    `,
      [platformWorkerId, CURRENT_WORKER_HOST, CURRENT_WORKER_IP, row.id]
    );
    if (updateResult && Number(updateResult.affectedRows || 0) > 0) {
      return row;
    }
  }
  return null;
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

async function loadTaskWorkNoteMetrics(taskId) {
  try {
    return await fetchSearchTaskWorkNoteMetrics(taskId);
  } catch {
    return {
      searchFoundCount: 0,
      profileBrowsedCount: 0,
      analyzedCount: 0,
      recommendedCount: 0,
      contactableCount: 0,
      skipCountryUnknownCount: 0,
      skipCountryMismatchCount: 0,
      newRecommendedInsertCount: 0,
    };
  }
}

async function consumeSignalForCompletedTask({
  campaignId,
  platform,
  keyword,
  taskId,
}) {
  const resolvedKeyword = String(keyword || "").trim();
  if (!campaignId || !resolvedKeyword) return;
  try {
    const metrics = await loadTaskWorkNoteMetrics(taskId);
    const result = await consumeKeywordSignalForSearch({
      campaignId,
      platform,
      keyword: resolvedKeyword,
      newRecommendedCount: Number(metrics.newRecommendedInsertCount || 0),
    });
    if (result.consumed) {
      console.log(
        `[worker-influencer-search] signal consumed task=${taskId} keyword=${resolvedKeyword} signal=${result.signalValue} newRec=${metrics.newRecommendedInsertCount || 0}`
      );
    } else {
      console.log(
        `[worker-influencer-search] signal consume miss task=${taskId} keyword=${resolvedKeyword} platform=${platform}`
      );
    }
  } catch (err) {
    console.warn(
      `[worker-influencer-search] signal consume failed task=${taskId} keyword=${resolvedKeyword}:`,
      err?.message || err
    );
  }
}

async function processTask(task, platformSlug) {
  const platformWorkerId = workerIdForPlatform(platformSlug);
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

  const {
    productInfo,
    campaignInfo,
    influencerProfile,
    influencersPerDay,
    sessionId,
    keywordStrategy,
  } = campaign;

  const campaignPlatforms = resolveCampaignPlatforms(campaignInfo);
  const taskPlatformSlug = taskPlatformFromPayload(payload);
  if (!taskPlatformSlug) {
    await markTaskStatus(task.id, "failed", "missing payload.platform");
    return;
  }
  if (taskPlatformSlug !== platformSlug) {
    await markTaskStatus(
      task.id,
      "failed",
      `platform mismatch: payload=${taskPlatformSlug} loop=${platformSlug}`
    );
    return;
  }
  if (taskPlatformSlug === "tiktok") {
    applyTiktokLiteProductionDefaults();
    console.log(
      `[worker-influencer-search] TikTok Lite defaults: search=${process.env.CDP_ENDPOINT} country/enrich=${process.env.CDP_ENDPOINT_ENRICH} tab=${process.env.TT_LITE_TAB_POOL_SIZE} country_c=${process.env.TT_LITE_COUNTRY_CONCURRENCY} enrich_c=${process.env.LITE_TT_ENRICH_CONCURRENCY} pool=${process.env.SEARCH_MAX_POOL_SIZE} api_only=true`
    );
  }

  const publishKeywordNote = async ({
    status,
    metrics = null,
    error = null,
  }) => {
    if (!sessionId) return;
    const m =
      metrics ??
      (status === "started"
        ? null
        : await loadTaskWorkNoteMetrics(task.id));
    try {
      await publishWorkLiveFromWorker(sessionId, {
        type: "work_note_keyword_summary",
        data: {
          taskId: task.id,
          time: new Date().toISOString(),
          keyword: taskKeyword || payload.keyword || "",
          platform: taskPlatformSlug,
          reasonText: keywordReason || "该关键词更贴近当前 campaign 的目标受众方向。",
          searchFoundCount: m?.searchFoundCount ?? null,
          profileBrowsedCount: m?.profileBrowsedCount ?? null,
          analyzedCount: m?.analyzedCount ?? null,
          recommendedCount: m?.recommendedCount ?? null,
          contactableCount: m?.contactableCount ?? null,
          skipCountryUnknownCount: m?.skipCountryUnknownCount ?? null,
          skipCountryMismatchCount: m?.skipCountryMismatchCount ?? null,
          status,
          error: error ? String(error).slice(0, 180) : null,
        },
      });
    } catch {
      // ignore work-note publish errors
    }
  };

  let progressPublishTimer = null;
  const scheduleKeywordProgressPublish = () => {
    if (!sessionId) return;
    if (progressPublishTimer) clearTimeout(progressPublishTimer);
    progressPublishTimer = setTimeout(async () => {
      progressPublishTimer = null;
      try {
        const metrics = await loadTaskWorkNoteMetrics(task.id);
        await publishKeywordNote({ status: "started", metrics });
      } catch {
        /* ignore */
      }
    }, 1500);
  };
  const clearKeywordProgressPublish = () => {
    if (progressPublishTimer) {
      clearTimeout(progressPublishTimer);
      progressPublishTimer = null;
    }
  };

  await publishKeywordNote({ status: "started" });

  let onStepUpdate = null;
  if (sessionId) {
    const source = {
      workerId: platformWorkerId,
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

  if (!taskKeyword) {
    const error = "missing_task_keyword";
    await markTaskStatus(task.id, "failed", error);
    await upsertKeywordRunResult({
      campaignId,
      sessionId,
      runId: runId || `${campaignId}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
      taskId: task.id,
      keyword: "(missing_task_keyword)",
      keywordType: taskKeywordType,
      platform: taskPlatformSlug,
      workerId: platformWorkerId,
      workerHost: CURRENT_WORKER_HOST,
      workerIp: CURRENT_WORKER_IP,
      metrics: { failCount: 1, failReason: error, elapsedMs: Date.now() - taskStartMs },
    });
    await publishKeywordNote({
      status: "failed",
      error,
    });
    return;
  }

  const { searchAndExtractInfluencers } = await import(
    "../lib/tools/influencer-functions/search-and-extract-influencers.js"
  );
  const kwResult = { success: true, search_queries: [taskKeyword] };

  const defaultTarget = Math.max(influencersPerDay * 2, 10);
  const target = requestedBatch > 0 ? requestedBatch : defaultTarget;
  const searchPoolMax = Math.max(
    target,
    Number(process.env.SEARCH_MAX_POOL_SIZE || 500)
  );
  let result = null;
  try {
    if (taskPlatformSlug === "tiktok") {
      try {
        const { resetLitePageNavStats } = await import(
          "../lib/tools/influencer-functions/tiktok/lite-page-nav.js"
        );
        resetLitePageNavStats();
      } catch {
        /* ignore */
      }
      // 任务前端点预检：探测 9222 base + 9223/9224/9225 enrich 代理，
      // 发现死节点自动触发重建（重建逻辑带冷却），然后继续执行任务。
      if (String(process.env.TT_ENDPOINT_PREFLIGHT ?? "1").trim() !== "0") {
        try {
          const { preflightTikTokEndpoints } = await import(
            "../lib/ops/tiktok-endpoint-pool.js"
          );
          const pf = await preflightTikTokEndpoints({ timeoutMs: 25000 });
          console.log(
            `[worker-influencer-search] tiktok endpoint preflight ok=${pf.ok} ` +
              JSON.stringify(pf.results)
          );
        } catch (e) {
          console.warn(
            `[worker-influencer-search] tiktok endpoint preflight error: ${e.message}`
          );
        }
      }
    }
    const primaryKeyword =
      taskKeyword ||
      (Array.isArray(kwResult.search_queries) ? kwResult.search_queries[0] : null) ||
      null;

    result = await searchAndExtractInfluencers(
      {
        keywords: { search_queries: kwResult.search_queries },
        platform: taskPlatformSlug,
        platforms: campaignPlatforms,
        countries: resolveAllowedCountriesFromCampaign(campaignInfo),
        productInfo,
        campaignInfo,
        influencerProfile,
        campaignId,
      },
      {
        maxResults: searchPoolMax,
        maxEnrichCount: searchPoolMax,
        enrichProfileData: true,
        platform: taskPlatformSlug,
        taskId: task.id,
        runId: runId || null,
        searchKeyword: primaryKeyword,
        platform: taskPlatformSlug,
        workerIp: CURRENT_WORKER_IP,
        workerHost: CURRENT_WORKER_HOST,
        onStepUpdate,
        onTaskProgress: scheduleKeywordProgressPublish,
      }
    );
  } catch (err) {
    clearKeywordProgressPublish();
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
      platform: taskPlatformSlug,
      workerId: platformWorkerId,
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
    await consumeSignalForCompletedTask({
      campaignId,
      platform: taskPlatformSlug,
      keyword: taskKeyword || kwResult.search_queries?.[0] || null,
      taskId: task.id,
    });
    return;
  } finally {
    clearKeywordProgressPublish();
  }

  if (result?.success && Array.isArray(result.influencers)) {
    const isEmptySearch =
      result.skippedReason === "no_search_results" ||
      (Number(
        result?.stats?.searchChannelCount ?? result?.stats?.influencerCount ?? 0
      ) === 0 &&
        (result.influencers?.length ?? 0) === 0);

    if (isEmptySearch) {
      console.log(
        `[worker-influencer-search] 任务完成（搜索无结果）id=${task.id}, campaign=${campaignId}`
      );
      await markTaskStatus(task.id, "succeeded", null);
      await upsertKeywordRunResult({
        campaignId,
        sessionId,
        runId: runId || `${campaignId}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
        taskId: task.id,
        keyword: taskKeyword || kwResult.search_queries?.[0] || "(auto)",
        keywordType: taskKeywordType,
        platform: taskPlatformSlug,
        workerId: platformWorkerId,
        workerHost: CURRENT_WORKER_HOST,
        workerIp: CURRENT_WORKER_IP,
        metrics: {
          searchCount: 0,
          enrichSuccessCount: 0,
          analyzeRecommendedCount: 0,
          insertCandidateCount: 0,
          failCount: 0,
          skipReason: "no_search_results",
          elapsedMs: Date.now() - taskStartMs,
        },
      });
      await publishKeywordNote({
        status: "finished",
        metrics: {
          searchFoundCount: 0,
          profileBrowsedCount: 0,
          analyzedCount: 0,
          recommendedCount: 0,
          contactableCount: 0,
          skipCountryUnknownCount: 0,
          skipCountryMismatchCount: 0,
        },
      });
      await consumeSignalForCompletedTask({
        campaignId,
        platform: taskPlatformSlug,
        keyword: taskKeyword || kwResult.search_queries?.[0] || null,
        taskId: task.id,
      });
      return;
    }

    console.log(
      `[worker-influencer-search] 任务完成 id=${task.id}, campaign=${campaignId}`
    );
    try {
      const { getLitePageNavStats } = await import(
        "../lib/tools/influencer-functions/tiktok/lite-page-nav.js"
      );
      console.log(
        `[worker-influencer-search] lite-page-nav`,
        JSON.stringify(getLitePageNavStats())
      );
    } catch {
      /* ignore */
    }
    const taskMetrics = mergeSearchTaskMetrics(
      await loadTaskWorkNoteMetrics(task.id),
      deriveSearchTaskMetricsFromResult(result)
    );
    await setSearchTaskFinalMetrics(task.id, taskMetrics);
    await markTaskStatus(task.id, "succeeded", null);
    console.log(
      `[worker-influencer-search] 任务指标 id=${task.id}:`,
      JSON.stringify(taskMetrics)
    );
    await upsertKeywordRunResult({
      campaignId,
      sessionId,
      runId: runId || `${campaignId}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
      taskId: task.id,
      keyword: taskKeyword || kwResult.search_queries?.[0] || "(auto)",
      keywordType: taskKeywordType,
      platform: taskPlatformSlug,
      workerId: platformWorkerId,
      workerHost: CURRENT_WORKER_HOST,
      workerIp: CURRENT_WORKER_IP,
      metrics: {
        searchCount: taskMetrics.searchFoundCount,
        enrichSuccessCount: taskMetrics.profileBrowsedCount,
        analyzeRecommendedCount: taskMetrics.recommendedCount,
        insertCandidateCount: taskMetrics.analyzedCount,
        failCount: 0,
        elapsedMs: Date.now() - taskStartMs,
      },
    });
    await publishKeywordNote({ status: "finished", metrics: taskMetrics });
    await consumeSignalForCompletedTask({
      campaignId,
      platform: taskPlatformSlug,
      keyword: taskKeyword || kwResult.search_queries?.[0] || null,
      taskId: task.id,
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
  const taskMetricsFail = await loadTaskWorkNoteMetrics(task.id);
  await upsertKeywordRunResult({
    campaignId,
    sessionId,
    runId: runId || `${campaignId}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
    taskId: task.id,
      keyword: taskKeyword || kwResult.search_queries?.[0] || "(auto)",
      keywordType: taskKeywordType,
      platform: taskPlatformSlug,
      workerId: platformWorkerId,
      workerHost: CURRENT_WORKER_HOST,
      workerIp: CURRENT_WORKER_IP,
      metrics: {
        searchCount: taskMetricsFail.searchFoundCount,
      enrichSuccessCount: taskMetricsFail.profileBrowsedCount,
      analyzeRecommendedCount: taskMetricsFail.recommendedCount,
      insertCandidateCount: taskMetricsFail.analyzedCount,
      failCount: 1,
      failReason: String(result?.error || "search_failed").slice(0, 255),
      elapsedMs: Date.now() - taskStartMs,
    },
  });
  await publishKeywordNote({
    status: "failed",
    metrics: taskMetricsFail,
    error: String(result?.error || "search_failed"),
  });
  await consumeSignalForCompletedTask({
    campaignId,
    platform: taskPlatformSlug,
    keyword: taskKeyword || kwResult.search_queries?.[0] || null,
    taskId: task.id,
  });
}

const IMPORT_WORKER_ID = `import-worker-${workerIpToken()}`;

async function claimOnePendingImportTask() {
  const slots = resolveSearchWorkerSlots();
  if ((await countProcessingOnWorkerIp()) >= slots) return null;

  // 勿在 ORDER BY 扫描中带 payload（大名单 JSON 会触发 Out of sort memory）
  const rows = await queryTikTok(
    `
    SELECT id, campaign_id, session_id, import_batch_id,
           skipped_duplicate_count, parse_error_count
    FROM tiktok_influencer_import_task
    WHERE status = 'pending'
    ORDER BY priority DESC, id ASC
    LIMIT 5
  `,
    []
  );
  if (!rows?.length) return null;

  for (const row of rows) {
    const updateResult = await queryTikTok(
      `
      UPDATE tiktok_influencer_import_task
      SET status = 'processing',
          worker_id = ?,
          worker_host = ?,
          worker_ip = ?,
          attempt_count = attempt_count + 1,
          started_at = COALESCE(started_at, NOW()),
          last_progress_at = NOW(),
          updated_at = NOW()
      WHERE id = ? AND status = 'pending'
    `,
      [IMPORT_WORKER_ID, CURRENT_WORKER_HOST, CURRENT_WORKER_IP, row.id]
    );
    if (updateResult && Number(updateResult.affectedRows || 0) > 0) {
      const payloadRows = await queryTikTok(
        `SELECT payload FROM tiktok_influencer_import_task WHERE id = ? LIMIT 1`,
        [row.id]
      );
      return {
        ...row,
        payload: parseJsonOrObject(payloadRows?.[0]?.payload) || {},
      };
    }
  }
  return null;
}

async function markImportTaskStatus(id, status, errorMessage = null) {
  await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET status = ?,
        error_message = ?,
        finished_at = NOW(),
        updated_at = NOW()
    WHERE id = ?
  `,
    [status, errorMessage, id]
  );
}

async function processImportTaskRow(task) {
  const { processInfluencerImportTask } = await import(
    "../lib/influencer/process-import-task.js"
  );
  try {
    const result = await processInfluencerImportTask(task, {});
    if (!result?.success) {
      await markImportTaskStatus(task.id, "failed", "processInfluencerImportTask failed");
    }
  } catch (err) {
    console.error(
      `[worker-influencer-search] import task ${task.id} error:`,
      err?.message || err
    );
    await markImportTaskStatus(
      task.id,
      "failed",
      String(err?.message || err).slice(0, 500)
    );
  }
}

async function reclaimStuckProcessingImportTasks() {
  const stuckMinutes = Math.min(
    24 * 60,
    Math.max(1, Number(process.env.IMPORT_TASK_STUCK_RECLAIM_MINUTES) || 7)
  );
  const rows = await queryTikTok(
    `
    UPDATE tiktok_influencer_import_task
    SET status = 'failed',
        finished_at = NOW(),
        error_message = ?,
        updated_at = NOW()
    WHERE status = 'processing'
      AND last_progress_at IS NOT NULL
      AND last_progress_at < DATE_SUB(NOW(), INTERVAL ${stuckMinutes} MINUTE)
  `,
    [`stuck_reclaimed(import_last_progress>${stuckMinutes}m)`]
  );
  return Number(rows?.affectedRows || 0);
}

async function importTaskLoop() {
  const idleSleepMs = Math.max(
    Number(process.env.SEARCH_WORKER_IDLE_SLEEP_MS || 3000) || 3000,
    500
  );
  let lastReclaimMs = 0;

  console.log(
    `[worker-influencer-search][import] loop workerId=${IMPORT_WORKER_ID} ip=${CURRENT_WORKER_IP || "unknown"}`
  );

  for (;;) {
    try {
      if (Date.now() - lastReclaimMs > 60_000) {
        lastReclaimMs = Date.now();
        const n = await reclaimStuckProcessingImportTasks();
        if (n > 0) {
          console.warn(`[worker-influencer-search] reclaimed stuck import tasks: ${n}`);
        }
      }

      const task = await claimOnePendingImportTask();
      if (!task) {
        await sleep(idleSleepMs);
        continue;
      }

      console.log(
        `[worker-influencer-search][import] 开始 task=${task.id} campaign=${task.campaign_id} batch=${task.import_batch_id}`
      );

      await runInCdpLoop(
        {
          platform: "mixed",
          persistentPlatforms: ["instagram", "youtube"],
          taskId: task.id,
          workerId: IMPORT_WORKER_ID,
          kind: "import",
        },
        () => processImportTaskRow(task)
      );

    } catch (err) {
      console.error(
        `[worker-influencer-search][import] loop error:`,
        err?.message || err
      );
      await sleep(idleSleepMs);
    }
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function reclaimStuckProcessingTasks() {
  const stuckMinutes = Math.min(
    24 * 60,
    Math.max(1, Number(process.env.SEARCH_TASK_STUCK_RECLAIM_MINUTES) || 7)
  );
  // 仅按 last_progress_at 判断：超过 N 分钟无推进则回收（默认 7 分钟）
  const rows = await queryTikTok(
    `
    UPDATE tiktok_influencer_search_task
    SET status = 'failed',
        finished_at = NOW(),
        error_message = ?,
        updated_at = NOW()
    WHERE status = 'processing'
      AND last_progress_at IS NOT NULL
      AND last_progress_at < DATE_SUB(NOW(), INTERVAL ${stuckMinutes} MINUTE)
  `,
    [`stuck_reclaimed(last_progress_at>${stuckMinutes}m)`]
  );
  return Number(rows?.affectedRows || 0);
}

async function platformLoop(platformSlug) {
  const platformWorkerId = workerIdForPlatform(platformSlug);
  const idleSleepMs = Math.max(
    Number(process.env.SEARCH_WORKER_IDLE_SLEEP_MS || 3000) || 3000,
    500
  );
  let lastReclaimMs = 0;

  console.log(
    `[worker-influencer-search][${platformSlug}] loop workerId=${platformWorkerId} ip=${CURRENT_WORKER_IP || "unknown"}`
  );

  for (;;) {
    try {
      if (Date.now() - lastReclaimMs > 60_000) {
        lastReclaimMs = Date.now();
        const n = await reclaimStuckProcessingTasks();
        if (n > 0) {
          console.warn(
            `[worker-influencer-search] reclaimed stuck processing tasks: ${n}`
          );
        }
      }

      const task = await claimOnePendingTaskForPlatform(
        platformSlug,
        platformWorkerId
      );
      if (!task) {
        await sleep(idleSleepMs);
        continue;
      }

      await runInCdpLoop(
        { platform: platformSlug, taskId: task.id, workerId: platformWorkerId },
        () => processTask(task, platformSlug)
      );

    } catch (err) {
      console.error(
        `[worker-influencer-search][${platformSlug}] 处理任务时出错：`,
        err?.message || err
      );
      await sleep(idleSleepMs);
    }
  }
}

async function main() {
  const slots = resolveSearchWorkerSlots();
  const platforms = resolveWorkerPlatforms();
  const loopMode = String(process.env.SEARCH_WORKER_LOOP || "true") !== "false";
  const forcedTaskId = Number(process.env.SEARCH_TASK_ID || 0);
  const forceClaimTask = process.env.SEARCH_TASK_FORCE_CLAIM === "1";

  console.log(
    `[worker-influencer-search] 启动 host=${CURRENT_WORKER_HOST || "unknown"} ip=${CURRENT_WORKER_IP || "unknown"} slots=${slots} platforms=${platforms.join(",")} cdp9222=${resolveCdp9222Mode()} parallel=${isCdp9222Parallel()} loop=${loopMode}${forcedTaskId ? ` taskId=${forcedTaskId}` : ""}`
  );

  if (!loopMode) {
    let task = null;
    if (forcedTaskId > 0) {
      const rows = await queryTikTok(
        `
        SELECT id, campaign_id, session_id, run_id, keyword, keyword_type, payload, status
        FROM tiktok_influencer_search_task
        WHERE id = ?
        LIMIT 1
      `,
        [forcedTaskId]
      );
      const row = rows?.[0];
      if (!row) {
        console.error(`[worker-influencer-search] 未找到任务 id=${forcedTaskId}`);
        return;
      }
      if (row.status !== "pending" && !forceClaimTask) {
        console.error(
          `[worker-influencer-search] 任务 id=${forcedTaskId} 状态=${row.status}，非 pending`
        );
        return;
      }
      const payload = parseJsonOrObject(row.payload) || {};
      const taskPlatform = taskPlatformFromPayload(payload);
      if (!taskPlatform) {
        await markTaskStatus(forcedTaskId, "failed", "missing payload.platform");
        return;
      }
      const platformWorkerId = workerIdForPlatform(taskPlatform);
      const claim = await queryTikTok(
        `
        UPDATE tiktok_influencer_search_task
        SET status = 'processing',
            worker_id = ?,
            worker_host = ?,
            worker_ip = ?,
            last_progress_at = NOW(),
            progress_search_found_count = 0,
            progress_profile_browsed_count = 0,
            progress_analyzed_count = 0,
            progress_recommended_count = 0,
            progress_contactable_count = 0,
            progress_skip_country_unknown_count = 0,
            progress_skip_country_mismatch_count = 0,
            started_at = NOW(),
            attempt_count = attempt_count + 1,
            updated_at = NOW()
        WHERE id = ?${forceClaimTask ? "" : " AND status = 'pending'"}
      `,
        [platformWorkerId, CURRENT_WORKER_HOST, CURRENT_WORKER_IP, forcedTaskId]
      );
      if (!claim?.affectedRows) {
        console.error(`[worker-influencer-search] claim 失败 id=${forcedTaskId}`);
        return;
      }
      task = row;
      await runInCdpLoop(
        { platform: taskPlatform, taskId: task.id, workerId: platformWorkerId },
        () => processTask(task, taskPlatform)
      );
      return;
    }

    const p = platforms[0] || "tiktok";
    task = await claimOnePendingTaskForPlatform(p, workerIdForPlatform(p));
    if (task) {
      await runInCdpLoop(
        { platform: p, taskId: task.id, workerId: workerIdForPlatform(p) },
        () => processTask(task, p)
      );
    }
    return;
  }

  await Promise.all([
    ...platforms.map((platformSlug) => platformLoop(platformSlug)),
    ...(isSearchImportTaskLoopEnabled() ? [importTaskLoop()] : []),
  ]);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[worker-influencer-search] 运行出错：", err?.message || err);
    process.exit(1);
  });
