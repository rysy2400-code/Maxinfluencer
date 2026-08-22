/**
 * Scraper Worker：从 tiktok_influencer_search_task 消费任务并执行补货。
 */

import dotenv from "dotenv";
import fs from "node:fs";
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
import { notifyImportBatchOrSession } from "../lib/influencer/import-batch-coordinator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// 加载环境变量（.env 再 .env.local）
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });
// Affiliate GMV 依赖 9222 登录 partner 后台，当前未登录必然失败；
// 在进程启动即关闭，覆盖搜索 worker 与导入 worker（import 路径不经过 applyTiktokLiteProductionDefaults）。
setDefaultEnv("AFFILIATE_GMV_ENRICH", "0");

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
  // item_list 同 tab 只试 1 次 + 20s 求值超时：失败快速交给“新 tab / 换 IP + 新 tab”恢复，
  // 避免卡死 tab 上的队列把单红人 120s 预算吃光（预算不足时中途换 IP 永远无法触发）。
  setDefaultEnv("TT_LITE_POST_ITEM_RETRIES", "1");
  setDefaultEnv("TT_LITE_API_EVAL_TIMEOUT_MS", "20000");
  setDefaultEnv("TT_LITE_HOMEPAGE_TIMEOUT_MS", "20000");
  setDefaultEnv("TT_LITE_EMPTY_ITEMS_COOLDOWN_MS", "0");
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

/** 任务失败冷却：只对“搜索经换 IP 重试仍失败”生效，30min，持久化到 config（worker 重启后仍生效） */
function workerPortSuffix() {
  return String(process.env.SEARCH_WORKER_ID_SUFFIX || "").trim();
}
function workerCooldownFile() {
  const suffix = workerPortSuffix();
  return suffix ? path.join(projectRoot, "config", `tt-worker-cooldown-${suffix}.json`) : null;
}
function readWorkerCooldown() {
  const fp = workerCooldownFile();
  if (!fp) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}
function workerCooldownRemainingMs() {
  const cd = readWorkerCooldown();
  return cd && Number.isFinite(cd.untilEpochMs) ? Math.max(0, cd.untilEpochMs - Date.now()) : 0;
}
function setWorkerCooldown(reason, taskId, minutes = 30) {
  const fp = workerCooldownFile();
  if (!fp) return;
  try {
    const cd = {
      untilEpochMs: Date.now() + minutes * 60 * 1000,
      reason,
      taskId,
      setAt: new Date().toISOString(),
    };
    fs.writeFileSync(fp, JSON.stringify(cd, null, 2), "utf8");
    console.warn(
      `[worker-influencer-search] 写入失败冷却 ${minutes}min（${fp}）reason=${reason} task=${taskId}`
    );
  } catch (e) {
    console.warn(`[worker-influencer-search] 写入冷却失败: ${e?.message || e}`);
  }
}
function clearWorkerCooldown() {
  const fp = workerCooldownFile();
  if (!fp) return;
  try {
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      console.log("[worker-influencer-search] 任务成功，清除失败冷却");
    }
  } catch (e) {
    console.warn(`[worker-influencer-search] 清除冷却失败: ${e?.message || e}`);
  }
}

