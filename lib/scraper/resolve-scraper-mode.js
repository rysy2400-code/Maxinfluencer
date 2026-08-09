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

/** Lite enrich 阶段截图（默认关闭，对齐 API-only 低流量） */
export function isLiteEnrichScreenshotsEnabled() {
  if (!isLiteScraperMode()) return true;
  const raw = String(process.env.LITE_ENRICH_SCREENSHOTS ?? "false").trim().toLowerCase();
  return raw === "true" || raw === "1";
}

export function resolveLiteEnrichConcurrency(platform = "tiktok") {
  const key =
    platform === "youtube"
      ? "LITE_YT_ENRICH_CONCURRENCY"
      : platform === "instagram"
        ? "LITE_IG_ENRICH_CONCURRENCY"
        : platform === "x"
          ? "LITE_X_ENRICH_CONCURRENCY"
        : platform === "tiktok"
          ? "LITE_TT_ENRICH_CONCURRENCY"
          : "LITE_ENRICH_CONCURRENCY";
  const fallback =
    platform === "instagram"
      ? 10
      : platform === "youtube"
        ? 10
        : platform === "x"
          ? 1
        : platform === "tiktok"
          ? Number(process.env.LITE_ENRICH_CONCURRENCY) || 10
          : Number(process.env.LITE_ENRICH_CONCURRENCY) || 3;
  const n = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(n) || n < 1) return 1;
  const maxKey =
    platform === "youtube"
      ? "LITE_YT_ENRICH_CONCURRENCY_MAX"
      : platform === "instagram"
        ? "LITE_IG_ENRICH_CONCURRENCY_MAX"
        : platform === "x"
          ? "LITE_X_ENRICH_CONCURRENCY_MAX"
        : platform === "tiktok"
          ? "LITE_TT_ENRICH_CONCURRENCY_MAX"
          : "LITE_ENRICH_CONCURRENCY_MAX";
  const maxRaw = Number(process.env[maxKey] ?? process.env.LITE_ENRICH_CONCURRENCY_MAX ?? 10);
  const hardMax =
    platform === "youtube" ? 150 : platform === "x" ? 10 : 100;
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(Math.floor(maxRaw), hardMax) : 10;
  return Math.min(Math.floor(n), max);
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
  const explicit = process.env.TT_LITE_TAB_POOL_SIZE;
  const endpointCount = String(process.env.TT_LITE_ENRICH_CDP_ENDPOINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
  const fallback = endpointCount || 1;
  const n = Number(explicit ?? fallback);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 10);
}

/** YouTube Lite innertube 标签池（默认 1 tab + 多并发 API，对齐 TikTok TT_LITE_TAB_POOL_SIZE） */
export function resolveYtLiteTabPoolSize() {
  const n = Number(process.env.YT_LITE_TAB_POOL_SIZE ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 10);
}

/** YouTube Lite 标签页回收阈值：单个 tab 处理 N 个红人后重建新页（0=禁用回收） */
export function resolveYtLiteTabRecycleProfiles() {
  const n = Number(process.env.YT_LITE_TAB_RECYCLE_PROFILES ?? 0);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(Math.floor(n), 500);
}

/** Instagram Lite Bloks/API 标签池：默认 1 tab + 多并发 API */
export function resolveIgLiteTabPoolSize() {
  const endpointCount = String(process.env.IG_LITE_ENRICH_CDP_ENDPOINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean).length;
  const fallback = endpointCount || 1;
  const n = Number(process.env.IG_LITE_TAB_POOL_SIZE ?? fallback);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 10);
}

/**
 * YouTube Lite 单 tab 多并发时默认关闭 evaluate 锁（避免 Promise.all 被串行化）
 * 显式 YT_LITE_DISABLE_EVALUATE_LOCK=0 可恢复锁
 */
