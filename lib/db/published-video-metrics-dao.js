import { queryTikTok } from "./mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "./campaign-execution-keys.js";
import {
  publishedVideoTasksFromRow,
  resolvePublishedVideos,
  applyPublishedMetricsResult,
  buildLegacyPublishedFields,
  publishedVideoKey,
} from "../execution/published-videos.js";

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function resolveRefreshHours() {
  const n = Number(process.env.PUBLISHED_METRICS_REFRESH_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

function resolveBatchSize() {
  const n = Number(process.env.PUBLISHED_METRICS_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.round(n)) : 20;
}

/**
 * 挑选需要刷新 metrics 的「已发布视频任务」：一个执行行可展开为多条（一个平台一条）。
 * 刷新间隔按平台条目各自的 metrics.updatedAt 判定。
 * @param {number|null} [limit]
 * @param {'tiktok'|'instagram'|'youtube'|null} [platformFilter]
 * @returns {Promise<object[]>}
 */
export async function pickPublishedVideoMetricTasks(limit, platformFilter = null) {
  const batch = limit ?? resolveBatchSize();
  const refreshHours = resolveRefreshHours();
  const fetchLimit = Math.min(200, batch * 5);

  const rows = await queryTikTok(
    `
    SELECT
      e.campaign_id,
      e.tiktok_username,
      e.influencer_id,
      e.stage,
      e.video_link,
      e.last_event,
      e.influencer_snapshot,
      e.updated_at,
      e.flat_fee,
      e.currency
    FROM tiktok_campaign_execution e
    INNER JOIN tiktok_campaign c ON c.id = e.campaign_id
    WHERE e.stage = 'published'
      AND c.deleted_at IS NULL
      AND (
        (e.video_link IS NOT NULL AND TRIM(e.video_link) != '')
        OR (
          JSON_EXTRACT(e.last_event, '$.videoLink') IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(e.last_event, '$.videoLink')) != ''
        )
        OR (
          JSON_TYPE(JSON_EXTRACT(e.last_event, '$.publishedVideos')) = 'ARRAY'
          AND JSON_LENGTH(JSON_EXTRACT(e.last_event, '$.publishedVideos')) > 0
        )
      )
    ORDER BY e.updated_at ASC
    LIMIT ${Number(fetchLimit)}
  `,
    []
  );

  const now = Date.now();
  const tasks = [];
  for (const row of rows || []) {
    const expanded = publishedVideoTasksFromRow(row, {
      platformFilter,
      refreshHours,
      now,
    });
    for (const task of expanded) tasks.push(task);
    if (tasks.length >= batch) break;
  }
  return tasks.slice(0, batch);
}

/** 平台 → CDP 端口（9222=TikTok、9223=Instagram、9224=YouTube，可环境变量覆盖）。 */
export function resolveCdpEndpointForPlatform(platform) {
  const p = String(platform || "").toLowerCase();
  const envKey =
    p === "tiktok"
      ? "PUBLISHED_METRICS_CDP_TIKTOK"
      : p === "instagram"
        ? "PUBLISHED_METRICS_CDP_INSTAGRAM"
        : p === "youtube"
          ? "PUBLISHED_METRICS_CDP_YOUTUBE"
          : null;
  if (envKey && process.env[envKey]) return process.env[envKey];
  if (envKey) {
    return p === "tiktok"
      ? "http://127.0.0.1:9222"
      : p === "instagram"
        ? "http://127.0.0.1:9223"
        : "http://127.0.0.1:9224";
  }
  return (
    process.env.CDP_ENDPOINT_METRICS ||
    process.env.CDP_ENDPOINT_ENRICH ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9222"
  );
}

/**
 * 写入单个平台的 metrics（写进 last_event.publishedVideos 对应条目），
 * 并同步旧字段：views/likes/comments 为全平台合计，cpm 为合计 CPM，
 * video_link 保持主链接（列已为空时才回填）。
 */
export async function updatePublishedVideoMetrics(
  campaignId,
  influencerId,
  { metrics, videoLink, platform = null, error = null }
) {
  const rows = await queryTikTok(
    `
    SELECT last_event, video_link, flat_fee, currency
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
  `,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
  if (!rows?.[0]) return false;

  const prev = parseJson(rows[0].last_event) || {};
  const now = new Date().toISOString();

  if (!error && !metrics) return false;

  const existing = resolvePublishedVideos(prev, { videoLink: rows[0].video_link });
  let nextEntries = applyPublishedMetricsResult(existing, {
    videoLink,
    platform,
    metrics,
    error,
  });
  // 目标链接不在数组里（例如老数据只有单值字段且链接无法解析）时补一条
  const targetKey = publishedVideoKey({ platform: platform || "", url: videoLink });
  if (!nextEntries.some((e) => publishedVideoKey(e) === targetKey)) {
    nextEntries = applyPublishedMetricsResult(
      [...nextEntries, { platform, url: videoLink, source: "metrics_worker" }],
      { videoLink, platform, metrics, error }
    );
  }

  const fee = resolvePublishedFeeUsd(rows[0].flat_fee, prev);
  const legacy = buildLegacyPublishedFields(nextEntries, { feeUsd: fee });
  const cpmDisabled = ["0", "false", "no"].includes(
    String(process.env.PUBLISHED_METRICS_COMPUTE_CPM ?? "1")
      .trim()
      .toLowerCase()
  );

  const merged = {
    ...prev,
    publishedVideos: nextEntries,
    videoLink: legacy.videoLink || prev.videoLink || null,
    ...(legacy.promoCode ? { promoCode: legacy.promoCode } : {}),
    views: legacy.views ?? prev.views,
    likes: legacy.likes ?? prev.likes,
    comments: legacy.comments ?? prev.comments,
    ...(legacy.cpm != null && !cpmDisabled ? { cpm: legacy.cpm } : {}),
    metricsUpdatedAt: now,
    metricsFetchError: error
      ? { message: String(error.message || error).slice(0, 500), at: now }
      : null,
    ...(metrics
      ? {
          metricsRaw: {
            views: metrics.views,
            likes: metrics.likes,
            comments: metrics.comments,
            platform: metrics.platform || platform || null,
            source: metrics.source,
            trafficBytes: metrics.trafficBytes || null,
          },
        }
      : {}),
  };

  const nextVideoLink =
    rows[0].video_link && String(rows[0].video_link).trim()
      ? rows[0].video_link
      : legacy.videoLink || videoLink || null;

  await queryTikTok(
    `
    UPDATE tiktok_campaign_execution
    SET last_event = ?,
        video_link = COALESCE(?, video_link)
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
  `,
    [
      JSON.stringify(merged),
      nextVideoLink,
      campaignId,
      ...paramsExecutionCreatorMatch(influencerId),
    ]
  );
  return true;
}

/** 合作费用（USD）：flat_fee 优先，其次 last_event / quote_negotiation 的兜底 */
function resolvePublishedFeeUsd(flatFee, lastEvent) {
  const direct = Number(flatFee);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return resolveLatestQuoteAmount(lastEvent);
}

/** 从 last_event / quote_negotiation 里取最终合作金额（USD），供 CPM 计算兜底。 */
function resolveLatestQuoteAmount(lastEvent) {
  try {
    const q = lastEvent?.quoteNegotiation || lastEvent?.quote_negotiation;
    if (Array.isArray(q) && q.length) {
      const amounts = q
        .map((x) => Number(x?.amount))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (amounts.length) return Math.max(...amounts);
    }
    const direct = Number(lastEvent?.flatFeeUsd ?? lastEvent?.flat_fee);
    if (Number.isFinite(direct) && direct > 0) return direct;
  } catch {
    /* ignore */
  }
  return null;
}

export { resolveBatchSize, resolveRefreshHours };
