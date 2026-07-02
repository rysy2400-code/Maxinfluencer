/**
 * TikTok API 直调：在 tiktok.com 页面上下文内 fetch，参考 TikTok-Api 思路，尽量不打开搜索/主页。
 */

import { openCdpTaskPage, closeCdpTaskPage } from "../../../cdp/cdp-tab-utils.js";
import { bootstrapTiktokWebSession, tiktokMakeRequest } from "./tiktok-api-client.js";
import { attachLitePageNavTracker } from "./lite-page-nav.js";

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
 * TikTok 会拦截 page.evaluate(fetch)；用导航 API URL 读 body JSON（与浏览器 XHR 同源）
 * @param {object} page
 * @param {string} apiUrl
 */
export async function fetchTiktokApiViaNavigation(page, apiUrl) {
  if (typeof page.goto !== "function") {
    return tiktokPageFetchJson(page, apiUrl);
  }
  await page.goto(apiUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(Number(process.env.TT_LITE_API_BODY_WAIT_MS || 800));
  const text = await page.evaluate(() => {
    const raw = document.body?.innerText || document.documentElement?.innerText || "";
    return raw.trim();
  });
  if (!text || text.startsWith("<!")) {
    throw new Error(`TikTok API navigation returned HTML: ${text.slice(0, 120)}`);
  }
  const jsonText = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "");
  const json = JSON.parse(jsonText);
  return json;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string> }} [opts]
 */
export async function tiktokPageFetchJson(page, url, opts = {}) {
  const referer =
    opts.referer ||
    (typeof page.url === "function" && String(page.url() || "").includes("tiktok.com")
      ? page.url()
      : "https://www.tiktok.com/");
  const result = await page.evaluate(
    async ({ fetchUrl, method, headers, refererUrl }) => {
      const res = await fetch(fetchUrl, {
        method: method || "GET",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          referer: refererUrl,
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
        isHtml: text.trimStart().startsWith("<!"),
        textPreview: text.slice(0, 240),
      };
    },
    {
      fetchUrl: url,
      method: opts.method || "GET",
      headers: opts.headers || {},
      refererUrl: referer,
    }
  );

  if (!result.ok || !result.json || result.isHtml) {
    const err = new Error(
      `TikTok fetch failed status=${result.status} html=${!!result.isHtml} preview=${result.textPreview || ""}`
    );
    err.status = result.status;
    err.isHtml = result.isHtml;
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
  params.set("count", String(process.env.TT_LITE_SEARCH_COUNT || 30));
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

  const handler = (request) => {
    try {
      const url =
        typeof request?.url === "function"
          ? request.url()
          : String(request?.url || "");
      if (!url.includes("/api/search/item/full")) return;
      capturedUrl = url;
    } catch {
      /* ignore */
    }
  };

  page.on("request", handler);
  try {
    if (typeof page.goto === "function") {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    }
    const deadline = Date.now() + Number(process.env.TT_LITE_TEMPLATE_WAIT_MS || 15_000);
    while (!capturedUrl && Date.now() < deadline) {
      await page.waitForTimeout(400);
    }
  } finally {
    try {
      page.off("request", handler);
    } catch {
      /* ignore */
    }
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
  const searchReferer = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}`;

  const params = {
    keyword,
    cursor: String(cursor),
    offset: String(cursor),
    from_page: "search",
    web_search_code: TT_WEB_SEARCH_CODE,
    count: String(process.env.TT_LITE_SEARCH_COUNT || 30),
  };
  if (searchId) params.search_id = searchId;

  try {
    const json = await tiktokMakeRequest(
      page,
      "https://www.tiktok.com/api/search/item/full/",
      params,
      { referer: searchReferer }
    );
    if (json?.status_code === 0 || json?.item_list || json?.itemList) {
      return json;
    }
    throw new Error(`search api empty status_code=${json?.status_code}`);
  } catch (e) {
    if (process.env.TT_LITE_ALLOW_NAV === "1") {
      console.warn(`[tiktok-direct] signed search failed, nav fallback: ${e.message}`);
      const navBatches = await captureSearchItemFullFromNavigation(page, keyword);
      if (navBatches.length) return navBatches[0];
    }
    throw e;
  }
}

/**
 * 搜索页导航并拦截 item/full 响应体（可滚动加载更多）
 * @param {object} page
 * @param {string} keyword
 */
export async function captureSearchItemFullFromNavigation(page, keyword) {
  const batches = [];
  const seenKeys = new Set();
  const handler = async (resp) => {
    try {
      const u = typeof resp?.url === "function" ? resp.url() : "";
      if (!u.includes("/api/search/item/full")) return;
      const text = typeof resp?.text === "function" ? await resp.text() : "";
      if (!text || text.trimStart().startsWith("<")) return;
      const json = JSON.parse(text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, ""));
      const key = `${json.cursor ?? ""}:${(json.item_list || json.itemList || []).length}:${json.log_pb?.impr_id || ""}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      batches.push(json);
    } catch {
      /* ignore */
    }
  };
  page.on("response", handler);
  try {
    const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    const scrollRounds = Math.min(
      Math.max(Number(process.env.TT_LITE_SEARCH_NAV_SCROLL_ROUNDS || 12), 1),
      30
    );
    for (let i = 0; i < scrollRounds; i += 1) {
      await page.waitForTimeout(Number(process.env.TT_LITE_SEARCH_NAV_WAIT_MS || 1500));
      if (typeof page.evaluate === "function") {
        await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 900))).catch(() => {});
      }
    }
    await page.waitForTimeout(Number(process.env.TT_LITE_TEMPLATE_WAIT_MS || 2000));
  } finally {
    try {
      page.off("response", handler);
    } catch {
      /* ignore */
    }
  }
  console.log(`[tiktok-direct] search nav captured ${batches.length} API batches`);
  return batches;
}

