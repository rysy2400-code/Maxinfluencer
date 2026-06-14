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
      : platform === "tiktok"
        ? Number(process.env.LITE_ENRICH_CONCURRENCY) || 2
        : Number(process.env.LITE_ENRICH_CONCURRENCY) || 3;
  const n = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 8);
}

export function resolveLiteDelayBetweenBatches() {
  const min = Math.max(Number(process.env.LITE_BATCH_DELAY_MIN_MS) || 800, 0);
  const max = Math.max(Number(process.env.LITE_BATCH_DELAY_MAX_MS) || 2000, min);
  return { min, max };
}
