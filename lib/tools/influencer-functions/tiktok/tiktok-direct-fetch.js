/**
 * TikTok API 直调：在 tiktok.com 页面上下文内 fetch，参考 TikTok-Api 思路，尽量不打开搜索/主页。
 */

import { openCdpTaskPage, closeCdpTaskPage } from "../../../cdp/cdp-tab-utils.js";

const BLOCKED_RESOURCE_TYPES = new Set(
  String(process.env.LITE_BLOCK_RESOURCE_TYPES || "image,media,font")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/** @type {Map<string, { urlPrefix: string, params: URLSearchParams, updatedAt: number }>} */
const searchTemplateStore = new Map();

const TT_WEB_SEARCH_CODE =
  process.env.TT_WEB_SEARCH_CODE ||
  '{"tiktok":{"client_params_x":{"search_engine":{"ies_mt_user_live_video_card_use_libra":1,"mt_search_general_user_live_card":1}},"search_server":{}}}';

function resolveSessionKey(page) {
  if (page?._ttApiSessionKey) return page._ttApiSessionKey;
  return process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
}

function isUsableTiktokPage(page) {
  try {
    if (!page || page.isClosed()) return false;
    const url = String(page.url?.() || "");
    if (url.startsWith("chrome-error:")) return false;
    return url.includes("tiktok.com") || url === "about:blank";
  } catch {
    return false;
  }
}

async function ensureTiktokOrigin(page) {
  const current = String(typeof page.url === "function" ? page.url() : "");
  if (current.includes("tiktok.com")) return;
  if (typeof page.goto !== "function") return;
  await page.goto("https://www.tiktok.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  }).catch(() => {});
  await page.waitForTimeout(Number(process.env.TT_LITE_BOOTSTRAP_WAIT_MS || 1500));
}

async function installLiteRouteBlocking(page) {
  if (page._ttLiteRoutesInstalled) return;
  if (typeof page.route !== "function") return;
  try {
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (BLOCKED_RESOURCE_TYPES.has(type)) {
        return route.abort().catch(() => {});
      }
      return route.continue().catch(() => {});
    });
    page._ttLiteRoutesInstalled = true;
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string> }} [opts]
 */
export async function tiktokPageFetchJson(page, url, opts = {}) {
  const result = await page.evaluate(
    async ({ fetchUrl, method, headers }) => {
      const res = await fetch(fetchUrl, {
        method: method || "GET",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          ...(headers || {}),
        },
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return {
        ok: res.ok,
        status: res.status,
        url: fetchUrl,
        json,
        textPreview: text.slice(0, 240),
      };
    },
    { fetchUrl: url, method: opts.method || "GET", headers: opts.headers || {} }
  );

  if (!result.ok || !result.json) {
    const err = new Error(
      `TikTok fetch failed status=${result.status} preview=${result.textPreview || ""}`
    );
    err.status = result.status;
    throw err;
  }
  return result.json;
}

function buildSearchApiUrl({ keyword, cursor = 0, searchId = "" }) {
  const params = new URLSearchParams();
  params.set("keyword", keyword);
  params.set("cursor", String(cursor));
  params.set("from_page", "search");
  params.set("web_search_code", TT_WEB_SEARCH_CODE);
  if (searchId) params.set("search_id", searchId);
  params.set("count", String(process.env.TT_LITE_SEARCH_COUNT || 12));
  params.set("offset", String(cursor));
  return `https://www.tiktok.com/api/search/item/full/?${params.toString()}`;
}

function applyTemplateParams(template, { keyword, cursor, searchId }) {
  const params = new URLSearchParams(template.params.toString());
  params.set("keyword", keyword);
  params.set("cursor", String(cursor));
  params.set("offset", String(cursor));
  if (searchId) params.set("search_id", searchId);
  else params.delete("search_id");
  return `${template.urlPrefix}?${params.toString()}`;
}

/**
 * 捕获一次真实搜索请求 URL 作为模板（仅当直调失败时使用）
 * @param {import('playwright').Page} page
 * @param {string} keyword
 */
export async function harvestSearchApiTemplate(page, keyword) {
  const sessionKey = resolveSessionKey(page);
  const existing = searchTemplateStore.get(sessionKey);
  if (existing && Date.now() - existing.updatedAt < 30 * 60_000) {
    return existing;
  }

  const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
  let capturedUrl = null;

  const handler = (response) => {
    const url = response.url();
    if (!url.includes("/api/search/item/full")) return;
    if (response.status() >= 400) return;
    capturedUrl = url;
  };

  page.on("response", handler);
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    const deadline = Date.now() + Number(process.env.TT_LITE_TEMPLATE_WAIT_MS || 12_000);
    while (!capturedUrl && Date.now() < deadline) {
      await page.waitForTimeout(400);
    }
  } finally {
    page.off("response", handler);
  }

  if (!capturedUrl) return null;

  const parsed = new URL(capturedUrl);
  const template = {
    urlPrefix: `${parsed.origin}${parsed.pathname}`,
    params: new URLSearchParams(parsed.search),
    updatedAt: Date.now(),
  };
  searchTemplateStore.set(sessionKey, template);
  if (page) page._ttApiSessionKey = sessionKey;
  return template;
}