/**
 * 主页 Lite enrich：导航 @profile 并拦截 user/detail + post/item_list（无滚动，阻断图片/媒体）
 * @param {object} page
 * @param {string} username
 */
export async function captureProfileApisFromNavigation(page, username) {
  const handle = String(username || "").replace(/^@/, "").trim();
  let userDetail = null;
  const itemListBatches = [];

  const handler = async (resp) => {
    try {
      const u = typeof resp?.url === "function" ? resp.url() : "";
      if (!u.includes("/api/user/detail") && !u.includes("/api/post/item_list")) return;
      const text = typeof resp?.text === "function" ? await resp.text() : "";
      if (!text || text.trimStart().startsWith("<")) return;
      const json = JSON.parse(text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, ""));
      if (u.includes("/api/user/detail") && !userDetail) userDetail = json;
      if (u.includes("/api/post/item_list")) itemListBatches.push(json);
    } catch {
      /* ignore */
    }
  };

  await installLiteRouteBlocking(page);
  page.on("response", handler);
  try {
    const profileUrl = `https://www.tiktok.com/@${handle}?t=${Date.now()}`;
    console.log(`[tiktok-direct] profile capture navigate @${handle}`);
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    const deadline = Date.now() + Number(process.env.TT_LITE_PROFILE_WAIT_MS || 12_000);
    const scrollRounds = Math.min(
      Math.max(Number(process.env.TT_LITE_PROFILE_SCROLL_ROUNDS || 6), 0),
      15
    );
    while (Date.now() < deadline) {
      const hasUser = !!userDetail;
      const itemCount = itemListBatches.reduce(
        (sum, b) => sum + (b?.itemList?.length || b?.item_list?.length || 0),
        0
      );
      if (hasUser && itemCount >= Number(process.env.TT_LITE_MAX_VIDEOS || 50)) break;
      if (hasUser && itemCount > 0 && scrollRounds === 0) break;
      await page.waitForTimeout(400);
    }
    for (let i = 0; i < scrollRounds; i += 1) {
      if (typeof page.evaluate === "function") {
        await page
          .evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 900)))
          .catch(() => {});
      }
      await page.waitForTimeout(Number(process.env.TT_LITE_PROFILE_SCROLL_WAIT_MS || 1200));
    }
  } finally {
    try {
      page.off("response", handler);
    } catch {
      /* ignore */
    }
  }

  console.log(
    `[tiktok-direct] profile capture @${handle}: userDetail=${!!userDetail} itemListBatches=${itemListBatches.length}`
  );
  return { userDetail, itemListBatches };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} keyword
 * @param {{ maxPages?: number, searchId?: string }} [opts]
 */
