/**
 * YouTube 视频互动 enrich：innertube player/next API，无需打开 watch 页
 */

import { postInnertube } from "./innertube-direct-fetch.js";
import { formatYtNumber, parseYtViewCount } from "./youtube-json-utils.js";

function rawToCount(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  const text =
    typeof raw === "string"
      ? raw
      : raw.simpleText ||
        raw.content ||
        raw.text ||
        (Array.isArray(raw.runs) ? raw.runs.map((r) => r.text || "").join("") : "") ||
        "";
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  const n = parseYtViewCount(trimmed);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

function countFromFactoidText(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const m = s.match(/^([\d.,]+[KMB]?)\s*(comments?|likes?|views?)/i);
  if (m) return rawToCount(m[1]);
  if (/^(comments?|likes?|views?)$/i.test(s)) return null;
  const n = rawToCount(s);
  return n != null && n > 0 ? n : null;
}

/**
 * 从 innertube JSON 提取 views/likes/comments
 * @param {object} json
 * @returns {{ views: number|null, likes: number|null, comments: number|null }}
 */
export function extractEngagementFromInnertubeJson(json) {
  const out = { views: null, likes: null, comments: null };
  if (!json || typeof json !== "object") return out;

  const walk = (obj, d = 0) => {
    if (d > 28 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, d + 1));
      return;
    }

    if (obj.videoDetails?.viewCount != null && out.views == null) {
      out.views = rawToCount(obj.videoDetails.viewCount);
    }

    for (const key of [
      "viewCount",
      "likeCount",
      "likesCount",
      "commentCount",
      "commentsCount",
      "commentCountText",
    ]) {
      if (obj[key] == null) continue;
      const n = rawToCount(obj[key]);
      if (n == null) continue;
      const kl = key.toLowerCase();
      if (kl.includes("comment") && out.comments == null) out.comments = n;
      else if (kl.includes("like") && out.likes == null) out.likes = n;
      else if (kl.includes("view") && out.views == null) out.views = n;
    }

    if (obj.factoidRenderer) {
      const fr = obj.factoidRenderer;
      const label = fr.label?.simpleText || fr.label?.content || "";
      const value =
        fr.value?.simpleText ||
        fr.value?.content ||
        fr.accessibilityText ||
        "";
      if (/comment/i.test(label)) {
        const n = countFromFactoidText(value || label);
        if (n != null) out.comments = n;
      } else if (/like/i.test(label)) {
        const n = countFromFactoidText(value || fr.accessibilityText || label);
        if (n != null) out.likes = n;
      }
    }

    if (obj.videoPrimaryInfoRenderer && out.comments == null) {
      for (const row of obj.videoPrimaryInfoRenderer?.factoid?.factoidRenderer
        ? [obj.videoPrimaryInfoRenderer.factoid]
        : obj.videoPrimaryInfoRenderer?.factoid?.factoidRendererList?.factoidRenderer ||
          []) {
        const fr = row?.factoidRenderer || row;
        const label = fr?.label?.simpleText || fr?.label?.content || "";
        if (/comment/i.test(label)) {
          const n = countFromFactoidText(
            fr?.value?.simpleText || fr?.accessibilityText || label
          );
          if (n != null) out.comments = n;
        }
      }
    }

    if (obj.toggleButtonRenderer?.defaultText?.accessibility?.accessibilityData) {
      const acc =
        obj.toggleButtonRenderer.defaultText.accessibility.accessibilityData.label;
      if (/like/i.test(acc) && out.likes == null) {
        const n = countFromFactoidText(acc);
        if (n != null) out.likes = n;
      }
    }

    if (obj.commentsEntryPointHeaderRenderer && out.comments == null) {
      const c = obj.commentsEntryPointHeaderRenderer;
      const n =
        rawToCount(c.commentCount) ||
        rawToCount(c.commentsCount) ||
        countFromFactoidText(
          c.headerText?.simpleText ||
            c.headerText?.runs?.map((r) => r.text).join("") ||
            c.accessibility?.accessibilityData?.label ||
            c.tooltip?.simpleText
        );
      if (n != null) out.comments = n;
    }

    if (obj.engagementPanelTitleHeaderRenderer && out.comments == null) {
      const t = obj.engagementPanelTitleHeaderRenderer.title?.simpleText || "";
      if (/comment/i.test(t)) {
        const n = countFromFactoidText(t);
        if (n != null) out.comments = n;
      }
    }

    if (typeof obj.simpleText === "string" && out.comments == null) {
      if (/comments?/i.test(obj.simpleText)) {
        const n = countFromFactoidText(obj.simpleText);
        if (n != null) out.comments = n;
      }
    }

    if (typeof obj.accessibilityText === "string") {
      if (/comments?/i.test(obj.accessibilityText) && out.comments == null) {
        const n = countFromFactoidText(obj.accessibilityText);
        if (n != null) out.comments = n;
      }
      if (/likes?/i.test(obj.accessibilityText) && out.likes == null) {
        const n = countFromFactoidText(obj.accessibilityText);
        if (n != null) out.likes = n;
      }
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v, d + 1);
    }
  };

  walk(json);
  return out;
}

