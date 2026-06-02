/**
 * 通过 CDP + API 拦截抓取已发布视频的播放/点赞/评论数据（TikTok / Instagram / YouTube）。
 */

import { parsePublishedVideoUrl } from "./published-video-url.js";
import {
  normalizeMetricsPayload,
  parseYoutubeViewCountText,
} from "./published-video-metrics-format.js";
import { extractVideoDetailFromAPI } from "./cdp/tiktok-video-detail.js";
import {
  extractMediaNodesFromJson,
  extractIgPlayCount,
  mapIgMediaToSearchPost,
} from "../tools/influencer-functions/instagram/instagram-json-utils.js";

const DEFAULT_GOTO_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 5_000;

function isTikTokApiUrl(url) {
  return url.includes("tiktok.com/api/") || url.includes("tiktokv.com");
}

function isInstagramApiUrl(url) {
  return (
    url.includes("instagram.com") &&
    (url.includes("/graphql") ||
      url.includes("/api/") ||
      url.includes("i.instagram.com"))
  );
}

function isYoutubeInnertubeUrl(url) {
  return url.includes("youtube.com") && url.includes("/youtubei/v1/");
}

function pickTikTokItemFromJson(json, videoId) {
  if (!json || typeof json !== "object") return null;
  if (json.itemInfo?.itemStruct) {
    const item = json.itemInfo.itemStruct;
    if (!videoId || String(item.id) === String(videoId)) return item;
  }
  if (Array.isArray(json.itemList)) {
    const hit = json.itemList.find((x) => String(x?.id) === String(videoId));
    if (hit) return hit;
  }
  return null;
}

function metricsFromTikTokItem(item) {
  if (!item?.stats) return null;
  const s = item.stats;
  return normalizeMetricsPayload({
    views: s.playCount,
    likes: s.diggCount,
    comments: s.commentCount,
  });
}

function metricsFromIgNode(node) {
  if (!node) return null;
  const mapped = mapIgMediaToSearchPost(node);
  return normalizeMetricsPayload({
    views: extractIgPlayCount(node),
    likes: mapped.likes?.count,
    comments: mapped.comments?.count,
  });
}

function walkExtractYoutubeCounts(json, out) {
  if (!json || typeof json !== "object") return;
  if (Array.isArray(json)) {
    json.forEach((x) => walkExtractYoutubeCounts(x, out));
    return;
  }

  if (json.videoDetails?.viewCount != null && out.views == null) {
    out.views = parseYoutubeViewCountText(json.videoDetails.viewCount);
  }
  if (json.viewCount != null && out.views == null) {
    const vc =
      typeof json.viewCount === "object"
        ? json.viewCount.simpleText || json.viewCount.runs?.[0]?.text
        : json.viewCount;
    out.views = parseYoutubeViewCountText(vc);
  }

  for (const key of [
    "likeCount",
    "likesCount",
    "favoriteCount",
    "commentCount",
    "commentCountText",
  ]) {
    if (json[key] == null) continue;
    const raw =
      typeof json[key] === "object"
        ? json[key].simpleText ||
          json[key].content ||
          json[key].runs?.[0]?.text ||
          json[key].text
        : json[key];
    const n = parseYoutubeViewCountText(raw);
    if (key.toLowerCase().includes("comment") && out.comments == null && n >= 0) {
      out.comments = n;
    } else if (key.toLowerCase().includes("like") && out.likes == null && n >= 0) {
      out.likes = n;
    }
  }

  for (const v of Object.values(json)) {
    if (v && typeof v === "object") walkExtractYoutubeCounts(v, out);
  }
}

async function readTikTokUniversalItem(page, videoId) {
  try {
    return await page.evaluate((vid) => {
      const script = document.querySelector(
        'script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]'
      );
      if (!script?.textContent) return null;
      try {
        const data = JSON.parse(script.textContent);
        const scopes = [
          data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct,
          data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo
            ?.itemStruct,
        ];
        for (const item of scopes) {
          if (item && String(item.id) === String(vid)) return item;
        }
      } catch {
        return null;
      }
      return null;
    }, videoId);
  } catch {
    return null;
  }
}