export async function fetchSearchItemFullAll(page, keyword, opts = {}) {
  const maxPages = Math.min(
    Math.max(Number(opts.maxPages || process.env.TT_LITE_SEARCH_MAX_PAGES || 30), 1),
    80
  );
  const batches = [];
  let cursor = 0;
  let searchId = opts.searchId || "";
  let hasMore = true;

  for (let pageIdx = 0; pageIdx < maxPages && hasMore; pageIdx += 1) {
    let json;
    try {
      json = await fetchSearchItemFull(page, {
        keyword,
        cursor,
        searchId,
      });
    } catch (e) {
      if (pageIdx === 0 && process.env.TT_LITE_ALLOW_NAV === "1") {
        console.warn(`[tiktok-direct] search API failed, try navigation capture: ${e.message}`);
        const navBatches = await captureSearchItemFullFromNavigation(page, keyword);
        if (navBatches.length) return navBatches.slice(0, maxPages);
      }
      console.warn(
        `[tiktok-direct] search page ${pageIdx + 1}/${maxPages} failed: ${e.message}`
      );
      break;
    }
    batches.push(json);
    const nextCursor = json.cursor ?? json.nextCursor;
    hasMore =
      json.has_more === 1 ||
      json.has_more === true ||
      json.hasMore === true ||
      json.hasMore === 1;
    const itemCount = json?.item_list?.length || json?.itemList?.length || 0;
    if (itemCount === 0) hasMore = false;
    if (nextCursor == null || nextCursor === cursor) {
      hasMore = false;
    } else {
      cursor = nextCursor;
    }
    if (json.rid) searchId = String(json.rid);
    if (json.log_pb?.impr_id) searchId = String(json.log_pb.impr_id);
    if (json.extra?.logid && !searchId) searchId = String(json.extra.logid);
    const delay = Number(process.env.TT_LITE_SEARCH_DELAY_MS || 180);
    if (hasMore && delay > 0) {
      await page.waitForTimeout(delay);
    }
  }

  const minPool = Number(process.env.TT_LITE_SEARCH_MIN_POOL || 0);
  const totalItems = batches.reduce(
    (sum, b) => sum + (b?.item_list?.length || b?.itemList?.length || 0),
    0
  );
  if (
    batches.length < maxPages &&
    totalItems < minPool &&
    process.env.TT_LITE_ALLOW_NAV === "1"
  ) {
    console.warn(
      `[tiktok-direct] signed search pool small (${totalItems} videos / ${batches.length} batches), navigation fallback`
    );
    try {
      const navBatches = await captureSearchItemFullFromNavigation(page, keyword);
      for (const nb of navBatches) {
        if (!batches.includes(nb)) batches.push(nb);
      }
    } catch (e) {
      console.warn(`[tiktok-direct] search nav fallback failed: ${e.message}`);
    }
  }

  return batches;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 */
export async function fetchUserDetail(page, username, opts = {}) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const referer = `https://www.tiktok.com/@${handle}`;
  const params = {
    uniqueId: handle,
    secUid: opts.secUid || "",
  };
  return tiktokMakeRequest(
    page,
    "https://www.tiktok.com/api/user/detail/",
    params,
    { referer }
  );
}

function pickLocationFromItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.locationCreated != null && item.locationCreated !== "") {
    const loc = String(item.locationCreated);
    if (/^[A-Za-z]{2}$/.test(loc)) return loc.toUpperCase();
    return loc;
  }
  const poi = item.poi || item.poiInfo || item.location;
  if (poi?.regionCode != null && poi.regionCode !== "") {
    const code = String(poi.regionCode);
    if (/^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
  }
  if (poi?.countryCode != null && poi.countryCode !== "") {
    const code = String(poi.countryCode);
    if (/^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
  }
  return null;
}

const UNIVERSAL_SCRIPT_MARKER =
  '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">';
const SIGI_SCRIPT_MARKER = '<script id="SIGI_STATE" type="application/json">';

function parseLocationCreatedFromUniversalHtml(html) {
  const start = html.indexOf(UNIVERSAL_SCRIPT_MARKER);
  if (start < 0) return null;
  const jsonStart = start + UNIVERSAL_SCRIPT_MARKER.length;
  const jsonEnd = html.indexOf("</script>", jsonStart);
  if (jsonEnd < 0) return null;
  const data = JSON.parse(html.slice(jsonStart, jsonEnd));
  const item =
    data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
    data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo?.itemStruct;
  if (item?.locationCreated != null && item.locationCreated !== "") {
    return String(item.locationCreated);
  }
  return null;
}

/** TikTok-Api Video.info() 也解析 SIGI_STATE ItemModule */
function parseLocationCreatedFromSigiHtml(html, videoId) {
  const start = html.indexOf(SIGI_SCRIPT_MARKER);
  if (start < 0) return null;
  const jsonStart = start + SIGI_SCRIPT_MARKER.length;
  const jsonEnd = html.indexOf("</script>", jsonStart);
  if (jsonEnd < 0) return null;
  try {
    const data = JSON.parse(html.slice(jsonStart, jsonEnd));
    const mod = data?.ItemModule;
    if (!mod || typeof mod !== "object") return null;
    const vid = videoId ? String(videoId) : "";
    if (vid && mod[vid]) {
      const loc = pickLocationFromItem(mod[vid]);
      if (loc) return loc;
    }
    for (const item of Object.values(mod)) {
      const loc = pickLocationFromItem(item);
      if (loc) return loc;
    }
  } catch {
    return null;
  }
  return null;
}

function parseLocationCreatedFromVideoHtml(html, videoId) {
  if (!html || typeof html !== "string") return null;
  return (
    parseLocationCreatedFromUniversalHtml(html) ||
    parseLocationCreatedFromSigiHtml(html, videoId)
  );
}

/**
 * TikTok-Api 风格 signed item_detail API
 */
export async function fetchLocationCreatedFromItemDetailApi(page, videoId, username) {
  const id = String(videoId || "").trim();
  const handle = String(username || "").replace(/^@/, "").trim();
  if (!id || !handle) return null;
  const referer = `https://www.tiktok.com/@${handle}/video/${id}`;
  const endpoints = [
    ["https://www.tiktok.com/api/post/item_detail/", { itemId: id }],
    ["https://www.tiktok.com/api/item/detail/", { itemId: id }],
  ];
  for (const [url, params] of endpoints) {
    try {
      const json = await tiktokMakeRequest(page, url, params, { referer });
      const loc = parseVideoLocationFromDetailJson(json);
      if (loc) return loc;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

async function fetchProfileItemsForCountry(page, username, secUid) {
  const listPages = Math.min(
    Number(process.env.TT_LITE_COUNTRY_ITEM_LIST_PAGES || 3),
    5
  );
  const perPage = Math.min(
    Number(process.env.TT_LITE_COUNTRY_ITEM_LIST_COUNT || 20),
    30
  );
  const items = [];
  let cursor = 0;
  for (let p = 0; p < listPages; p += 1) {
    const listJson = await fetchPostItemList(page, {
      secUid,
      count: perPage,
      cursor,
      referer: `https://www.tiktok.com/@${username}`,
    });
    const batch = listJson?.itemList || listJson?.item_list || [];
    items.push(...batch);
    const next = listJson?.cursor ?? listJson?.nextCursor;
    const hasMore =
      (listJson?.hasMore === 1 ||
        listJson?.hasMore === true ||
        listJson?.has_more === 1) &&
      batch.length > 0;
    if (!hasMore || next == null || next === cursor) break;
    cursor = next;
    const delay = Number(process.env.TT_LITE_COUNTRY_ITEM_LIST_DELAY_MS || 120);
    if (delay > 0 && p < listPages - 1) {
      await page.waitForTimeout(delay);
    }
  }
  return items;
}

async function resolveSecUid(page, username, secUid) {
  let uid = String(secUid || "").trim();
  if (uid || !username) return uid;
  try {
    const detail = await fetchUserDetail(page, username, {});
    uid =
      detail?.userInfo?.user?.secUid ||
      detail?.userInfo?.user?.sec_uid ||
      detail?.user?.secUid ||
      "";
  } catch {
    /* ignore */
  }
  return String(uid || "").trim();
}

/**
 * TikTok-Api Video.info() 思路：Node fetch + CDP 全量 cookie（含 HttpOnly）
 */
export async function fetchLocationCreatedFromVideoHtmlViaNode(page, username, videoId) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const id = String(videoId || "").trim();
  if (!handle || !id) return null;
  const videoUrl = `https://www.tiktok.com/@${handle}/video/${id}`;
  try {
    await bootstrapTiktokWebSession(page);
    const ua =
      typeof page.evaluate === "function"
        ? await page.evaluate(() => navigator.userAgent)
        : "Mozilla/5.0";
    const docHeaders =
      typeof page.evaluate === "function"
        ? await page.evaluate(() => {
            const lang = navigator.language || "en-US";
            let secChUa = "";
            try {
              secChUa =
                navigator.userAgentData?.brands
                  ?.map((b) => `"${b.brand}";v="${b.version}"`)
                  .join(", ") || "";
            } catch {
              secChUa = "";
            }
            return {
              accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
              "accept-language": lang,
              "cache-control": "max-age=0",
              referer: "https://www.tiktok.com/",
              "sec-ch-ua": secChUa,
              "sec-ch-ua-mobile": "?0",
              "sec-ch-ua-platform": `"${navigator.platform}"`,
              "sec-fetch-dest": "document",
              "sec-fetch-mode": "navigate",
              "sec-fetch-site": "none",
              "sec-fetch-user": "?1",
              "upgrade-insecure-requests": "1",
            };
          })
        : {};
    let cookies = {};
    if (typeof page.getTiktokCookies === "function") {
      cookies = await page.getTiktokCookies();
    } else if (typeof page.context === "function") {
      const ctx = page.context();
      if (ctx?.cookies) {
        for (const c of await ctx.cookies(["https://www.tiktok.com"])) {
          cookies[c.name] = c.value;
        }
      }
    }
    const verifyFp = page._ttVerifyFp || cookies.s_v_web_id || cookies.verifyFp;
    if (verifyFp && !cookies.s_v_web_id) cookies.s_v_web_id = verifyFp;
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const res = await fetch(videoUrl, {
      headers: {
        ...docHeaders,
        "user-agent": ua,
        cookie: cookieHeader,
      },
      redirect: "follow",
    });
    const html = await res.text();
    if (page && isVideoHtmlLoginStub(html)) {
      page._ttCountryHtmlLoginStub = true;
    }
    return parseLocationCreatedFromVideoHtml(html, id);
  } catch {
    return null;
  }
}

/** fetch 返回的短 HTML 且无 UNIVERSAL/SIGI，多为未登录/限流 stub */
export function isVideoHtmlLoginStub(html) {
  if (!html || typeof html !== "string") return false;
  return (
    html.length < 8000 &&
    !html.includes("__UNIVERSAL_DATA_FOR_REHYDRATION__") &&
    !html.includes("SIGI_STATE")
  );
}

/**
 * 不打开视频页：在 tiktok.com 上下文中 fetch 视频 HTML，解析 UNIVERSAL 中的 locationCreated
 */
export async function fetchLocationCreatedFromVideoHtmlRequest(page, username, videoId) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const id = String(videoId || "").trim();
  if (!handle || !id) return null;
  const videoUrl = `https://www.tiktok.com/@${handle}/video/${id}`;
  await bootstrapTiktokWebSession(page).catch(() => {});
  if (page) page._ttCountryHtmlLoginStub = false;
  const maxAttempts = Math.min(
    Number(process.env.TT_LITE_COUNTRY_HTML_FETCH_TRIES || 4),
    6
  );
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const evalPromise = page.evaluate(async (url) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25_000);
        try {
          const res = await fetch(url, {
            credentials: "include",
            signal: ctrl.signal,
            headers: {
              accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              referer: "https://www.tiktok.com/",
            },
          });
          return res.text();
        } finally {
          clearTimeout(timer);
        }
      }, videoUrl);
      const html = await Promise.race([
        evalPromise,
        typeof page.waitForTimeout === "function"
          ? page.waitForTimeout(28_000).then(() => null)
          : new Promise((r) => setTimeout(() => r(null), 28_000)),
      ]);
      if (!html) continue;
      const loc = parseLocationCreatedFromVideoHtml(html, id);
      if (loc) return loc;
      if (isVideoHtmlLoginStub(html)) {
        if (page) page._ttCountryHtmlLoginStub = true;
        continue;
      }
    } catch {
      /* retry */
    }
    const waitMs = Number(process.env.TT_LITE_COUNTRY_HTML_RETRY_MS || 500) * (attempt + 1);
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(waitMs);
    } else {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return null;
}

