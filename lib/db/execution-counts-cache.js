/**
 * 执行进度计数缓存（方案 3）
 *
 * - loadExecutionCounts：totalByStage（所有 stage 的 Tab 数字）+ analyzedCount，
 *   供 execution-status 各 stage 首屏请求复用，避免切换 campaign 时同一组计数被算 3–5 遍。
 * - loadAnalyzedBreakdown：已分析总数 + 推荐/不推荐，供「已分析红人」Tab 数字
 *   （candidates countOnly / 列表首屏）复用，避免每次打开都 JSON_VALUE 全扫候选表。
 *
 * 计数只在红人跨 stage 时变化，短 TTL 足够；用户侧变更（PATCH /execution、
 * approveQuote）成功后主动失效。worker 心跳把新候选拉进执行表发生在独立进程，
 * 由 TTL 兜底（最多滞后一个 TTL）。
 */
import { queryTikTok } from "./mysql-tiktok.js";

export const EXECUTION_COUNTS_TTL_MS = 8_000;

const STAGE_PENDING_QUOTE = "pending_quote";
const STAGE_QUOTE_SUBMITTED = "quote_submitted";
const STAGE_QUOTE_REJECTED = "quote_rejected";
const STAGE_PENDING_SHIPPING_ADDRESS = "pending_shipping_address";
const STAGE_PENDING_SAMPLE = "pending_sample";
const STAGE_PENDING_DRAFT = "pending_draft";
const STAGE_PUBLISHED = "published";

const SQL_EXECUTION_COUNTS = `
  SELECT
    SUM(CASE WHEN stage = ? OR stage IS NULL OR stage = '' THEN 1 ELSE 0 END) AS contacted,
    SUM(CASE WHEN stage IN (?, ?, ?) THEN 1 ELSE 0 END) AS pendingPrice,
    SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) AS pendingPricePending,
    SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) AS pendingPriceRejected,
    SUM(CASE WHEN stage IN (?, ?) THEN 1 ELSE 0 END) AS pendingSample,
    SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) AS pendingShippingAddress,
    SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) AS pendingSampleReady,
    SUM(CASE WHEN stage IN (?, ?) THEN 1 ELSE 0 END) AS pendingDraft,
    SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) AS published
  FROM tiktok_campaign_execution
  WHERE campaign_id = ?
`;

const SQL_ANALYZED_COUNT = `
  SELECT COUNT(*) AS total
  FROM tiktok_campaign_influencer_candidates
  WHERE campaign_id = ?
    AND match_analysis IS NOT NULL
`;

const SQL_ANALYZED_BREAKDOWN = `
  SELECT
    COUNT(*) AS total,
    COALESCE(SUM(
      CASE
        WHEN JSON_VALUE(match_analysis, '$.isRecommended') = 'true' THEN 1
        WHEN JSON_VALUE(match_analysis, '$.isRecommended') IS NULL AND COALESCE(should_contact, 0) = 1 THEN 1
        ELSE 0
      END
    ), 0) AS recommended_cnt
  FROM tiktok_campaign_influencer_candidates
  WHERE campaign_id = ?
    AND match_analysis IS NOT NULL
`;

const countsCache = new Map(); // campaignId -> { value: {totalByStage, analyzedCount}, fetchedAt }
const breakdownCache = new Map(); // campaignId -> { value: breakdown, fetchedAt }
const inflightCounts = new Map(); // campaignId -> Promise
const inflightBreakdown = new Map(); // campaignId -> Promise

function isFresh(entry) {
  return !!entry && Date.now() - entry.fetchedAt < EXECUTION_COUNTS_TTL_MS;
}

/**
 * 返回 { totalByStage, analyzedCount }；命中 TTL 缓存直接返回，否则算一次并缓存。
 * 并发未命中时共享同一计算 Promise，避免并行预取重复扫表。
 */
export async function loadExecutionCounts(campaignId) {
  const hit = countsCache.get(campaignId);
  if (isFresh(hit)) return hit.value;
  if (inflightCounts.has(campaignId)) return inflightCounts.get(campaignId);

  const promise = (async () => {
    const [countRows, analyzedRows] = await Promise.all([
      queryTikTok(SQL_EXECUTION_COUNTS, [
        STAGE_PENDING_QUOTE,
        STAGE_QUOTE_SUBMITTED,
        "pending_creator_confirmation",
        STAGE_QUOTE_REJECTED,
        STAGE_QUOTE_SUBMITTED,
        STAGE_QUOTE_REJECTED,
        STAGE_PENDING_SHIPPING_ADDRESS,
        STAGE_PENDING_SAMPLE,
        STAGE_PENDING_SHIPPING_ADDRESS,
        STAGE_PENDING_SAMPLE,
        "draft_submitted",
        STAGE_PENDING_DRAFT,
        STAGE_PUBLISHED,
        campaignId,
      ]),
      queryTikTok(SQL_ANALYZED_COUNT, [campaignId]),
    ]);
    const counts = countRows?.[0] || {};
    const value = {
      totalByStage: {
        contacted: Number(counts.contacted || 0),
        pendingPrice: Number(counts.pendingPrice || 0),
        pendingPricePending: Number(
          counts.pendingPricePending ?? counts.pendingpricepending ?? 0
        ),
        pendingPriceRejected: Number(
          counts.pendingPriceRejected ?? counts.pendingpricerejected ?? 0
        ),
        pendingSample: Number(counts.pendingSample || 0),
        pendingShippingAddress: Number(
          counts.pendingShippingAddress ?? counts.pendingshippingaddress ?? 0
        ),
        pendingSampleReady: Number(
          counts.pendingSampleReady ?? counts.pendingsampleready ?? 0
        ),
        pendingDraft: Number(counts.pendingDraft || 0),
        published: Number(counts.published || 0),
      },
      analyzedCount: Number(analyzedRows?.[0]?.total ?? analyzedRows?.[0]?.TOTAL ?? 0),
    };
    countsCache.set(campaignId, { value, fetchedAt: Date.now() });
    return value;
  })();

  inflightCounts.set(campaignId, promise);
  try {
    return await promise;
  } finally {
    inflightCounts.delete(campaignId);
  }
}

/**
 * 返回 { totalMatchAnalysisCount, analyzedRecommendedDbCount, analyzedNotRecommendedDbCount }
 * 或 null；命中 TTL 缓存直接返回。
 */
export async function loadAnalyzedBreakdown(campaignId) {
  const hit = breakdownCache.get(campaignId);
  if (isFresh(hit)) return hit.value;
  if (inflightBreakdown.has(campaignId)) return inflightBreakdown.get(campaignId);

  const promise = (async () => {
    const rows = await queryTikTok(SQL_ANALYZED_BREAKDOWN, [campaignId]);
    const row = rows?.[0];
    const value = row
      ? {
          totalMatchAnalysisCount: Number(row.total ?? 0),
          analyzedRecommendedDbCount: Number(row.recommended_cnt ?? 0),
          analyzedNotRecommendedDbCount: Math.max(
            0,
            Number(row.total ?? 0) - Number(row.recommended_cnt ?? 0)
          ),
        }
      : null;
    breakdownCache.set(campaignId, { value, fetchedAt: Date.now() });
    return value;
  })();

  inflightBreakdown.set(campaignId, promise);
  try {
    return await promise;
  } finally {
    inflightBreakdown.delete(campaignId);
  }
}

/** 用户侧变更执行阶段后调用，让下一次请求立即拿到新计数。 */
export function invalidateExecutionCounts(campaignId) {
  if (!campaignId) return;
  countsCache.delete(campaignId);
  breakdownCache.delete(campaignId);
}
