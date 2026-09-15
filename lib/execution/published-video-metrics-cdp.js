/**
 * 通过 CDP + API 拦截抓取已发布视频的播放/点赞/评论数据（TikTok / Instagram / YouTube）。
 */

import { parsePublishedVideoUrl } from "./published-video-url.js";
import { igShortcodeToMediaId } from "./instagram-shortcode.js";
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
import {
  classifyTikTokApiKind,
  logTikTokTraffic,
} from "../utils/tt-traffic-log.js";

const DEFAULT_GOTO_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 5_000;
const BLOCKED_RESOURCE_TYPES = new Set(
  String(process.env.METRICS_BLOCK_RESOURCE_TYPES || "image,media,font")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function resolveMetricsCdpEndpoint() {
  return (
    process.env.CDP_ENDPOINT_METRICS ||
    process.env.CDP_ENDPOINT_ENRICH ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9222"
  );
}

function resolveLocalProxyPort() {
  const n = Number(process.env.PUBLISHED_METRICS_LOCAL_PROXY_PORT || 7897);
  return Number.isFinite(n) && n > 0 ? n : 7897;
}

/** 拦截 image/media/font，尽量压缩浏览器流量（图片已由代理侧/页面本身决定，这里本地直接 abort）。 */
async function installResourceBlocking(page) {
  if (!page) return async () => {};
  try {
    if (typeof page.enableLiteResourceBlocker === "function") {
      return await page.enableLiteResourceBlocker([...BLOCKED_RESOURCE_TYPES]);
    }
    if (typeof page.route === "function") {
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (BLOCKED_RESOURCE_TYPES.has(type)) {
          return route.abort().catch(() => {});
        }
        return route.continue().catch(() => {});
      });
      return async () => {
        try {
          await page.unroute("**/*");
        } catch {
          /* ignore */
        }
      };
    }
  } catch {
    /* ignore */
  }
  return async () => {};
}

/** 通过本地代理解析 tiktok.com/t/ 短链，只读 Location，不打开视频页（≈1 个小请求）。 */
async function resolveShortLinkVideoId(url, proxyPort) {
  try {
    const { ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(`http://127.0.0.1:${proxyPort}`);
    const res = await fetch(url, {
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    });
    const location = res.headers.get("location") || res.url || "";
    const m = location.match(/\/video\/(\d+)/);
    if (m) {
      logTikTokTraffic("short_link_resolve", 512, url, `-> ${location.slice(0, 140)}`);
      return m[1];
    }
  } catch {
    /* 走 fallback */
  }
  return null;
}

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
      return fetchTikTokMetrics(parsed, {
        endpoint: options.endpoint || resolveMetricsCdpEndpoint(),
        proxyPort: options.proxyPort || resolveLocalProxyPort(),
      });
    case "instagram":
      return fetchInstagramMetrics(page, parsed, { gotoTimeout, settleMs });
    case "youtube":
      return fetchYoutubeMetrics(page, parsed, { gotoTimeout, settleMs });
    case "x":
      // X 推文互动指标走 tweet API（后续迭代）；当前不阻塞交付流程
      console.warn(`[published-video-metrics] X 平台指标刷新暂未实现，跳过: ${parsed.url}`);
      return { platform: "x", postId: parsed.videoId, views: null, likes: null, comments: null, source: "x_unsupported" };
    default:
      throw new Error(`不支持的平台: ${parsed.platform}`);
  }
}

/**
 * TikTok API-only：不打开视频页面。
 * 1) 短链只解析 Location；2) 复用 9222 的 tiktok.com tab（acrawler 常驻）；
 * 3) 走 /api/post/item_detail/ 签名 fetch 拿 itemInfo.itemStruct.stats。
 */