/** TikTok-Api Video.info() 在现版 Web 常需 document 加载后 DOM 才有 UNIVERSAL/SIGI */
export function isVideoInfoDocumentAllowed() {
  if (process.env.TT_LITE_COUNTRY_VIDEO_INFO === "1") return true;
  if (
    process.env.TT_LITE_COUNTRY_VIDEO_INFO === "0" ||
    process.env.TT_LITE_COUNTRY_DISABLE_NAV === "1"
  ) {
    return false;
  }
  return true;
}

/** 国家预筛默认走浏览器 html fetch（item_detail/item_list JSON 在 crawler 实测 0 命中） */
export function isCountryHtmlFirst() {
  if (process.env.TT_LITE_COUNTRY_HTML_FIRST === "0") return false;
  return process.env.TT_LITE_COUNTRY_TRY_ITEM_DETAIL !== "1";
}

export function isCountryJsonPathsEnabled() {
  return process.env.TT_LITE_COUNTRY_TRY_JSON_PATHS === "1";
}

/** html fetch 登录 stub 时允许 page.goto 视频页读 DOM（默认关，仅 TT_LITE_COUNTRY_STUB_DOCUMENT=1 开启） */
export function isCountryStubDocumentFallbackAllowed() {
  return process.env.TT_LITE_COUNTRY_STUB_DOCUMENT === "1";
}

async function readLocationFromVideoPageDom(page, videoId) {
  if (typeof page.evaluate !== "function") return null;
  return page.evaluate((vid) => {
    const pick = (item) => {
      if (!item) return null;
      if (item.locationCreated != null && item.locationCreated !== "") {
        return String(item.locationCreated);
      }
      return null;
    };
    const uni = document.querySelector(
      'script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]'
    );
    if (uni?.textContent) {
      try {
        const data = JSON.parse(uni.textContent);
        const item =
          data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
          data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo?.itemStruct;
        const loc = pick(item);
        if (loc) return loc;
      } catch {
        /* ignore */
      }
    }
    const sigi = document.querySelector('script[id="SIGI_STATE"]');
    if (sigi?.textContent) {
      try {
        const data = JSON.parse(sigi.textContent);
        const mod = data?.ItemModule;
        if (mod && typeof mod === "object") {
          if (vid && mod[String(vid)]) {
            const loc = pick(mod[String(vid)]);
            if (loc) return loc;
          }
          for (const item of Object.values(mod)) {
            const loc = pick(item);
            if (loc) return loc;
          }
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }, videoId);
}

/**
 * TikTok-Api Video.info()：打开视频 document，轮询 DOM 内 UNIVERSAL/SIGI，再回首页
 */
export async function fetchLocationCreatedFromVideoInfoDocument(
  page,
  username,
  videoId,
  opts = {}
) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const id = String(videoId || "").trim();
  if (!handle || !id || typeof page.goto !== "function") return null;
  const stubFallback = opts.stubFallback === true;
  if (
    !isVideoInfoDocumentAllowed() &&
    !(stubFallback && isCountryStubDocumentFallbackAllowed())
  ) {
    return null;
  }
  const videoUrl = `https://www.tiktok.com/@${handle}/video/${id}`;
  const homeUrl = "https://www.tiktok.com/";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(videoUrl, {
        waitUntil: attempt === 0 ? "domcontentloaded" : "networkidle",
        timeout: Number(process.env.TT_LITE_UNIVERSAL_GOTO_TIMEOUT_MS || 45_000),
      });
      const pollMs = Number(process.env.TT_LITE_UNIVERSAL_WAIT_MS || 500);
      const maxWait = Number(process.env.TT_LITE_UNIVERSAL_MAX_WAIT_MS || 12_000);
      const deadline = Date.now() + maxWait;
      let loc = null;
      while (Date.now() < deadline && !loc) {
        loc = await readLocationFromVideoPageDom(page, id);
        if (!loc && typeof page.waitForTimeout === "function") {
          await page.waitForTimeout(pollMs);
        } else if (!loc) {
          await new Promise((r) => setTimeout(r, pollMs));
        }
      }
      if (loc) {
        if (process.env.TT_LITE_COUNTRY_VIDEO_INFO_CHAIN !== "1") {
          await page
            .goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 })
            .catch(() => {});
          await page.waitForTimeout(Number(process.env.TT_LITE_BOOTSTRAP_WAIT_MS || 800));
          await bootstrapTiktokWebSession(page).catch(() => {});
        }
        return loc;
      }
    } catch {
      /* retry */
    }
    if (attempt === 0 && typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(1200);
    }
  }
  try {
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  } catch {
    /* ignore */
  }
  return null;
}