async function readYoutubeEmbeddedJson(page) {
  try {
    return await page.evaluate(() => {
      const out = { player: null, initial: null };
      for (const s of Array.from(document.querySelectorAll("script"))) {
        const t = s.textContent || "";
        if (!out.player && t.includes("ytInitialPlayerResponse")) {
          const m = t.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
          if (m) {
            try {
              out.player = JSON.parse(m[1]);
            } catch {
              /* ignore */
            }
          }
        }
        if (!out.initial && t.includes("ytInitialData")) {
          const m = t.match(/var ytInitialData = (\{.+?\});/s);
          if (m) {
            try {
              out.initial = JSON.parse(m[1]);
            } catch {
              /* ignore */
            }
          }
        }
      }
      return out;
    });
  } catch {
    return { player: null, initial: null };
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} videoUrl
 */
export async function fetchPublishedVideoMetricsViaCdp(page, videoUrl, options = {}) {
  const parsed = parsePublishedVideoUrl(videoUrl);
  if (!parsed.url || parsed.platform === "unknown") {
    throw new Error(`无法识别视频平台或链接无效: ${videoUrl}`);
  }

  const gotoTimeout = options.gotoTimeoutMs ?? DEFAULT_GOTO_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

  switch (parsed.platform) {
    case "tiktok":
      return fetchTikTokMetrics(page, parsed, { gotoTimeout, settleMs });
    case "instagram":
      return fetchInstagramMetrics(page, parsed, { gotoTimeout, settleMs });
    case "youtube":
      return fetchYoutubeMetrics(page, parsed, { gotoTimeout, settleMs });
    default:
      throw new Error(`不支持的平台: ${parsed.platform}`);
  }
}

async function fetchTikTokMetrics(page, parsed, { gotoTimeout, settleMs }) {
  const intercepted = [];

  const handler = async (response) => {
    const url = response.url();
    if (response.status() >= 300 && response.status() < 400) return;
    if (!isTikTokApiUrl(url)) return;
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      intercepted.push(JSON.parse(text));
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  try {
    await page.goto(parsed.url, {
      waitUntil: "domcontentloaded",
      timeout: gotoTimeout,
    });
    await page.waitForTimeout(settleMs);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      /* ok */
    }
    await page.waitForTimeout(1500);
  } finally {
    page.off("response", handler);
  }

  for (const json of intercepted) {
    const detail = extractVideoDetailFromAPI(
      json,
      parsed.username || "unknown"
    );
    if (
      detail &&
      (!parsed.videoId || String(detail.videoId) === String(parsed.videoId))
    ) {
      return {
        platform: "tiktok",
        ...normalizeMetricsPayload({
          views: detail.views?.count,
          likes: detail.likes?.count,
          comments: detail.comments?.count,
        }),
        source: "tiktok_item_detail_api",
      };
    }
    const item = pickTikTokItemFromJson(json, parsed.videoId);
    const m = metricsFromTikTokItem(item);
    if (m && (m.views > 0 || m.likes > 0 || m.comments > 0)) {
      return { platform: "tiktok", ...m, source: "tiktok_api" };
    }
  }

  const embedded = await readTikTokUniversalItem(page, parsed.videoId);
  const fromEmbedded = metricsFromTikTokItem(embedded);
  if (fromEmbedded && (fromEmbedded.views > 0 || fromEmbedded.likes > 0)) {
    return { platform: "tiktok", ...fromEmbedded, source: "tiktok_universal_data" };
  }

  throw new Error(`TikTok 未拦截到视频数据: ${parsed.url}`);
}

async function fetchInstagramMetrics(page, parsed, { gotoTimeout, settleMs }) {
  const medias = [];

  const handler = async (response) => {
    const url = response.url();
    if (!isInstagramApiUrl(url)) return;
    try {
      const text = await response.text();
      if (!text || (text[0] !== "{" && text[0] !== "[")) return;
      const json = JSON.parse(text);
      medias.push(...extractMediaNodesFromJson(json));
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  try {
    await page.goto(parsed.url, {
      waitUntil: "domcontentloaded",
      timeout: gotoTimeout,
    });
    await page.waitForTimeout(settleMs);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      /* ok */
    }
    await page.waitForTimeout(1500);
  } finally {
    page.off("response", handler);
  }

  const code = parsed.shortcode;
  const hit =
    medias.find((m) => String(m.code || m.shortcode) === String(code)) ||
    medias.find((m) => String(m.code || m.shortcode).startsWith(String(code))) ||
    medias[0];

  const metrics = metricsFromIgNode(hit);
  if (!metrics || (metrics.views === 0 && metrics.likes === 0 && metrics.comments === 0)) {
    throw new Error(`Instagram 未拦截到帖子数据: ${parsed.url}`);
  }

  return { platform: "instagram", ...metrics, source: "instagram_api" };
}

async function fetchYoutubeMetrics(page, parsed, { gotoTimeout, settleMs }) {
  const payloads = [];

  const handler = async (response) => {
    const url = response.url();
    if (!isYoutubeInnertubeUrl(url)) return;
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      payloads.push(JSON.parse(text));
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);
  try {
    await page.goto(parsed.url, {
      waitUntil: "domcontentloaded",
      timeout: gotoTimeout,
    });
    await page.waitForTimeout(settleMs);
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      /* ok */
    }
    await page.waitForTimeout(2000);
  } finally {
    page.off("response", handler);
  }

  const counts = { views: null, likes: null, comments: null };
  for (const json of payloads) {
    walkExtractYoutubeCounts(json, counts);
  }

  const embedded = await readYoutubeEmbeddedJson(page);
  if (embedded.player) walkExtractYoutubeCounts(embedded.player, counts);
  if (embedded.initial) walkExtractYoutubeCounts(embedded.initial, counts);

  const normalized = normalizeMetricsPayload(counts);
  if (normalized.views === 0 && normalized.likes === 0 && normalized.comments === 0) {
    throw new Error(`YouTube 未拦截到视频数据: ${parsed.url}`);
  }

  return { platform: "youtube", ...normalized, source: "youtube_innertube" };
}