export async function fetchTikTokMetrics(parsed, options = {}) {
  const endpoint = options.endpoint || resolveMetricsCdpEndpoint();
  const proxyPort = options.proxyPort || resolveLocalProxyPort();
  let itemId = parsed.videoId;
  if (!itemId && parsed.url) {
    itemId = await resolveShortLinkVideoId(parsed.url, proxyPort);
  }
  if (!itemId) {
    throw new Error(`TikTok 无法解析视频 ID: ${parsed.url}`);
  }

  const { acquireTiktokCdpPage } = await import("../cdp/cdp-target-page.js");
  const { bootstrapTiktokWebSession, tiktokMakeRequest } = await import(
    "../tools/influencer-functions/tiktok/tiktok-api-client.js"
  );

  const { page } = await acquireTiktokCdpPage(endpoint, {});
  const unblock = await installResourceBlocking(page);
  let payloadBytes = 0;
  let docBytes = 0;
  const handler = async (response) => {
    const url = response.url();
    if (response.request()?.resourceType?.() === "document") {
      try {
        const body = await response.body();
        docBytes += body?.length || 0;
      } catch {
        /* ignore */
      }
    }
  };
  page.on("response", handler);

  try {
    const referer =
      parsed.url && parsed.url.includes("tiktok.com")
        ? parsed.url
        : `https://www.tiktok.com/@${parsed.username || "unknown"}/video/${itemId}`;
    const apiUrl = "https://www.tiktok.com/api/post/item_detail/";

    let json = null;
    let detail = null;
    let apiOk = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await bootstrapTiktokWebSession(
          page,
          attempt > 0 ? { forceRefresh: true } : {}
        );
        json = await tiktokMakeRequest(
          page,
          apiUrl,
          { itemId },
          { referer, retries: 1 }
        );
        detail = extractVideoDetailFromAPI(json, parsed.username || "unknown");
        if (
          detail?.views?.count ||
          detail?.likes?.count ||
          detail?.comments?.count
        ) {
          apiOk = true;
          break;
        }
        throw new Error(
          `TikTok item_detail 无统计数据: ${parsed.url} keys=${Object.keys(json || {}).slice(0, 8).join(",")}`
        );
      } catch (e) {
        if (attempt === 0) {
          // IP 轮换后旧 tab 会话可能被 TikTok 风控：重载首页重建 acrawler/cookie 后重试一次
          console.warn(
            `[published-video-metrics] TikTok 首次 API 请求失败，重载 tab 重试: ${String(e.message || e).slice(0, 160)}`
          );
          try {
            await page.goto("https://www.tiktok.com/", {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            });
            await page.waitForTimeout(1500);
          } catch {
            /* ignore */
          }
          continue;
        }
        console.warn(
          `[published-video-metrics] TikTok API-only 失败，回退到页面拦截: ${String(e.message || e).slice(0, 160)}`
        );
        break;
      }
    }

    if (apiOk) {
      if (docBytes > 0) {
        logTikTokTraffic("bootstrap", docBytes, "https://www.tiktok.com/");
      }
      const bytes = new TextEncoder().encode(JSON.stringify(json)).length;
      logTikTokTraffic(
        classifyTikTokApiKind("/api/post/item_detail/"),
        bytes,
        `${apiUrl}?itemId=${itemId}`,
        `video=${itemId}`
      );
      return {
        platform: "tiktok",
        ...normalizeMetricsPayload({
          views: detail.views?.count,
          likes: detail.likes?.count,
          comments: detail.comments?.count,
        }),
        source: "tiktok_item_detail_api",
        trafficBytes: bytes + payloadBytes + docBytes,
      };
    }

    // 回退：以最小流量打开视频页（图片/媒体/字体已本地拦截），拦截页面自身发出的 item_detail API
    const canonicalUrl =
      parsed.url && parsed.url.includes("tiktok.com")
        ? parsed.url
        : `https://www.tiktok.com/@${parsed.username || "unknown"}/video/${itemId}`;
    const intercepted = [];
    const navHandler = async (response) => {
      const url = response.url();
      if (!isTikTokApiUrl(url)) return;
      try {
        const text = await response.text();
        if (!text || text[0] !== "{") return;
        payloadBytes += new TextEncoder().encode(text).length;
        intercepted.push(JSON.parse(text));
      } catch {
        /* ignore */
      }
    };
    page.on("response", navHandler);
    try {
      await page.goto(canonicalUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(4000);
      try {
        await page.waitForLoadState("networkidle", { timeout: 6000 });
      } catch {
        /* ok */
      }
      await page.waitForTimeout(1500);
    } finally {
      page.off("response", navHandler);
    }

    for (const j of intercepted) {
      const d = extractVideoDetailFromAPI(j, parsed.username || "unknown");
      if (d && String(d.videoId) === String(itemId) && (d.views?.count || d.likes?.count)) {
        return {
          platform: "tiktok",
          ...normalizeMetricsPayload({
            views: d.views?.count,
            likes: d.likes?.count,
            comments: d.comments?.count,
          }),
          source: "tiktok_page_intercept",
          trafficBytes: payloadBytes + docBytes,
        };
      }
      const m = metricsFromTikTokItem(pickTikTokItemFromJson(j, itemId));
      if (m && (m.views > 0 || m.likes > 0)) {
        return {
          platform: "tiktok",
          ...m,
          source: "tiktok_page_intercept",
          trafficBytes: payloadBytes + docBytes,
        };
      }
    }

    const embedded = await readTikTokUniversalItem(page, itemId);
    const fromEmbedded = metricsFromTikTokItem(embedded);
    if (fromEmbedded && (fromEmbedded.views > 0 || fromEmbedded.likes > 0)) {
      return {
        platform: "tiktok",
        ...fromEmbedded,
        source: "tiktok_universal_data",
        trafficBytes: payloadBytes + docBytes,
      };
    }
    throw new Error(`TikTok 页面拦截也未拿到数据: ${canonicalUrl}`);
  } finally {
    page.off("response", handler);
    await unblock().catch(() => {});
    if (typeof page.dispose === "function") {
      await page.dispose().catch(() => {});
    }
  }
}

