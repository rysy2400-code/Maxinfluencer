/**
 * YouTube innertube 直调：在已登录的 youtube.com 页面上下文内 POST API，无需打开搜索/频道页。
 */

import { extractSearchContinuationToken } from "./yt-search-pagination.js";

/** 搜索「视频」Tab 筛选参数（与 sp=EgIQAQ== 等价） */
export const YT_SEARCH_VIDEO_PARAMS = "EgIQAQ==";

/** 频道 /videos Tab */
export const YT_BROWSE_VIDEOS_PARAMS = "EgZ2aWRlb3M%3D";

/** 频道 /about Tab */
export const YT_BROWSE_ABOUT_PARAMS = "EgVhYm91dA%3D%3D";

const BLOCKED_RESOURCE_TYPES = new Set(
  String(process.env.LITE_BLOCK_RESOURCE_TYPES || "image,media,font")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/** 同一 Playwright page 上串行 evaluate，避免并发 postInnertube 导致 Target closed */
const pageEvaluateChains = new WeakMap();

function withPageEvaluateLock(page, fn) {
  const prev = pageEvaluateChains.get(page) || Promise.resolve();
  const run = prev.then(() => fn());
  pageEvaluateChains.set(
    page,
    run.catch(() => {}).then(() => undefined)
  );
  return run;
}

function walkBrowseIdFromJson(obj, depth = 0) {
  if (depth > 24 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const found = walkBrowseIdFromJson(x, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const bid =
    obj.browseId ||
    obj.browseEndpoint?.browseId ||
    obj.payload?.browseId ||
    obj.endpoint?.browseEndpoint?.browseId;
  if (typeof bid === "string" && bid.startsWith("UC")) return bid;
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v) {
      const found = walkBrowseIdFromJson(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @param {import('playwright').Page} page
 */
export async function attachLiteResourceBlocker(page) {
  if (BLOCKED_RESOURCE_TYPES.size === 0) return () => {};
  const handler = async (route) => {
    const type = route.request().resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(type)) {
      await route.abort();
      return;
    }
    await route.continue();
  };
  await page.route("**/*", handler);
  return async () => {
    try {
      await page.unroute("**/*", handler);
    } catch {
      /* ignore */
    }
  };
}

/**
 * 初始化 innertube 会话：仅访问 youtube.com 首页一次以加载 ytcfg + cookie
 * @param {import('playwright').BrowserContext} context
 */
export async function acquireYoutubeInnertubeSession(context) {
  const { openCdpTaskPage } = await import("../../../cdp/cdp-tab-utils.js");
  let page = context.pages().find((p) => {
    try {
      return p && !p.isClosed() && String(p.url() || "").includes("youtube.com");
    } catch {
      return false;
    }
  });
  if (!page) {
    page = context.pages().find((p) => {
      try {
        return p && !p.isClosed();
      } catch {
        return false;
      }
    });
  }
  if (!page) {
    page = await openCdpTaskPage(context);
  }
  const unblock = await attachLiteResourceBlocker(page);

  try {
    const currentUrl = page.url();
    if (!currentUrl.includes("youtube.com")) {
      await page.goto("https://www.youtube.com", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }
    await page.waitForTimeout(
      Math.min(Math.max(Number(process.env.YT_LITE_SESSION_SETTLE_MS) || 2500, 800), 8000)
    );
    const ready = await waitForInnertubeReady(page, 15_000);
    if (!ready) {
      throw new Error("innertube ytcfg 未就绪，请确认 9222 Chrome 已登录 YouTube");
    }
  } catch (e) {
    await unblock();
    try {
      if (!page.isClosed()) await page.close();
    } catch {
      /* ignore */
    }
    throw e;
  }

  return {
    page,
    async dispose() {
      await unblock();
      try {
        if (!page.isClosed()) await page.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 */
export async function waitForInnertubeReady(page, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate(() => {
      const ytcfg = window.ytcfg?.data_ || {};
      const apiKey =
        ytcfg.INNERTUBE_API_KEY ||
        (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_API_KEY") : null);
      const ctx =
        ytcfg.INNERTUBE_CONTEXT ||
        (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_CONTEXT") : null);
      return !!(apiKey && ctx);
    });
    if (ok) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} endpoint search | browse | next
 * @param {object} body
 */
export async function postInnertube(page, endpoint, body) {
  try {
    const json = await withPageEvaluateLock(page, () =>
      page.evaluate(
        async ({ endpoint, body }) => {
          const ytcfg = window.ytcfg?.data_ || {};
          const apiKey =
            ytcfg.INNERTUBE_API_KEY ||
            (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_API_KEY") : null);
          const ctx =
            ytcfg.INNERTUBE_CONTEXT ||
            (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_CONTEXT") : null);
          if (!apiKey || !ctx) return { __error: "missing_ytcfg" };

          const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
          const payload = { ...body, context: body.context || ctx };
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(payload),
          });
          if (!res.ok) return { __error: `http_${res.status}` };
          return res.json();
        },
        { endpoint, body }
      )
    );
    if (!json || json.__error) {
      console.warn(`[innertube-direct] ${endpoint} failed: ${json?.__error || "empty"}`);
      return null;
    }
    return json;
  } catch (e) {
    console.warn(`[innertube-direct] ${endpoint} evaluate: ${e.message}`);
    return null;
  }
}

/**
 * @handle → UC channelId（browse 不接受裸 @handle）
 * @param {import('playwright').Page} page
 * @param {string} handleOrUrl
 */
export async function resolveChannelBrowseId(page, handleOrUrl) {
  const raw = String(handleOrUrl || "").trim();
  if (!raw) return null;
  if (raw.startsWith("UC")) return raw;
  const url = raw.startsWith("http")
    ? raw
    : `https://www.youtube.com/@${encodeURIComponent(raw.replace(/^@/, ""))}`;
  const json = await postInnertube(page, "navigation/resolve_url", {
    url,
    parse: true,
  });
  const browseId = walkBrowseIdFromJson(json);
  if (browseId) return browseId;
  console.warn(`[innertube-direct] resolve_url 未得到 UC browseId: ${url}`);
  return null;
}

/**
 * @param {{ browseId?: string, handle?: string }} target
 */
export async function resolveBrowseTarget(page, target = {}) {
  const browseId = target.browseId?.startsWith("UC") ? target.browseId : null;
  if (browseId) return browseId;
  if (target.handle) {
    return resolveChannelBrowseId(page, target.handle);
  }
  return null;
}

/**
 * 关键词搜索（视频 Tab）首屏
 * @param {import('playwright').Page} page
 * @param {string} keyword
 */
export async function fetchSearchFirstPage(page, keyword) {
  return postInnertube(page, "search", {
    query: String(keyword || "").trim(),
    params: YT_SEARCH_VIDEO_PARAMS,
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {string} continuationToken
 */
export async function fetchSearchContinuation(page, continuationToken) {
  if (!continuationToken) return null;
  return postInnertube(page, "search", { continuation: continuationToken });
}

/**
 * 频道 /videos 首屏
 * @param {import('playwright').Page} page
 * @param {{ browseId?: string, handle?: string }} target
 */
export async function fetchChannelVideosFirstPage(page, target = {}) {
  const browseId = await resolveBrowseTarget(page, target);
  if (!browseId) return null;
  return postInnertube(page, "browse", {
    browseId,
    params: YT_BROWSE_VIDEOS_PARAMS,
  });
}

/**
 * 频道 /about
 * @param {import('playwright').Page} page
 * @param {{ browseId?: string, handle?: string }} target
 */
export async function fetchChannelAbout(page, target = {}) {
  const browseId = await resolveBrowseTarget(page, target);
  if (!browseId) return null;
  return postInnertube(page, "browse", {
    browseId,
    params: YT_BROWSE_ABOUT_PARAMS,
  });
}

/**
 * browse/next continuation
 * @param {import('playwright').Page} page
 * @param {string} continuationToken
 */
export async function fetchBrowseContinuation(page, continuationToken) {
  if (!continuationToken) return null;
  let json = await postInnertube(page, "browse", { continuation: continuationToken });
  if (json) return json;
  return postInnertube(page, "next", { continuation: continuationToken });
}

export function resolveLiteContinuationConfig() {
  return {
    maxPages: Math.min(
      Math.max(Number(process.env.YT_LITE_MAX_CONTINUATION_PAGES || 40), 3),
      80
    ),
    delayMs: Math.min(
      Math.max(Number(process.env.YT_LITE_CONTINUATION_DELAY_MS || 40), 0),
      300
    ),
    stallPages: Math.max(Number(process.env.YT_LITE_CONT_STALL_PAGES || 2), 1),
  };
}

/**
 * 通用 continuation 翻页
 * @param {import('playwright').Page} page
 * @param {object[]} jsonSources
 * @param {(json: object) => void} onJson
 * @param {{ fetchPage: (token: string) => Promise<object|null>, getProgress?: () => string, maxPages?: number }} options
 */
export async function paginateViaContinuation(page, jsonSources, onJson, options = {}) {
  const cfg = resolveLiteContinuationConfig();
  const maxPages = options.maxPages ?? cfg.maxPages;
  const delayMs = options.delayMs ?? cfg.delayMs;
  const stallLimit = options.stallPages ?? cfg.stallPages;
  const fetchPage = options.fetchPage || fetchSearchContinuation;

  let token = options.startToken ?? null;
  if (!token && Array.isArray(jsonSources)) {
    for (let i = jsonSources.length - 1; i >= 0 && !token; i--) {
      token = extractSearchContinuationToken(jsonSources[i]);
    }
  }
  if (!token) return { pages: 0 };

  let pages = 0;
  let prevProgress = options.getProgress?.() ?? "";
  let stall = 0;

  while (token && pages < maxPages) {
    const json = await fetchPage(page, token);
    if (!json) break;
    onJson(json);
    pages += 1;

    const progress = options.getProgress?.() ?? "";
    if (progress === prevProgress) {
      stall += 1;
      if (stall >= stallLimit) break;
    } else {
      stall = 0;
      prevProgress = progress;
    }

    token = extractSearchContinuationToken(json);
    if (delayMs > 0) await page.waitForTimeout(delayMs);
  }

  return { pages };
}