export function resolveYtLiteDisableEvaluateLock() {
  const v = String(process.env.YT_LITE_DISABLE_EVALUATE_LOCK ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return isLiteScraperMode();
}

/**
 * Instagram Lite 单 tab 多并发时默认关闭 evaluate 锁（避免 Promise.all 被串行化）
 * 显式 IG_LITE_DISABLE_EVALUATE_LOCK=0 可恢复锁
 */
export function resolveIgLiteDisableEvaluateLock() {
  const v = String(process.env.IG_LITE_DISABLE_EVALUATE_LOCK ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return isLiteScraperMode();
}

/** X Lite innertube 标签池：风控敏感，默认 1 tab + 串行并发 */
export function resolveXLiteTabPoolSize() {
  const n = Number(process.env.X_LITE_TAB_POOL_SIZE ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 2);
}

/** X Lite evaluate 并发（页内 fetch 串行化，默认 1，避免触发风控） */
export function resolveXLiteEvaluateConcurrency() {
  const n = Number(process.env.X_LITE_EVALUATE_CONCURRENCY ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 5);
}

/** X Lite 请求间隔（毫秒），默认 1500-4000ms，风控保守 */
export function resolveXLiteRequestDelay() {
  const min = Math.max(Number(process.env.X_LITE_REQUEST_DELAY_MIN_MS) || 1500, 500);
  const max = Math.max(Number(process.env.X_LITE_REQUEST_DELAY_MAX_MS) || 4000, min);
  return { min, max };
}

/** X Lite 搜索最大翻页数（默认 8 页，风控保守） */
export function resolveXLiteSearchMaxPages() {
  const n = Number(process.env.X_LITE_SEARCH_MAX_PAGES ?? 8);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 30);
}

/** X Lite 邮箱门槛：默认必须有邮箱才进入 LLM 分析（对齐 YTB） */
export function isXLiteEmailGateEnabled(raw = process.env.X_LITE_REQUIRE_EMAIL_FOR_ANALYSIS) {
  return String(raw ?? "1").trim() !== "0";
}

/** X Lite 是否抓取候选人近期推文互动数据（默认开，供 LLM 画像分析） */
export function isXLiteFetchTweetsEnabled(raw = process.env.X_LITE_FETCH_TWEETS) {
  return String(raw ?? "1").trim() !== "0";
}

/** X Lite 是否抓取 profile 外链网页提取邮箱（默认开，邮箱门槛的主要来源） */
export function isXLiteEmailFetchWebsiteEnabled(raw = process.env.X_LITE_EMAIL_FETCH_WEBSITE) {
  return String(raw ?? "1").trim() !== "0";
}

/**
 * X Lite 单 tab 默认串行 evaluate（风控敏感，不同于 YT/IG 的并发解锁）
 * 显式 X_LITE_DISABLE_EVALUATE_LOCK=1 可关闭锁
 */
export function resolveXLiteDisableEvaluateLock() {
  const v = String(process.env.X_LITE_DISABLE_EVALUATE_LOCK ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return false;
}

/** Lite 下 About 国家默认 API-only，不 goto /about；显式 YT_ALLOW_ABOUT_FALLBACK=1 可开兜底 */
export function resolveYtAllowAboutFallback() {
  const v = String(process.env.YT_ALLOW_ABOUT_FALLBACK ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return !isLiteScraperMode();
}

/** Lite 下 Instagram About 国家默认 API-only；显式 IG_ALLOW_ABOUT_FALLBACK=1 可开弹窗兜底 */
export function resolveIgAllowAboutFallback() {
  const v = String(process.env.IG_ALLOW_ABOUT_FALLBACK ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return !isLiteScraperMode();
}

/** Lite 下 Instagram Reels 默认 API 翻页，不 goto /reels/ 滚动；显式 IG_ALLOW_REELS_SCROLL_FALLBACK=1 可开兜底 */
export function resolveIgAllowReelsScrollFallback() {
  const v = String(process.env.IG_ALLOW_REELS_SCROLL_FALLBACK ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  if (process.env.IG_LITE_SKIP_REELS_SCROLL === "1") return false;
  return !isLiteScraperMode();
}