/** 搜索阶段失败时轮换 tk-ip IP（0 数据流量），并标记会话需重新准入探测 */
async function rotateTkIpForSearchRetry(label) {
  try {
    const { rotateTkIpSession, resolveTkIpProxyPort, getTkIpSessionState } = await import(
      "../lib/ops/tiktok-session-manager.js"
    );
    const rot = await rotateTkIpSession(resolveTkIpProxyPort());
    if (rot?.ok) {
      const st = getTkIpSessionState(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222");
      st.healthy = false;
      st.checkedAt = 0;
      st.forceFresh = true;
      console.warn(
        `[worker-influencer-search] ${label} 轮换 IP ok sid=${rot.sid || "-"} ip=${rot.ip || "-"}`
      );
      return true;
    }
    console.warn(`[worker-influencer-search] ${label} 轮换未生效: ${rot?.error || "skipped"}`);
    return false;
  } catch (e) {
    console.warn(`[worker-influencer-search] ${label} 轮换异常: ${e?.message || e}`);
    return false;
  }
}

/** 判断异常是否属于搜索阶段（避免 enrich/国家环节的异常也触发换 IP 重试） */
function isSearchStageFailureMsg(msg) {
  return /未获取到数据|general search|search\/general\/full|EMPTY|CDP timeout|Runtime\.evaluate|Failed to fetch|tiktok_api_session_unavailable|无结果/i.test(
    String(msg || "")
  );
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
  const suffix = String(process.env.SEARCH_WORKER_ID_SUFFIX || "").trim();
  return `search-worker-${workerIpToken()}${suffix ? `-${suffix}` : ""}-${platformSlug}`;
}

function resolveSearchWorkerSlots() {
  // 每端口同一时刻只执行 1 个任务（搜索/导入互斥，见 portTaskLock），
  // 机器上限 = 端口数 4。
  return Math.min(4, Math.max(1, Number(process.env.SEARCH_WORKER_SLOTS) || 1));
}

/**
 * 每端口任务锁：同一 worker 进程内，搜索循环与导入循环互斥使用该端口浏览器。
 * 保证单个浏览器端口同一时期只执行 1 个任务（搜索或导入）。
 */
const portTaskLock = { busy: false, owner: null };
async function acquirePortTaskLock(owner) {
  while (portTaskLock.busy) {
    await sleep(1000);
  }
  portTaskLock.busy = true;
  portTaskLock.owner = owner;
}
function releasePortTaskLock() {
  portTaskLock.busy = false;
  portTaskLock.owner = null;
}

function withTaskTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timeout ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function resolveSearchTaskTimeoutMs() {
  return Math.max(
    60_000,
    Number(process.env.SEARCH_TASK_TIMEOUT_MS || 20 * 60 * 1000)
  );
}

function resolveWorkerPlatforms() {
  const raw = process.env.SEARCH_WORKER_PLATFORMS || "tiktok,instagram,youtube";
  return raw
    .split(",")
    .map((s) => normalizePlatformSlug(s.trim()))
    .filter(Boolean);
}

/**
 * 导入任务认领平台：worker 平台 + 遗留 mixed 兜底（仅 tiktok 角色认领 mixed）
 * @param {string[]} [platforms]
 */
function importClaimPlatforms(platforms) {
  const base = Array.isArray(platforms) ? platforms : resolveWorkerPlatforms();
  const set = new Set(base);
  if (set.has("tiktok")) set.add("mixed");
  return [...set];
}

/**
 * @param {string[]} platforms
 * @returns {{ sql: string, params: string[] }}
 */
function buildImportPlatformFilter(platforms) {
  const list = importClaimPlatforms(platforms);
  if (!list.length) return { sql: "1 = 0", params: [] };
  const placeholders = list.map(() => "?").join(", ");
  return { sql: `platform IN (${placeholders})`, params: list };
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

/** 有本平台 pending 导入任务时，搜索 loop 让出 slot 给 importTaskLoop（与 DB priority 150>100 一致） */
async function hasPendingImportTask(platforms) {
  if (!isSearchImportTaskLoopEnabled()) return false;
  const { sql, params } = buildImportPlatformFilter(platforms);
  const rows = await queryTikTok(
    `
    SELECT id FROM tiktok_influencer_import_task
    WHERE status = 'pending' AND ${sql}
    LIMIT 1
  `,
    params
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
  if (await hasPendingImportTask([platformSlug])) return null;

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
  let searchIpRetriesExhausted = false;
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

    // 搜索失败 → 轮换 IP 重试（最多 TT_SEARCH_IP_RETRIES 次，默认 2），
    // 换 IP 本身 0 数据流量；仍失败才判任务失败并进入 30min 冷却。
    const maxSearchIpRetries = Math.max(
      0,
      Number(process.env.TT_SEARCH_IP_RETRIES ?? 2) || 0
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
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
      } catch (searchErr) {
        if (attempt >= maxSearchIpRetries || !isSearchStageFailureMsg(searchErr?.message || searchErr)) {
          if (attempt >= maxSearchIpRetries) searchIpRetriesExhausted = true;
          throw searchErr;
        }
        console.warn(
          `[worker-influencer-search] 搜索异常（${String(searchErr?.message || searchErr).slice(0, 140)}），轮换 IP 重试 ${attempt + 1}/${maxSearchIpRetries}`
        );
        await rotateTkIpForSearchRetry("搜索异常重试");
        await sleep(3000);
        continue;
      }
      if (result?.success) break;
      if (attempt >= maxSearchIpRetries) {
        searchIpRetriesExhausted = true;
        break;
      }
      console.warn(
        `[worker-influencer-search] 搜索未成功（${String(result?.error || "no_data").slice(0, 140)}），轮换 IP 重试 ${attempt + 1}/${maxSearchIpRetries}`
      );
      await rotateTkIpForSearchRetry("搜索空结果重试");
      await sleep(3000);
    }
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
    if (searchIpRetriesExhausted) {
      setWorkerCooldown(
        "search_ip_retries_exhausted",
        task.id,
        Number(process.env.TT_WORKER_FAIL_COOLDOWN_MIN ?? 10)
      );
    }
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
    clearWorkerCooldown();
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
    clearWorkerCooldown();
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
  if (searchIpRetriesExhausted) {
    setWorkerCooldown(
      "search_ip_retries_exhausted",
      task.id,
      Number(process.env.TT_WORKER_FAIL_COOLDOWN_MIN ?? 10)
    );
  }
  await consumeSignalForCompletedTask({
    campaignId,
    platform: taskPlatformSlug,
    keyword: taskKeyword || kwResult.search_queries?.[0] || null,
    taskId: task.id,
  });
}

const IMPORT_WORKER_ID = `import-worker-${workerIpToken()}`;

async function claimOnePendingImportTask(platforms) {
  const slots = resolveSearchWorkerSlots();
  if ((await countProcessingOnWorkerIp()) >= slots) return null;
  const { sql, params } = buildImportPlatformFilter(platforms);

  // 勿在 ORDER BY 扫描中带 payload（大名单 JSON 会触发 Out of sort memory）
  const rows = await queryTikTok(
    `
    SELECT id, campaign_id, session_id, import_batch_id,
           batch_group_id, skipped_duplicate_count, parse_error_count
    FROM tiktok_influencer_import_task
    WHERE status = 'pending' AND ${sql}
    ORDER BY priority DESC, id ASC
    LIMIT 5
  `,
    params
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
    await notifyImportBatchOrSession({ task, fallbackSummary: null }).catch((e) => {
      console.warn(
        `[worker-influencer-search] import task ${task.id} 批次汇报失败:`,
        e?.message || e
      );
    });
  }
}

async function reclaimStuckProcessingImportTasks() {
  const stuckMinutes = Math.min(
    24 * 60,
    Math.max(1, Number(process.env.IMPORT_TASK_STUCK_RECLAIM_MINUTES) || 12)
  );
  const stuckRows = await queryTikTok(
    `
    SELECT id, campaign_id, session_id, batch_group_id
    FROM tiktok_influencer_import_task
    WHERE status = 'processing'
      AND last_progress_at IS NOT NULL
      AND last_progress_at < DATE_SUB(NOW(), INTERVAL ${stuckMinutes} MINUTE)
  `,
    []
  );
  if (!stuckRows?.length) return 0;
  const errorMessage = `stuck_reclaimed(import_last_progress>${stuckMinutes}m)`;
  await queryTikTok(
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
    [errorMessage]
  );
  for (const r of stuckRows) {
    await notifyImportBatchOrSession({ task: r, fallbackSummary: null }).catch((e) => {
      console.warn(
        `[worker-influencer-search] 回收任务 ${r.id} 批次汇报失败:`,
        e?.message || e
      );
    });
  }
  return stuckRows.length;
}

async function importTaskLoop() {
  const idleSleepMs = Math.max(
    Number(process.env.SEARCH_WORKER_IDLE_SLEEP_MS || 3000) || 3000,
    500
  );
  let lastReclaimMs = 0;

  console.log(
    `[worker-influencer-search][import] loop workerId=${IMPORT_WORKER_ID} ip=${CURRENT_WORKER_IP || "unknown"} platforms=${importClaimPlatforms().join(",")}`
  );

  for (;;) {
    try {
      // 注意：搜索失败冷却只作用于搜索循环（platformLoop），
      // 不阻塞导入循环——导入走 item_list/user_detail，且自带换 IP 恢复链，
      // 搜索 API 被风控时导入仍可正常消费。
      if (Date.now() - lastReclaimMs > 60_000) {
        lastReclaimMs = Date.now();
        const n = await reclaimStuckProcessingImportTasks();
        if (n > 0) {
          console.warn(`[worker-influencer-search] reclaimed stuck import tasks: ${n}`);
        }
      }

      // 每端口任务锁：与搜索循环互斥，同一端口同一时刻只执行 1 个任务。
      await acquirePortTaskLock("import");
      let task = null;
      try {
        task = await claimOnePendingImportTask(importClaimPlatforms());
        if (task) {
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
        }
      } finally {
        releasePortTaskLock();
      }
      if (!task) {
        await sleep(idleSleepMs);
        continue;
      }

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

  // 重启后清理本 worker 名下残留的 processing 任务（上次进程中断的孤儿任务），
  // 避免 hasInflightForPlatform 阻塞新任务认领、任务永久卡 processing。
  try {
    const released = await queryTikTok(
      `UPDATE tiktok_influencer_search_task
       SET status='pending', worker_id=NULL, worker_ip=NULL, worker_host=NULL, started_at=NULL
       WHERE status='processing' AND worker_id=? AND worker_ip=? AND last_progress_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`,
      [platformWorkerId, CURRENT_WORKER_IP]
    );
    if (Number(released?.affectedRows || 0) > 0) {
      console.warn(
        `[worker-influencer-search] 启动清理本 worker 孤儿 processing 任务: ${released.affectedRows}`
      );
    }
  } catch (e) {
    console.warn(
      `[worker-influencer-search] 启动孤儿任务清理失败: ${e?.message || e}`
    );
  }

  for (;;) {
    try {
      // 搜索失败冷却：仅“搜索经换 IP 重试仍失败”触发（30min，持久化），
      // 冷却期间搜索/导入均不认领任务，避免坏状态端口持续消耗任务。
      const cdRemain = workerCooldownRemainingMs();
      if (cdRemain > 0) {
        console.warn(
          `[worker-influencer-search] 搜索失败冷却中，剩余 ${Math.round(cdRemain / 1000)}s，暂不认领任务`
        );
        await sleep(Math.min(30000, cdRemain));
        continue;
      }

      if (Date.now() - lastReclaimMs > 60_000) {
        lastReclaimMs = Date.now();
        const n = await reclaimStuckProcessingTasks();
        if (n > 0) {
          console.warn(
            `[worker-influencer-search] reclaimed stuck processing tasks: ${n}`
          );
        }
      }

      // 每端口任务锁：搜索循环与导入循环互斥，同一端口同一时刻只执行 1 个任务。
      await acquirePortTaskLock("search");
      let task = null;
      let portReady = true;
      try {
        // tk-ip 会话准入：任务认领前确保出口 IP 能出数据（综合搜索探测），
        // 不合格自动轮换；全失败则冷却后重试，不认领任务避免浪费。
        if (
          platformSlug === "tiktok" &&
          String(process.env.TT_TKIP_SESSION_MANAGER ?? "1").trim() !== "0"
        ) {
          try {
            const { ensureTkIpSessionHealthy, resolveTkIpProxyPort } = await import(
              "../lib/ops/tiktok-session-manager.js"
            );
            const cdp = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
            const health = await withTaskTimeout(
              ensureTkIpSessionHealthy(cdp, { proxyPort: resolveTkIpProxyPort() }),
              150000,
              "tkip-session-health"
            );
            if (health?.ok === false) {
              console.warn(
                `[worker-influencer-search] tiktok 会话准入失败（${health.reason || "no-clean-ip"}），冷却 30s 后重试`
              );
              await sleep(30000);
              portReady = false;
            }
          } catch (e) {
            console.warn(
              `[worker-influencer-search] tiktok 会话准入异常（跳过本轮）: ${e?.message || e}`
            );
          }
        }

        if (portReady) {
          task = await claimOnePendingTaskForPlatform(
            platformSlug,
            platformWorkerId
          );
        }
        if (task) {
          try {
            await runInCdpLoop(
              { platform: platformSlug, taskId: task.id, workerId: platformWorkerId },
              () =>
                withTaskTimeout(
                  processTask(task, platformSlug),
                  resolveSearchTaskTimeoutMs(),
                  `task:${task.id}`
                )
            );
          } catch (err) {
            console.error(
              `[worker-influencer-search][${platformSlug}] 任务 ${task.id} 处理失败：`,
              err?.message || err
            );
            await markTaskStatus(
              task.id,
              "failed",
              `task_timeout_or_error: ${String(err?.message || err).slice(0, 140)}`
            ).catch(() => {});
          }

          // 任务边界轮换 tk-ip 会话（换 sid = 换 IP，0 流量），下一个任务用新 IP。
          if (
            platformSlug === "tiktok" &&
            String(process.env.TT_TKIP_SESSION_MANAGER ?? "1").trim() !== "0"
          ) {
            try {
              const { rotateTkIpSession, resolveTkIpProxyPort, getTkIpSessionState, cleanupTkIpTabs } = await import(
                "../lib/ops/tiktok-session-manager.js"
              );
              const rot = await withTaskTimeout(
                rotateTkIpSession(resolveTkIpProxyPort()),
                45000,
                "tkip-session-rotate"
              );
              if (rot?.skipped) {
                /* 非 tk-ip 配置，跳过 */
              } else {
                console.log(
                  `[worker-influencer-search] tiktok 会话轮换 ok=${rot?.ok} sid=${rot?.sid || "-"} ip=${rot?.ip || "-"}`
                );
                // 轮换后强制下一次认领前重新准入探测（新 IP 未验证）
                const st = getTkIpSessionState(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222");
                st.healthy = false;
                st.checkedAt = 0;
                st.forceFresh = true;
              }
              // 任务边界清理多余 tab（每个端口只保留 1 个 tiktok tab，防 renderer 累积）
              try {
                await cleanupTkIpTabs(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222", { keep: 1 });
              } catch (e) {
                console.warn(`[worker-influencer-search] tiktok tab cleanup 异常: ${e?.message || e}`);
              }
            } catch (e) {
              console.warn(
                `[worker-influencer-search] tiktok 会话轮换异常: ${e?.message || e}`
              );
            }
          }
        }
      } finally {
        releasePortTaskLock();
      }
      if (!task) {
        await sleep(idleSleepMs);
        continue;
      }

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
