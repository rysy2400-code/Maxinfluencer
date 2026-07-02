/**
 * 爬虫采集模式：standard（默认整页+滚动）| lite（直调 API、低流量）
 */

export function resolveScraperMode() {
  const m = String(process.env.SCRAPER_MODE || "standard").trim().toLowerCase();
  return m === "lite" ? "lite" : "standard";
}

export function isLiteScraperMode() {
  return resolveScraperMode() === "lite";
}

export function isLiteScreenshotsDisabled() {
  if (!isLiteScraperMode()) return false;
  const raw = String(process.env.LITE_DISABLE_SCREENSHOTS ?? "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0";
}

/** Lite enrich 阶段 Reels 截图（默认开启，与搜索截图开关独立） */
export function isLiteEnrichScreenshotsEnabled() {
  if (!isLiteScraperMode()) return true;
  const raw = String(process.env.LITE_ENRICH_SCREENSHOTS ?? "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0";
}

export function resolveLiteEnrichConcurrency(platform = "tiktok") {
  const key =
    platform === "youtube"
      ? "LITE_YT_ENRICH_CONCURRENCY"
      : platform === "instagram"
        ? "LITE_IG_ENRICH_CONCURRENCY"
        : platform === "tiktok"
          ? "LITE_TT_ENRICH_CONCURRENCY"
          : "LITE_ENRICH_CONCURRENCY";
  const fallback =
    platform === "instagram"
      ? 1
      : platform === "youtube"
        ? 1
        : platform === "tiktok"
          ? Number(process.env.LITE_ENRICH_CONCURRENCY) || 10
          : Number(process.env.LITE_ENRICH_CONCURRENCY) || 3;
  const n = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 10);
}

export function resolveLiteDelayBetweenBatches() {
  const min = Math.max(Number(process.env.LITE_BATCH_DELAY_MIN_MS) || 800, 0);
  const max = Math.max(Number(process.env.LITE_BATCH_DELAY_MAX_MS) || 2000, min);
  return { min, max };
}

function resolveEnvTriState(envKey, standardDefault) {
  const v = String(process.env[envKey] ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return standardDefault;
}

/** 国家检测上限：Lite 默认全搜索池；COUNTRY_BATCH_SIZE=0|all|full 也表示全池 */
export function resolveCountryBatchMax(searchPoolCount = 0) {
  const raw = String(process.env.COUNTRY_BATCH_SIZE ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "all" || raw === "full") {
    return Math.max(1, searchPoolCount);
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  if (isLiteScraperMode()) return Math.max(1, searchPoolCount);
  return 20;
}

/** 国家批次 0 明确符合即停：standard 默认开，Lite 默认关 */
export function resolveCountryStopOnZeroBatchMatch() {
  return resolveEnvTriState("COUNTRY_BATCH_STOP_ON_ZERO", !isLiteScraperMode());
}

/** enrich 批次 0 推荐即停：standard 默认开，Lite 默认关 */
export function resolveEnrichStopOnZeroMatch() {
  return resolveEnvTriState("ENRICH_BATCH_STOP_ON_ZERO", !isLiteScraperMode());
}

/** Lite CDP 标签池大小（api-only 默认 1 tab，并发任务 round-robin 复用） */
export function resolveLiteCdpTabPoolSize() {
  const n = Number(process.env.TT_LITE_TAB_POOL_SIZE ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 10);
}

export const PLATFORM_PIPELINE_ORDER = ["tiktok", "instagram", "youtube"];

/** @param {string} platform */
export function normalizePipelinePlatformSlug(platform) {
  const s = String(platform || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (s === "instagram" || s === "ig") return "instagram";
  if (s === "youtube" || s === "yt") return "youtube";
  if (s === "tiktok" || s === "tt") return "tiktok";
  if (s.includes("insta")) return "instagram";
  if (s.includes("you")) return "youtube";
  return "tiktok";
}

export function platformDisplayFromPipelineSlug(slug) {
  if (slug === "instagram") return "Instagram";
  if (slug === "youtube") return "YouTube";
  return "TikTok";
}

/**
 * 搜索 / 导入共用的 per-platform 流水线配置（Lite）
 * @param {'tiktok'|'instagram'|'youtube'|string} platformSlug
 */
export function resolvePlatformPipelineConfig(platformSlug = "tiktok") {
  const platform = normalizePipelinePlatformSlug(platformSlug);
  return {
    platform,
    enrichConcurrency: resolveLiteEnrichConcurrency(platform),
    countryConcurrency:
      platform === "tiktok"
        ? Math.max(
            1,
            Math.min(Number(process.env.TT_LITE_COUNTRY_CONCURRENCY || 10), 10)
          )
        : 1,
    tabPoolSize: resolveLiteCdpTabPoolSize(),
    enrichBatchPolicy: false,
    enrichStopOnZero: false,
    countryStopOnZero: false,
  };
}

function parseWorkerPlatformList(raw, fallback) {
  const src = String(raw ?? fallback).trim();
  if (!src) return ["tiktok"];
  return [
    ...new Set(
      src
        .split(",")
        .map((s) => normalizePipelinePlatformSlug(s.trim()))
        .filter(Boolean)
    ),
  ];
}

export function resolveSearchWorkerPlatforms() {
  return parseWorkerPlatformList(
    process.env.SEARCH_WORKER_PLATFORMS,
    "tiktok,instagram,youtube"
  );
}

export function resolveImportWorkerPlatforms() {
  return parseWorkerPlatformList(
    process.env.IMPORT_WORKER_PLATFORMS || process.env.SEARCH_WORKER_PLATFORMS,
    "tiktok,instagram,youtube"
  );
}