/** @deprecated 使用 fetchLocationCreatedFromVideoInfoDocument */
export async function fetchLocationCreatedFromVideoUniversalNavigate(page, username, videoId) {
  return fetchLocationCreatedFromVideoInfoDocument(page, username, videoId);
}

export function parseVideoLocationFromDetailJson(json) {
  if (!json || typeof json !== "object") return null;
  const candidates = [
    json?.itemInfo?.itemStruct,
    json?.itemStruct,
    json?.itemInfo,
    json?.aweme_detail?.aweme,
    ...(Array.isArray(json?.itemList) ? json.itemList : []),
    ...(Array.isArray(json?.item_list) ? json.item_list : []),
  ];
  for (const item of candidates) {
    const loc = pickLocationFromItem(item);
    if (loc) return loc;
  }
  return null;
}

/**
 * Lite 国家：search → item_detail API → HTML（UNIVERSAL/SIGI）→ stub 时 document 回退
 * @param {object} page
 * @param {{ videoId?: string, username?: string, secUid?: string, searchLocation?: string|null }} opts
 */
export async function resolveVideoLocationCreated(page, opts = {}) {
  const username = String(opts.username || "").replace(/^@/, "").trim();
  const videoId = opts.videoId ? String(opts.videoId) : "";

  if (opts.searchLocation != null && opts.searchLocation !== "") {
    return { locationCreated: String(opts.searchLocation), source: "search_api" };
  }

  if (!videoId || !username) {
    return { locationCreated: null, source: null, error: "missing_video_or_user" };
  }

  if (page) page._ttCountryHtmlLoginStub = false;

  const tryItemDetail = process.env.TT_LITE_COUNTRY_TRY_ITEM_DETAIL === "1";
  const htmlFirst = isCountryHtmlFirst();

  async function tryHtmlBrowser() {
    return fetchLocationCreatedFromVideoHtmlRequest(page, username, videoId);
  }
  async function tryHtmlNode() {
    return fetchLocationCreatedFromVideoHtmlViaNode(page, username, videoId);
  }
  async function tryItemDetailApi() {
    return fetchLocationCreatedFromItemDetailApi(page, videoId, username);
  }

  if (htmlFirst) {
    const htmlBrowser = await tryHtmlBrowser();
    if (htmlBrowser) {
      return { locationCreated: htmlBrowser, source: "video_html_fetch" };
    }
    const htmlNode = await tryHtmlNode();
    if (htmlNode) {
      return { locationCreated: htmlNode, source: "video_html_node_fetch" };
    }
    if (tryItemDetail) {
      const itemDetailApi = await tryItemDetailApi();
      if (itemDetailApi) {
        return { locationCreated: itemDetailApi, source: "item_detail_api" };
      }
    }
  } else {
    const itemDetailApi = await tryItemDetailApi();
    if (itemDetailApi) {
      return { locationCreated: itemDetailApi, source: "item_detail_api" };
    }
    const htmlBrowser = await tryHtmlBrowser();
    if (htmlBrowser) {
      return { locationCreated: htmlBrowser, source: "video_html_fetch" };
    }
    const htmlNode = await tryHtmlNode();
    if (htmlNode) {
      return { locationCreated: htmlNode, source: "video_html_node_fetch" };
    }
  }

  const sawStub = page?._ttCountryHtmlLoginStub === true;
  const stubDocAllowed = sawStub && isCountryStubDocumentFallbackAllowed();
  const videoInfoAllowed = isVideoInfoDocumentAllowed();

  if (stubDocAllowed || videoInfoAllowed) {
    const videoInfoDoc = await fetchLocationCreatedFromVideoInfoDocument(
      page,
      username,
      videoId,
      { stubFallback: stubDocAllowed }
    );
    if (videoInfoDoc) {
      const source =
        process.env.TT_LITE_COUNTRY_VIDEO_INFO === "1"
          ? "video_info_document"
          : stubDocAllowed
            ? "video_html_stub_document"
            : "video_universal_navigate";
      return { locationCreated: videoInfoDoc, source };
    }
  }

  return { locationCreated: null, source: null, error: "no_location_in_universal" };
}