/**
 * @param {import('playwright').Page} page
 * @param {{ keyword: string, cursor?: number, searchId?: string }} opts
 */
export async function fetchSearchItemFull(page, opts) {
  const { keyword, cursor = 0, searchId = "" } = opts;
  const sessionKey = resolveSessionKey(page);
  let template = searchTemplateStore.get(sessionKey) || null;

  const tryUrls = [];
  if (template) {
    tryUrls.push(applyTemplateParams(template, { keyword, cursor, searchId }));
  }
  tryUrls.push(buildSearchApiUrl({ keyword, cursor, searchId }));

  let lastError = null;
  for (const url of tryUrls) {
    try {
      const json = await tiktokPageFetchJson(page, url);
      if (json?.status_code === 0 || json?.item_list || json?.itemList) {
        return json;
      }
      lastError = new Error(`search api empty status_code=${json?.status_code}`);
    } catch (e) {
      lastError = e;
    }
  }

  if (process.env.TT_LITE_SKIP_SEARCH_WARMUP !== "1") {
    template = await harvestSearchApiTemplate(page, keyword);
    if (template) {
      const url = applyTemplateParams(template, { keyword, cursor, searchId });
      const json = await tiktokPageFetchJson(page, url);
      if (json?.status_code === 0 || json?.item_list || json?.itemList) {
        return json;
      }
    }
  }

  throw lastError || new Error("TikTok search API fetch failed");
}

/**
 * @param {import('playwright').Page} page
 * @param {string} keyword
 * @param {{ maxPages?: number, searchId?: string }} [opts]
 */
export async function fetchSearchItemFullAll(page, keyword, opts = {}) {
  const maxPages = Math.min(Math.max(Number(opts.maxPages || 6), 1), 20);
  const batches = [];
  let cursor = 0;
  let searchId = opts.searchId || "";
  let hasMore = true;

  for (let pageIdx = 0; pageIdx < maxPages && hasMore; pageIdx += 1) {
    const json = await fetchSearchItemFull(page, {
      keyword,
      cursor,
      searchId,
    });
    batches.push(json);
    const nextCursor = json.cursor ?? json.nextCursor;
    hasMore = json.has_more === 1 || json.has_more === true || json.hasMore === true;
    if (nextCursor == null || nextCursor === cursor) {
      hasMore = false;
    } else {
      cursor = nextCursor;
    }
    if (json.rid && !searchId) searchId = String(json.rid);
    const delay = Number(process.env.TT_LITE_SEARCH_DELAY_MS || 180);
    if (hasMore && delay > 0) {
      await page.waitForTimeout(delay);
    }
  }
  return batches;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 */
export async function fetchUserDetail(page, username) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const params = new URLSearchParams();
  params.set("uniqueId", handle);
  params.set("secUid", "");
  const url = `https://www.tiktok.com/api/user/detail/?${params.toString()}`;
  return tiktokPageFetchJson(page, url);
}