const IG_HOME_URL = "https://www.instagram.com/";
const IG_APP_ID = "936619743392459";

/**
 * API 优先：复用已登录 tab 直调私有接口 /api/v1/media/{id}/info/ 拿 play_count。
 * 页面 GraphQL 常常不带播放量（views=0），而私有接口稳定返回 play_count / ig_play_count。
 * 不加载帖子页面，避免页面风控与导航失败。
 */
async function fetchInstagramMetricsViaApi(page, parsed, { gotoTimeout } = {}) {
  const mediaId = parsed.videoId || igShortcodeToMediaId(parsed.shortcode);
  if (!page || !mediaId) return null;

  if (!/instagram\.com/.test(String(page.url() || ""))) {
    await page.goto(IG_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: gotoTimeout || 60_000,
    });
  }

  return page.evaluate(
    async ({ mediaId, shortcode }) => {
      const endpoints = [
        `https://www.instagram.com/api/v1/media/${mediaId}/info/`,
        `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
      ];
      let trafficBytes = 0;
      let lastStatus = null;
      for (const url of endpoints) {
        try {
          const r = await fetch(url, {
            headers: { "x-ig-app-id": "936619743392459" },
            credentials: "include",
          });
          const text = await r.text();
          trafficBytes += text.length;
          lastStatus = r.status;
          if (!r.ok) continue;
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            continue;
          }
          const items = Array.isArray(json?.items) ? json.items : [];
          const item =
            items.find(
              (x) => String(x?.code || x?.shortcode || "") === String(shortcode)
            ) || items[0];
          if (!item) continue;
          return {
            trafficBytes,
            status: r.status,
            mediaId: String(item.pk || item.id || mediaId),
            code: item.code || item.shortcode || null,
            views: Number(
              item.play_count ?? item.ig_play_count ?? item.video_view_count ?? 0
            ) || 0,
            likes: Number(item.like_count ?? 0) || 0,
            comments: Number(item.comment_count ?? 0) || 0,
          };
        } catch {
          /* try next endpoint */
        }
      }
      return { trafficBytes, status: lastStatus, failed: true };
    },
    { mediaId, shortcode: parsed.shortcode }
  );
}

async function fetchInstagramMetrics(page, parsed, { gotoTimeout, settleMs }) {
  const medias = [];
  let trafficBytes = 0;

  // 1) API 优先（不加载帖子页）
  let apiError = null;
  try {
    const api = await fetchInstagramMetricsViaApi(page, parsed, { gotoTimeout });
    if (api && !api.failed) {
      const views = Number(api.views) || 0;
      const likes = Number(api.likes) || 0;
      const comments = Number(api.comments) || 0;
      if (views > 0 || likes > 0 || comments > 0) {
        return {
          platform: "instagram",
          ...normalizeMetricsPayload({ views, likes, comments }),
          source: "instagram_api_private",
          trafficBytes: Number(api.trafficBytes) || 0,
        };
      }
      apiError = new Error(`Instagram 私有接口返回全 0（status=${api.status}）`);
    } else if (api) {
      apiError = new Error(`Instagram 私有接口异常（status=${api.status ?? "-"}）`);
    }
  } catch (err) {
    apiError = err;
  }

  // 2) 兜底：加载帖子页并拦截 GraphQL
  const handler = async (response) => {
    const url = response.url();
    if (!isInstagramApiUrl(url)) return;
    try {
      const text = await response.text();
      if (!text || (text[0] !== "{" && text[0] !== "[")) return;
      trafficBytes += new TextEncoder().encode(text).length;
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
    throw new Error(
      `Instagram 未拦截到帖子数据: ${parsed.url}${
        apiError ? `（私有接口兜底失败：${apiError.message}）` : ""
      }`
    );
  }

  return { platform: "instagram", ...metrics, source: "instagram_api", trafficBytes };
}

async function fetchYoutubeMetrics(page, parsed, { gotoTimeout, settleMs }) {
  const payloads = [];
  let trafficBytes = 0;

  const handler = async (response) => {
    const url = response.url();
    if (!isYoutubeInnertubeUrl(url)) return;
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      trafficBytes += new TextEncoder().encode(text).length;
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

  return {
    platform: "youtube",
    ...normalized,
    source: "youtube_innertube",
    trafficBytes,
  };
}
