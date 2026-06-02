import { queryTikTok } from "./mysql-tiktok.js";
import {
  SQL_EXECUTION_CREATOR_MATCH,
  paramsExecutionCreatorMatch,
} from "./campaign-execution-keys.js";
import {
  resolveExecutionPublishedVideoLink,
  parsePublishedVideoUrl,
  inferPlatformFromSnapshot,
} from "../execution/published-video-url.js";

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
 * 挑选需要刷新 metrics 的 published 执行行。
 * @returns {Promise<object[]>}
 */
export async function pickPublishedExecutionsForMetricsRefresh(limit) {
  const batch = limit ?? resolveBatchSize();
  const refreshHours = resolveRefreshHours();
  const refreshMs = refreshHours * 3600 * 1000;
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
      e.updated_at
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
      )
    ORDER BY e.updated_at ASC
    LIMIT ${Number(fetchLimit)}
  `,
    []
  );

  const now = Date.now();

  return (rows || [])
    .map((row) => {
      const lastEvent = parseJson(row.last_event) || {};
      const snapshot = parseJson(row.influencer_snapshot) || {};
      const videoLink = resolveExecutionPublishedVideoLink({
        ...row,
        lastEvent,
      });
      const parsed = parsePublishedVideoUrl(videoLink);
      return {
        ...row,
        lastEvent,
        snapshot,
        videoLink,
        platform: inferPlatformFromSnapshot(snapshot, parsed.platform),
        parsedVideo: parsed,
      };
    })
    .filter((row) => {
      if (!row.videoLink) return false;
      const updatedAt = row.lastEvent?.metricsUpdatedAt;
      if (!updatedAt) return true;
      const t = new Date(updatedAt).getTime();
      if (!Number.isFinite(t)) return true;
      return now - t >= refreshMs;
    })
    .slice(0, batch);
}

/**
 * 写入 metrics 到 last_event（并同步 video_link 列若为空）。
 */
export async function updatePublishedExecutionMetrics(
  campaignId,
  influencerId,
  { metrics, videoLink, error = null }
) {
  const rows = await queryTikTok(
    `
    SELECT last_event, video_link
    FROM tiktok_campaign_execution
    WHERE campaign_id = ? AND ${SQL_EXECUTION_CREATOR_MATCH}
  `,
    [campaignId, ...paramsExecutionCreatorMatch(influencerId)]
  );
  if (!rows?.[0]) return false;

  const prev = parseJson(rows[0].last_event) || {};
  const now = new Date().toISOString();

  let merged;
  if (error) {
    merged = {
      ...prev,
      metricsUpdatedAt: now,
      metricsFetchError: {
        message: String(error.message || error).slice(0, 500),
        at: now,
      },
    };
  } else if (metrics) {
    merged = {
      ...prev,
      videoLink: videoLink || prev.videoLink || null,
      views: metrics.viewsDisplay ?? metrics.views,
      likes: metrics.likesDisplay ?? metrics.likes,
      comments: metrics.commentsDisplay ?? metrics.comments,
      metricsRaw: {
        views: metrics.views,
        likes: metrics.likes,
        comments: metrics.comments,
        platform: metrics.platform,
        source: metrics.source,
      },
      metricsUpdatedAt: now,
      metricsFetchError: null,
    };
  } else {
    return false;
  }

  const nextVideoLink =
    rows[0].video_link && String(rows[0].video_link).trim()
      ? rows[0].video_link
      : videoLink || null;

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

export { resolveBatchSize, resolveRefreshHours };