/**
 * @param {import('playwright').Page} page
 * @param {{ secUid: string, cursor?: number, count?: number }} opts
 */
export async function fetchPostItemList(page, opts) {
  const params = new URLSearchParams();
  params.set("secUid", opts.secUid);
  params.set("count", String(opts.count || process.env.TT_LITE_ITEM_LIST_COUNT || 35));
  params.set("cursor", String(opts.cursor || 0));
  params.set("coverFormat", "2");
  params.set("post_item_list_request_type", "0");
  const url = `https://www.tiktok.com/api/post/item_list/?${params.toString()}`;
  return tiktokPageFetchJson(page, url);
}

/**
 * @param {import('playwright').Page} page
 * @param {{ secUid: string, maxPages?: number }} opts
 */
export async function fetchPostItemListAll(page, opts) {
  const maxPages = Math.min(Math.max(Number(opts.maxPages || 3), 1), 10);
  const maxVideos = Math.min(
    Math.max(Number(process.env.TT_LITE_MAX_VIDEOS || 50), 1),
    80
  );
  const batches = [];
  let cursor = 0;
  let hasMore = true;

  for (let i = 0; i < maxPages && hasMore; i += 1) {
    const json = await fetchPostItemList(page, { secUid: opts.secUid, cursor });
    batches.push(json);
    const count = json?.itemList?.length || json?.item_list?.length || 0;
    const total = batches.reduce(
      (sum, b) => sum + (b?.itemList?.length || b?.item_list?.length || 0),
      0
    );
    const nextCursor = json.cursor ?? json.nextCursor;
    hasMore =
      (json.hasMore === 1 || json.hasMore === true || json.has_more === 1) &&
      count > 0 &&
      total < maxVideos;
    if (nextCursor == null || nextCursor === cursor) hasMore = false;
    else cursor = nextCursor;
    const delay = Number(process.env.TT_LITE_ENRICH_DELAY_MS || 200);
    if (hasMore && delay > 0) await page.waitForTimeout(delay);
  }
  return batches;
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ forceNewTab?: boolean, endpointKey?: string }} [options]
 */
export async function acquireTiktokApiSession(context, options = {}) {
  const endpointKey =
    options.endpointKey ||
    process.env.CDP_ENDPOINT_ENRICH ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9222";

  let page = null;
  let pageCreated = false;
  let pageMode = "cdp";

  try {
    const { acquireTiktokCdpPage } = await import("../../../cdp/cdp-target-page.js");
    const cdpSession = await acquireTiktokCdpPage(endpointKey, {
      forceNew: !!options.forceNewTab,
    });
    page = cdpSession.page;
  } catch (e) {
    console.warn(`[tiktok-direct] CDP page attach failed: ${e.message}`);
    pageMode = "playwright";
  }

  if (!page) {
    if (!options.forceNewTab) {
      page = context
        .pages()
        .filter(isUsableTiktokPage)
        .sort((a, b) => {
          const au = String(a.url?.() || "");
          const bu = String(b.url?.() || "");
          if (au.includes("tiktok.com") && !bu.includes("tiktok.com")) return -1;
          if (!au.includes("tiktok.com") && bu.includes("tiktok.com")) return 1;
          return 0;
        })[0];
    }
    if (!page) {
      page = await openCdpTaskPage(context);
      pageCreated = true;
      pageMode = "playwright";
    }
  }

  page._ttApiSessionKey = endpointKey;
  if (pageMode === "playwright") {
    await installLiteRouteBlocking(page);
    await ensureTiktokOrigin(page);
  }

  return {
    page,
    workPage: page,
    endpointKey,
    dispose: async () => {
      if (typeof page.dispose === "function") {
        await page.dispose();
        return;
      }
      if (pageCreated && page && !page.isClosed()) {
        await closeCdpTaskPage(page);
      }
    },
  };
}