/**
 * 国家预筛：代表视频失败后，用 post/item_list 与其它视频继续探测 locationCreated
 * @param {object} page
 * @param {{ videoId?: string, username?: string, secUid?: string, searchLocation?: string|null }} opts
 */
export async function resolveVideoLocationCreatedForInfluencer(page, opts = {}) {
  const username = String(opts.username || "").replace(/^@/, "").trim();
  let videoId = opts.videoId ? String(opts.videoId) : "";

  if (opts.searchLocation != null && opts.searchLocation !== "") {
    return {
      locationCreated: String(opts.searchLocation),
      source: "search_api",
      representativeVideoId: videoId || null,
    };
  }

  const secUid = await resolveSecUid(page, username, opts.secUid || "");
  const videoInfoFirst = isVideoInfoDocumentAllowed();
  const htmlFirst = isCountryHtmlFirst();
  const jsonPaths = isCountryJsonPathsEnabled();

  if (htmlFirst && !jsonPaths) {
    const altIds = Array.isArray(opts.altVideoIds)
      ? opts.altVideoIds.map(String).filter(Boolean)
      : [];
    const maxSearchAlt = Math.min(
      Number(process.env.TT_LITE_COUNTRY_SEARCH_ALT_VIDEOS || 12),
      20
    );
    const tryIds = [
      ...(videoId ? [videoId] : []),
      ...altIds.filter((id) => id && id !== videoId),
    ].slice(0, 1 + maxSearchAlt);

    for (let i = 0; i < tryIds.length; i += 1) {
      const vid = tryIds[i];
      const result = await resolveVideoLocationCreated(page, {
        videoId: vid,
        username,
        searchLocation: null,
      });
      if (result.locationCreated) {
        return { ...result, representativeVideoId: vid };
      }
      const delay = Number(process.env.TT_LITE_COUNTRY_PROBE_DELAY_MS || 150);
      if (delay > 0 && i < tryIds.length - 1) {
        await page.waitForTimeout(delay);
      }
    }

    return {
      locationCreated: null,
      source: null,
      error: "no_location_in_universal",
      representativeVideoId: videoId || null,
    };
  }

  if (videoInfoFirst && videoId) {
    const quick = await resolveVideoLocationCreated(page, {
      videoId,
      username,
      searchLocation: null,
    });
    if (quick.locationCreated) {
      return { ...quick, representativeVideoId: videoId };
    }
    const altIds = Array.isArray(opts.altVideoIds)
      ? opts.altVideoIds.map(String).filter(Boolean)
      : [];
    const maxSearchAlt = Math.min(
      Number(process.env.TT_LITE_COUNTRY_SEARCH_ALT_VIDEOS || 12),
      20
    );
    let altTried = 0;
    for (const vid of altIds) {
      if (vid === videoId || altTried >= maxSearchAlt) continue;
      altTried += 1;
      const alt = await resolveVideoLocationCreated(page, { videoId: vid, username });
      if (alt.locationCreated) {
        return { ...alt, representativeVideoId: vid };
      }
      const delay = Number(process.env.TT_LITE_COUNTRY_PROBE_DELAY_MS || 200);
      if (delay > 0) await page.waitForTimeout(delay);
    }
  }

  // TikTok-Api：post/item_list 的 item 常直接带 locationCreated（无需打开视频页）
  let profileItems = [];
  if (secUid && !videoInfoFirst) {
    try {
      profileItems = await fetchProfileItemsForCountry(page, username, secUid);
      for (const item of profileItems) {
        const loc = pickLocationFromItem(item);
        if (loc) {
          return {
            locationCreated: loc,
            source: "item_list_api",
            representativeVideoId: String(item.id || item.aweme_id || videoId || ""),
          };
        }
      }
    } catch {
      /* fall through */
    }
  }

  if (videoId && !videoInfoFirst) {
    const result = await resolveVideoLocationCreated(page, {
      videoId,
      username,
      searchLocation: null,
    });
    if (result.locationCreated) {
      return { ...result, representativeVideoId: videoId };
    }
  }

  if (!profileItems.length && secUid && !videoInfoFirst) {
    try {
      profileItems = await fetchProfileItemsForCountry(page, username, secUid);
    } catch {
      profileItems = [];
    }
  }

  if (!profileItems.length && secUid && videoInfoFirst) {
    try {
      profileItems = await fetchProfileItemsForCountry(page, username, secUid);
    } catch {
      profileItems = [];
    }
  }

  try {
    const detailCap = Math.min(
      Number(process.env.TT_LITE_COUNTRY_ITEM_DETAIL_TRIES || 15),
      25
    );
    let detailTried = 0;
    for (const item of profileItems) {
      const vid = String(item.id || item.aweme_id || "").trim();
      if (!vid) continue;
      if (detailTried >= detailCap) break;
      detailTried += 1;
      const apiLoc = await fetchLocationCreatedFromItemDetailApi(page, vid, username);
      if (apiLoc) {
        return {
          locationCreated: apiLoc,
          source: "item_detail_api_list",
          representativeVideoId: vid,
        };
      }
    }

    const maxAlt = Math.min(Number(process.env.TT_LITE_COUNTRY_ALT_VIDEOS || 12), 20);
    let tried = 0;
    for (const item of profileItems) {
      const vid = String(item.id || item.aweme_id || "").trim();
      if (!vid || vid === videoId) continue;
      if (tried >= maxAlt) break;
      tried += 1;
      const alt = await resolveVideoLocationCreated(page, { videoId: vid, username });
      if (alt.locationCreated) {
        return {
          ...alt,
          source: `${alt.source || "lite_api"}_alt_video`,
          representativeVideoId: vid,
        };
      }
      const delay = Number(process.env.TT_LITE_COUNTRY_PROBE_DELAY_MS || 150);
      if (delay > 0) await page.waitForTimeout(delay);
    }
  } catch (e) {
    return {
      locationCreated: null,
      source: null,
      error: e.message,
      representativeVideoId: videoId || null,
    };
  }

  return {
    locationCreated: null,
    source: null,
    error: "no_location_in_universal",
    representativeVideoId: videoId || null,
  };
}