function extractCommentsContinuationToken(json) {
  let token = null;
  const walk = (obj, d = 0) => {
    if (d > 26 || !obj || typeof obj !== "object" || token) return;
    if (Array.isArray(obj)) return obj.forEach((x) => walk(x, d + 1));

    const section = obj.itemSectionRenderer;
    if (
      section &&
      (section.targetId === "comments-section" ||
        section.sectionIdentifier === "comment-item-section")
    ) {
      const cont =
        section.continuations?.[0]?.nextContinuationData?.continuation ||
        section.contents?.[0]?.continuationItemRenderer?.continuationEndpoint
          ?.continuationCommand?.token;
      if (cont) token = cont;
    }

    if (
      obj.engagementPanelSectionListRenderer?.panelIdentifier ===
      "engagement-panel-comments-section"
    ) {
      const cont =
        obj.engagementPanelSectionListRenderer?.content?.sectionListRenderer
          ?.continuations?.[0]?.nextContinuationData?.continuation ||
        obj.engagementPanelSectionListRenderer?.content?.sectionListRenderer
          ?.contents?.[0]?.itemSectionRenderer?.contents?.[0]
          ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand
          ?.token;
      if (cont) token = cont;
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v, d + 1);
    }
  };
  walk(json);
  return token;
}

function countCommentThreads(json) {
  let count = 0;
  const walk = (obj, d = 0) => {
    if (d > 28 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, d + 1));
      return;
    }
    if (obj.commentThreadRenderer || obj.commentRenderer) count += 1;
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v, d + 1);
    }
  };
  walk(json);
  return count;
}

async function resolveCommentCountFromNextJson(page, nextJson) {
  if (!nextJson) return null;
  const fromNext = extractEngagementFromInnertubeJson(nextJson);
  if (fromNext.comments != null) return fromNext.comments;

  const inlineThreads = countCommentThreads(nextJson);
  if (inlineThreads > 0) return inlineThreads;

  const token = extractCommentsContinuationToken(nextJson);
  if (!token) return null;

  const commentsPage = await postInnertube(page, "next", { continuation: token });
  if (!commentsPage) return null;

  const parsed = extractEngagementFromInnertubeJson(commentsPage);
  if (parsed.comments != null) return parsed.comments;

  const threadCount = countCommentThreads(commentsPage);
  return threadCount > 0 ? threadCount : null;
}

/**
 * 尝试通过 next + comments continuation 获取评论数（仍不打开 watch 页）
 * @param {import('playwright').Page} page
 * @param {string} videoId
 */
export async function fetchVideoCommentCountViaContinuation(page, videoId) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  const next = await postInnertube(page, "next", {
    videoId: id,
    racyCheckOk: true,
    contentCheckOk: true,
  });
  return resolveCommentCountFromNextJson(page, next);
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
    out.views = { count: counts.views, display: formatYtNumber(counts.views) };
  }
  out.likes = {
    count: counts.likes ?? out.likes?.count ?? 0,
    display: formatYtNumber(counts.likes ?? out.likes?.count ?? 0),
  };
  out.comments = {
    count: counts.comments ?? out.comments?.count ?? 0,
    display: formatYtNumber(counts.comments ?? out.comments?.count ?? 0),
  };
  out.engagementSource = out.engagementSource || counts.source || null;
  return out;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} videoId
 */
export async function fetchVideoEngagementViaPlayer(page, videoId) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  const json = await postInnertube(page, "player", { videoId: id });
  if (!json) return null;
  const counts = extractEngagementFromInnertubeJson(json);
  return { ...counts, source: "innertube_player" };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} videoId
 */
