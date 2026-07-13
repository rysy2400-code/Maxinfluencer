/**
 * YouTube innertube 直调：在已登录的 youtube.com 页面上下文内 POST API，无需打开搜索/频道页。
 */

import { extractSearchContinuationToken } from "./yt-search-pagination.js";
import {
  isLiteScraperMode,
  resolveYtLiteDisableEvaluateLock,
} from "../../../scraper/resolve-scraper-mode.js";

/** 搜索「视频」Tab 筛选参数（与 sp=EgIQAQ== 等价） */
export const YT_SEARCH_VIDEO_PARAMS = "EgIQAQ==";

/** 频道 /videos 完整列表（sort=dd 纵向 grid）；旧值 EgZ2aWRlb3M%3D 仅返回首页横滑 shelf ~12 条 */
export const YT_BROWSE_VIDEOS_PARAMS = "EgZ2aWRlb3MYAyAAcALyBg0KCzoEIgIIBKIBAggB";
/** @deprecated 首页横滑 shelf，翻页 token 易误指向 About 弹层 */
export const YT_BROWSE_VIDEOS_PARAMS_SHELF = "EgZ2aWRlb3M%3D";

/** 频道 /about Tab（innertube browse body 用裸 base64） */
export const YT_BROWSE_ABOUT_PARAMS_RAW = "EgVhYm91dA==";
/** Invidious 2023-11 更新的 about protobuf params */
export const YT_BROWSE_ABOUT_PARAMS_V2 = "EgVhYm91dPIGBAoCEgA=";
/** @deprecated JSON body 请用 YT_BROWSE_ABOUT_PARAMS_RAW */
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
  if (resolveYtLiteDisableEvaluateLock()) {
    return fn();
  }
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
 * @param {{ persistent?: boolean, forceNewTab?: boolean }} [options]
 */
export async function acquireYoutubeInnertubeSession(context, options = {}) {
  const forceNewTab = !!options.forceNewTab;
  const persistent =
    !forceNewTab &&
    options.persistent !== false &&
    (options.persistent === true ||
      (isLiteScraperMode() &&
        String(process.env.CDP_9222_PERSIST_PLATFORM_TABS ?? "true") !== "false"));
  const { openCdpTaskPage, closeCdpTaskPage } = await import("../../../cdp/cdp-tab-utils.js");

  let page = null;
  let pageCreated = false;
  let pageMode = "playwright";
  /** @type {{ id?: string }|null} */
  let cdpTarget = null;

  const preferCdp = process.env.YT_LITE_USE_CDP_PAGE !== "0";
  if (preferCdp) {
    try {
      const { acquireYoutubeCdpPage } = await import("../../../cdp/cdp-target-page.js");
      const cdpSession = await acquireYoutubeCdpPage(undefined, {
        forceNew: forceNewTab,
      });
      page = cdpSession.page;
      cdpTarget = cdpSession.target;
      pageMode = "cdp";
    } catch (e) {
      console.warn(`[innertube-direct] CDP page attach failed: ${e.message}`);
    }
  }

  if (!page && context && !forceNewTab) {
    page = context.pages().find((p) => {
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
  }

  if (!page) {
    if (!context) {
      throw new Error("YouTube innertube 会话不可用：无 CDP 上下文");
    }
    page = await openCdpTaskPage(context);
    pageCreated = true;
    pageMode = "playwright";
  }

  const unblock =
    pageMode === "playwright" && typeof page.route === "function"
      ? await attachLiteResourceBlocker(page)
      : pageMode === "cdp" && typeof page.enableLiteResourceBlocker === "function"
        ? await page.enableLiteResourceBlocker([...BLOCKED_RESOURCE_TYPES])
        : async () => {};

  async function teardownPage() {
    if (pageMode === "cdp" && cdpTarget?.id) {
      try {
        const { closeCdpTarget } = await import("../../../cdp/cdp-target-page.js");
        await closeCdpTarget(undefined, cdpTarget.id);
      } catch {
        /* ignore */
      }
    }
    if (typeof page?.dispose === "function") {
      try {
        await page.dispose();
      } catch {
        /* ignore */
      }
      return;
    }
    if (pageCreated || forceNewTab) {
      try {
        if (!page.isClosed()) await closeCdpTaskPage(page);
      } catch {
        try {
          if (!page.isClosed()) await page.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  try {
    const currentUrl = typeof page.url === "function" ? page.url() : "";
    if (!String(currentUrl).includes("youtube.com")) {
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
    await teardownPage();
    throw e;
  }

  return {
    page,
    persistent,
    async dispose() {
      await unblock();
      if (persistent) {
        try {
          const { releaseLitePersistentPage } = await import("../../../cdp/cdp-tab-utils.js");
          await releaseLitePersistentPage(page, { persistent: true, platform: "youtube" });
        } catch {
          /* ignore */
        }
        return;
      }
      await teardownPage();
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
  const params = process.env.YT_BROWSE_VIDEOS_PARAMS || YT_BROWSE_VIDEOS_PARAMS;
  return postInnertube(page, "browse", {
    browseId,
    params,
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
  const params =
    process.env.YT_BROWSE_ABOUT_PARAMS ||
    YT_BROWSE_ABOUT_PARAMS_RAW;
  return postInnertube(page, "browse", {
    browseId,
    params,
  });
}

function walkAboutChannelViewModel(obj, depth = 0) {
  if (depth > 24 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const found = walkAboutChannelViewModel(x, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (obj.aboutChannelViewModel) return obj.aboutChannelViewModel;
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v) {
      const found = walkAboutChannelViewModel(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 从 browse /about 首屏 JSON 提取 About 弹层 continuation token（yt-dlp #8634 / Scrapfly 路径）
 * @param {object|null} json
 */
export function extractAboutBrowseContinuationToken(json) {
  if (!json || typeof json !== "object") return null;
  const stack = [json];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      stack.push(...cur);
      continue;
    }
    const token =
      cur.continuationCommand?.token ||
      cur.continuationEndpoint?.continuationCommand?.token ||
      null;
    if (token && typeof token === "string") return token;
    for (const v of Object.values(cur)) {
      if (typeof v === "object" && v) stack.push(v);
    }
  }
  return null;
}

/**
 * 两步 innertube browse：about tab → continuation → aboutChannelViewModel（含 country）
 * 无需 page.goto(/about)。参考 Invidious about.cr、yt-dlp #8634、Scrapfly aboutChannelViewModel。
 * @param {import('playwright').Page} page
 * @param {{ browseId?: string, handle?: string }} target
 * @returns {Promise<{ browseJson: object, viewModel: object|null, source: string }|null>}
 */
export async function fetchChannelAboutViewModel(page, target = {}) {
  const browseId = await resolveBrowseTarget(page, target);
  if (!browseId) return null;

  const params =
    process.env.YT_BROWSE_ABOUT_PARAMS ||
    YT_BROWSE_ABOUT_PARAMS_RAW;

  const first = await postInnertube(page, "browse", { browseId, params });
  if (!first) return null;

  let vm = walkAboutChannelViewModel(first);
  if (vm) {
    return { browseJson: first, viewModel: vm, source: "innertube_about_api" };
  }

  const token = extractAboutBrowseContinuationToken(first);
  if (!token) {
    return { browseJson: first, viewModel: null, source: "innertube_about_shell" };
  }

  const second = await postInnertube(page, "browse", { continuation: token });
  vm = walkAboutChannelViewModel(second);
  return {
    browseJson: second || first,
    viewModel: vm || null,
    source: vm ? "innertube_about_continuation" : "innertube_about_no_vm",
  };
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