/**
 * 视频详情 API（用于 Lite 国家检测，9223 并发）
 * @param {object} page
 * @param {string} itemId
 */
export async function fetchVideoItemDetail(page, itemId, opts = {}) {
  const id = String(itemId || "").trim();
  if (!id) throw new Error("missing_item_id");
  const resolved = await resolveVideoLocationCreated(page, {
    videoId: id,
    username: opts.username,
    secUid: opts.secUid,
  });
  if (resolved.locationCreated) {
    return {
      itemInfo: { itemStruct: { id, locationCreated: resolved.locationCreated } },
      _liteLocationSource: resolved.source,
    };
  }
  throw new Error("video item detail returned no locationCreated");
}

/**
 * @param {import('playwright').Page} page
 * @param {{ secUid: string, cursor?: number, count?: number }} opts
 */
export async function fetchPostItemList(page, opts) {
  const referer = opts.referer || "https://www.tiktok.com/";
  const params = {
    secUid: opts.secUid,
    count: String(opts.count || process.env.TT_LITE_ITEM_LIST_COUNT || 30),
    cursor: String(opts.cursor || 0),
    coverFormat: "2",
    post_item_list_request_type: "0",
  };
  return tiktokMakeRequest(
    page,
    "https://www.tiktok.com/api/post/item_list/",
    params,
    { referer, requireItems: true, retries: 3 }
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {{ secUid: string, maxPages?: number }} opts
 */
export async function fetchPostItemListAll(page, opts) {
  const maxVideos = Math.min(
    Math.max(Number(process.env.TT_LITE_MAX_VIDEOS || 50), 1),
    80
  );
  const perPage = Math.min(
    Math.max(Number(process.env.TT_LITE_ITEM_LIST_COUNT || 30), 1),
    35
  );
  const maxPages = Math.min(
    Math.max(
      Number(opts.maxPages || Math.ceil(maxVideos / perPage)),
      1
    ),
    10
  );
  const batches = [];
  let cursor = 0;
  let hasMore = true;

  for (let i = 0; i < maxPages && hasMore; i += 1) {
    let json;
    try {
      json = await fetchPostItemList(page, {
        secUid: opts.secUid,
        cursor,
        count: perPage,
        referer: opts.referer,
      });
    } catch (e) {
      console.warn(
        `[tiktok-direct] post/item_list page ${i + 1}/${maxPages} failed: ${e.message}`
      );
      break;
    }
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

export function resolveTiktokLiteEnrichEndpoints() {
  return [
    process.env.TT_LITE_ENRICH_CDP,
    process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223",
    "http://127.0.0.1:9223",
    process.env.CDP_ENDPOINT,
  ].filter(Boolean);
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
    if (cdpSession.target?.id) {
      page._ttApiSessionKey = `${endpointKey}#${cdpSession.target.id}`;
    }
  } catch (e) {
    console.warn(`[tiktok-direct] CDP page attach failed: ${e.message}`);
    pageMode = "playwright";
  }

  if (!page) {
    if (!context) {
      throw new Error(
        "TikTok CDP 会话不可用：9222 无法附着 tiktok.com 标签（请确认 guard-chrome-9222 与代理正常）"
      );
    }
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

  if (!page._ttApiSessionKey) {
    page._ttApiSessionKey = endpointKey;
  }
  attachLitePageNavTracker(page);
  if (pageMode === "playwright") {
    await installLiteRouteBlocking(page);
  }
  await bootstrapTiktokWebSession(page);

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
