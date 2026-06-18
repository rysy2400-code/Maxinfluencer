/**
 * Instagram 视频互动 enrich：media info API，无需 Reels 页滚动
 */

import { igApiFetch } from "./instagram-direct-fetch.js";
import {
  extractIgPlayCount,
  formatIgNumber,
  mapIgMediaToSearchPost,
} from "./instagram-json-utils.js";

function resolveEngagementConcurrency() {
  return Math.min(
    Math.max(Number(process.env.IG_ENGAGEMENT_CONCURRENCY || 4), 1),
    8
  );
}

function resolveEngagementDelayMs() {
  return Math.min(
    Math.max(Number(process.env.IG_ENGAGEMENT_DELAY_MS || 80), 0),
    400
  );
}

function isEngagementEnrichEnabled() {
  const raw = String(process.env.IG_SKIP_ENGAGEMENT_ENRICH || "").trim().toLowerCase();
  return !(raw === "1" || raw === "true" || raw === "yes");
}

function videoNeedsEngagementEnrich(video) {
  if (!video) return false;
  const hasViews = (video.views?.count || 0) > 0;
  const hasLikes = (video.likes?.count || 0) > 0;
  const hasComments = (video.comments?.count || 0) > 0;
  return !(hasViews && hasLikes && hasComments);
}

/**
 * @param {object|null|undefined} json
 */
export function extractEngagementFromMediaInfoJson(json) {
  const item = json?.items?.[0] || json?.media || null;
  if (!item) return { views: null, likes: null, comments: null };
  const mapped = mapIgMediaToSearchPost(item);
  const views = extractIgPlayCount(item);
  return {
    views: views > 0 ? views : null,
    likes: mapped.likes?.count > 0 ? mapped.likes.count : null,
    comments: mapped.comments?.count > 0 ? mapped.comments.count : null,
  };
}

function mergeEngagementCounts(base, patch) {
  const out = { ...base };
  for (const k of ["views", "likes", "comments"]) {
    if (patch[k] != null && patch[k] > 0) out[k] = patch[k];
  }
  return out;
}

function applyEngagementToVideo(video, counts) {
  if (!video || !counts) return video;
  const out = { ...video };
  if (counts.views != null && counts.views > 0) {
    out.views = { count: counts.views, display: formatIgNumber(counts.views) };
  }
  if (counts.likes != null && counts.likes > 0) {
    out.likes = { count: counts.likes, display: formatIgNumber(counts.likes) };
  }
  if (counts.comments != null && counts.comments > 0) {
    out.comments = { count: counts.comments, display: formatIgNumber(counts.comments) };
  }
  out.engagementSource = out.engagementSource || counts.source || null;
  return out;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} mediaId
 */
export async function fetchMediaEngagementViaInfo(page, mediaId) {
  const id = String(mediaId || "").trim();
  if (!id) return null;
  const json = await igApiFetch(page, `/api/v1/media/${encodeURIComponent(id)}/info/`);
  if (!json) return null;
  const counts = extractEngagementFromMediaInfoJson(json);
  if (!counts.views && !counts.likes && !counts.comments) return null;
  return { ...counts, source: "media_info_api" };
}

/**
 * 批量补齐 Reels 播放/点赞/评论（不滚动 Reels 页）
 * @param {import('playwright').Page} page
 * @param {object[]} videos
 * @param {{ maxVideos?: number, onProgress?: (done: number, total: number) => void }} [options]
 */
export async function enrichIgVideosEngagement(page, videos, options = {}) {
  if (!isEngagementEnrichEnabled()) {
    console.log("[ig-engagement] skip (IG_SKIP_ENGAGEMENT_ENRICH=1)");
    return videos || [];
  }

  const list = Array.isArray(videos) ? videos : [];
  const max = Math.min(
    options.maxVideos ?? list.length,
    Math.max(Number(process.env.IG_ENGAGEMENT_MAX_VIDEOS || 24) || 24, 1)
  );
  const targets = list
    .slice(0, max)
    .filter((v) => v?.videoId && videoNeedsEngagementEnrich(v));
  if (!targets.length) return list;

  const concurrency = resolveEngagementConcurrency();
  const delayMs = resolveEngagementDelayMs();
  const out = [...list];
  let done = 0;
  let withViews = 0;
  let withLikes = 0;
  let withComments = 0;

  async function enrichOne(video) {
    try {
      const counts = await fetchMediaEngagementViaInfo(page, video.videoId);
      if (!counts) return video;
      const patched = applyEngagementToVideo(video, counts);
      if ((patched.views?.count || 0) > 0) withViews += 1;
      if ((patched.likes?.count || 0) > 0) withLikes += 1;
      if ((patched.comments?.count || 0) > 0) withComments += 1;
      return patched;
    } catch (e) {
      console.warn(`[ig-engagement] ${video.videoId} failed: ${e.message}`);
      return video;
    } finally {
      done += 1;
      options.onProgress?.(done, targets.length);
      if (delayMs > 0 && typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(delayMs);
      }
    }
  }

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((v) => enrichOne(v)));
    const idToIdx = new Map(out.map((v, idx) => [v.videoId, idx]));
    for (const result of results) {
      const idx = idToIdx.get(result?.videoId);
      if (idx >= 0) out[idx] = result;
    }
  }

  console.log(
    `[ig-engagement] enriched ${targets.length} videos: views=${withViews} likes=${withLikes} comments=${withComments}`
  );
  return out;
}

/**
 * @param {object[]} videos
 */
export function igEngagementCoverage(videos = []) {
  const list = Array.isArray(videos) ? videos : [];
  if (!list.length) return 0;
  const withAny = list.filter(
    (v) =>
      (v.views?.count > 0) ||
      (v.likes?.count > 0) ||
      (v.comments?.count > 0)
  ).length;
  return withAny / list.length;
}