export async function fetchVideoEngagementViaNext(page, videoId) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  const json = await postInnertube(page, "next", {
    videoId: id,
    racyCheckOk: true,
    contentCheckOk: true,
  });
  if (!json) return null;
  const counts = extractEngagementFromInnertubeJson(json);
  return { ...counts, source: "innertube_next", _json: json };
}

/**
 * 单条视频：player 优先，缺字段再 next + comments continuation
 * @param {import('playwright').Page} page
 * @param {string} videoId
 */
export async function fetchVideoEngagement(page, videoId) {
  const player = (await fetchVideoEngagementViaPlayer(page, videoId)) || {
    views: null,
    likes: null,
    comments: null,
  };
  let merged = { ...player };
  let source = player.source || null;

  let nextJson = null;
  if (player.comments == null) {
    nextJson = await postInnertube(page, "next", {
      videoId: String(videoId || "").trim(),
      racyCheckOk: true,
      contentCheckOk: true,
    });
    if (nextJson) {
      const nextCounts = extractEngagementFromInnertubeJson(nextJson);
      merged = mergeEngagementCounts(merged, nextCounts);
      source = source ? `${source}+innertube_next` : "innertube_next";
    }
  }

  if (merged.comments == null && nextJson) {
    const commentCount = await resolveCommentCountFromNextJson(page, nextJson);
    if (commentCount != null) {
      merged.comments = commentCount;
      source = source ? `${source}+comments_continuation` : "comments_continuation";
    }
  }

  merged.source = source;
  return merged;
}

function resolveEngagementConcurrency() {
  return Math.min(
    Math.max(Number(process.env.YT_ENGAGEMENT_CONCURRENCY || 4), 1),
    10
  );
}

function resolveEngagementDelayMs() {
  return Math.min(
    Math.max(Number(process.env.YT_ENGAGEMENT_DELAY_MS || 60), 0),
    500
  );
}

function isEngagementEnrichEnabled() {
  const raw = String(process.env.YT_SKIP_ENGAGEMENT_ENRICH || "").trim().toLowerCase();
  return !(raw === "1" || raw === "true" || raw === "yes");
}

/**
 * 批量补齐视频点赞/评论（不打开 watch 页）
 * @param {import('playwright').Page} page
 * @param {object[]} videos
 * @param {{ maxVideos?: number, onProgress?: (done: number, total: number) => void }} [options]
 */
export async function enrichYoutubeVideosEngagement(page, videos, options = {}) {
  if (!isEngagementEnrichEnabled()) {
    console.log("[yt-engagement] skip (YT_SKIP_ENGAGEMENT_ENRICH=1)");
    return videos || [];
  }

  const list = Array.isArray(videos) ? videos : [];
  const max = Math.min(
    options.maxVideos ?? list.length,
    Math.max(Number(process.env.YT_ENGAGEMENT_MAX_VIDEOS || 50) || 50, 1)
  );
  const targets = list.slice(0, max).filter((v) => v?.videoId);
  if (!targets.length) return list;

  const concurrency = resolveEngagementConcurrency();
  const delayMs = resolveEngagementDelayMs();
  const out = [...list];
  let done = 0;
  let withLikes = 0;
  let withComments = 0;

  async function enrichOne(video) {
    try {
      const counts = await fetchVideoEngagement(page, video.videoId);
      if (!counts) return video;
      const patched = applyEngagementToVideo(video, counts);
      if ((patched.likes?.count || 0) > 0) withLikes += 1;
      if ((patched.comments?.count || 0) > 0) withComments += 1;
      return patched;
    } catch (e) {
      console.warn(
        `[yt-engagement] ${video.videoId} failed: ${e.message}`
      );
      return video;
    } finally {
      done += 1;
      options.onProgress?.(done, targets.length);
      if (delayMs > 0) await page.waitForTimeout(delayMs);
    }
  }

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((v) => enrichOne(v)));
    const idToIdx = new Map(out.map((v, idx) => [v.videoId, idx]));
    for (let j = 0; j < batch.length; j += 1) {
      const idx = idToIdx.get(results[j]?.videoId);
      if (idx >= 0) out[idx] = results[j];
    }
  }

  console.log(
    `[yt-engagement] enriched ${targets.length} videos likes=${withLikes} comments=${withComments}`
  );
  return out;
}
