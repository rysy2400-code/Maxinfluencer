/**
 * TikTok API 直调：在 tiktok.com 页面上下文内 fetch，参考 TikTok-Api 思路，尽量不打开搜索/主页。
 */

import { openCdpTaskPage, closeCdpTaskPage } from "../../../cdp/cdp-tab-utils.js";
import {
  bootstrapTiktokWebSession,
  tiktokMakeRequest,
  invalidateTiktokWebSession,
  isAccessDeniedContent,
  isPageAccessDenied,
  recoverTiktokPageFromAccessDenied,
  refreshTiktokApiSession,
} from "./tiktok-api-client.js";
import { attachLitePageNavTracker } from "./lite-page-nav.js";
import fs from "node:fs";
import path from "node:path";

const BLOCKED_RESOURCE_TYPES = new Set(
  String(process.env.LITE_BLOCK_RESOURCE_TYPES || "image,media,font")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const TT_WEB_SEARCH_CODE =
  process.env.TT_WEB_SEARCH_CODE ||
  '{"tiktok":{"client_params_x":{"search_engine":{"ies_mt_user_live_video_card_use_libra":1,"mt_search_general_user_live_card":1}},"search_server":{}}}';

function isTiktokProxyHtmlRetryEnabled() {
  const raw = String(process.env.TT_LITE_PROXY_RETRY_ON_HTML_STUB ?? "1")
    .trim()
    .toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no");
}

function resolveTiktokProxyControlUrl() {
  return String(process.env.TT_LITE_PROXY_CONTROL_URL || "http://127.0.0.1:9090")
    .replace(/\/+$/, "");
}

function resolveTiktokProxyGroupName() {
  return String(process.env.TT_LITE_PROXY_GROUP || "TikTokProxy");
}

function sortProxyCandidates(nodes) {
  const priority = String(
    process.env.TT_LITE_PROXY_NODE_PRIORITY || "US-8041,SG-8021,JP-8031"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rank = new Map(priority.map((name, idx) => [name, idx]));
  return [...nodes].sort((a, b) => {
    const ar = rank.has(a) ? rank.get(a) : 1000;
    const br = rank.has(b) ? rank.get(b) : 1000;
    if (ar !== br) return ar - br;
    return a.localeCompare(b);
  });
}

function filterAllowedProxyCandidates(nodes) {
  const raw = String(process.env.TT_LITE_PROXY_NODE_ALLOWLIST || "US-8041")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!raw.length) return nodes;
  const allowed = new Set(raw);
  return nodes.filter((name) => allowed.has(name));
}

function resolveTiktokProxyHealthPath() {
  return String(
    process.env.TT_LITE_PROXY_HEALTH_FILE ||
      path.resolve(process.cwd(), "config", "tiktok-proxy-health.json")
  );
}

function readContentHealthyProxyNodes() {
  const raw = String(process.env.TT_LITE_PROXY_USE_CONTENT_HEALTH ?? "1")
    .trim()
    .toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return null;
  const healthPath = resolveTiktokProxyHealthPath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  } catch (e) {
    console.warn(`[tiktok-direct] content health file unavailable: ${healthPath} (${e.message})`);
    return [];
  }
  const ttlMs = Math.max(
    1,
    Number(process.env.TT_LITE_PROXY_HEALTH_TTL_MS || 6 * 60 * 60 * 1000)
  );
  const checkedAt = Date.parse(parsed?.checkedAt || "");
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > ttlMs) {
    console.warn(
      `[tiktok-direct] content health file expired: ${healthPath} checkedAt=${parsed?.checkedAt || "-"}`
    );
    return [];
  }
  const nodes = Array.isArray(parsed?.healthyNodes)
    ? parsed.healthyNodes
    : Array.isArray(parsed?.nodes)
      ? parsed.nodes.filter((n) => n?.healthy).map((n) => n.name)
      : [];
  return sortProxyCandidates(filterAllowedProxyCandidates(nodes.map(String).filter(Boolean)));
}

async function readTiktokProxyState() {
  const controlUrl = resolveTiktokProxyControlUrl();
  const groupName = resolveTiktokProxyGroupName();
  const res = await fetch(`${controlUrl}/proxies`);
  if (!res.ok) throw new Error(`mihomo proxies status=${res.status}`);
  const json = await res.json();
  const proxies = json?.proxies || {};
  const group = proxies[groupName];
  if (!group) throw new Error(`mihomo group not found: ${groupName}`);
  const all = Array.isArray(group.all) ? group.all : [];
  const contentHealthy = readContentHealthyProxyNodes();
  const alive = contentHealthy
    ? contentHealthy.filter((name) => all.includes(name) && proxies[name]?.alive === true)
    : sortProxyCandidates(
        filterAllowedProxyCandidates(all.filter((name) => proxies[name]?.alive === true))
      );
  return {
    controlUrl,
    groupName,
    current: group.now || group.fixed || null,
    alive,
    usedContentHealth: !!contentHealthy,
  };
}

async function switchTiktokProxyAfterHtmlStub(triedNodes, reason) {
  if (!isTiktokProxyHtmlRetryEnabled()) return null;
  let state;
  try {
    state = await readTiktokProxyState();
  } catch (e) {
    console.warn(`[tiktok-direct] proxy state unavailable: ${e.message}`);
    return null;
  }
  if (state.current) triedNodes.add(state.current);
  const next = state.alive.find((name) => !triedNodes.has(name));
  if (!next) {
    console.warn(
      `[tiktok-direct] no content-healthy TikTokProxy node left after ${reason}; current=${state.current || "-"} alive=${state.alive.join(",") || "-"} contentHealth=${state.usedContentHealth ? "yes" : "no"}`
    );
    return null;
  }
  const res = await fetch(
    `${state.controlUrl}/proxies/${encodeURIComponent(state.groupName)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: next }),
    }
  );
  if (!res.ok) {
    console.warn(`[tiktok-direct] switch TikTokProxy to ${next} failed status=${res.status}`);
    return null;
  }
  console.warn(
    `[tiktok-direct] switched TikTokProxy ${state.current || "-"} -> ${next} after ${reason}; alive=${state.alive.join(",")}`
  );
  await new Promise((r) =>
    setTimeout(r, Math.max(0, Number(process.env.TT_LITE_PROXY_SWITCH_WAIT_MS || 1800)))
  );
  return next;
}

async function requestTiktok9223Restart(reason) {
  const raw = String(process.env.TT_LITE_PROXY_RESTART_ON_SWITCH ?? "1")
    .trim()
    .toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  const signalPath = String(
    process.env.CDP_9223_RESTART_SIGNAL_FILE ||
      "C:\\maxinfluencer\\signals\\restart-chrome-9223.flag"
  );
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(signalPath), { recursive: true });
    await fs.writeFile(signalPath, `${new Date().toISOString()} ${reason}\n`, "utf8");
    console.warn(`[tiktok-direct] requested 9223 restart via ${signalPath} (${reason})`);
    return true;
  } catch (e) {
    console.warn(`[tiktok-direct] failed to request 9223 restart: ${e.message}`);
    return false;
  }
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

/** 兼容旧调用名：只使用 fetch-only，不再 page.goto(apiUrl)。 */
export async function fetchTiktokApiViaNavigation(page, apiUrl) {
  return tiktokPageFetchJson(page, apiUrl);
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
        referrer: refererUrl,
        referrerPolicy: "unsafe-url",
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
    throw e;
  }
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
    unique_id: handle,
    uniqueId: handle,
    secUid: opts.secUid || "",
    sec_uid: opts.secUid || "",
    user_id: opts.userId || "",
    userId: opts.userId || "",
  };
  return tiktokMakeRequest(
    page,
    "https://www.tiktok.com/api/user/detail/",
    params,
    { referer, retries: Number(process.env.TT_LITE_USER_DETAIL_RETRIES || 1) }
  );
}

function pickLocationFromItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.locationCreated != null && item.locationCreated !== "") {
    const loc = String(item.locationCreated);
    if (/^[A-Za-z]{2}$/.test(loc)) return loc.toUpperCase();
    return null;
  }
  const poi = item.poi || item.poiInfo || item.location || item.poi_info;
  if (poi?.regionCode != null && poi.regionCode !== "") {
    const code = String(poi.regionCode);
    if (/^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
  }
  if (poi?.countryCode != null && poi.countryCode !== "") {
    const code = String(poi.countryCode);
    if (/^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
  }
  if (poi?.country != null && poi.country !== "") {
    const code = String(poi.country);
    if (/^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
  }
  const addr = item.address || item.addr;
  if (addr?.countryCode != null && addr.countryCode !== "") {
    const code = String(addr.countryCode);
    if (/^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
  }
  const anchor = item.anchor || item.anchorInfo;
  if (anchor?.locationCreated != null && anchor.locationCreated !== "") {
    const loc = String(anchor.locationCreated);
    if (/^[A-Za-z]{2}$/.test(loc)) return loc.toUpperCase();
    return null;
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
    const loc = String(item.locationCreated);
    return /^[A-Za-z]{2}$/.test(loc) ? loc.toUpperCase() : null;
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

export function parseLocationCreatedFromVideoHtml(html, videoId) {
  if (!html || typeof html !== "string") return null;
  if (isAccessDeniedContent(html)) return null;
  return (
    parseLocationCreatedFromUniversalHtml(html) ||
    parseLocationCreatedFromSigiHtml(html, videoId)
  );
}

/**
 * Node fetch + CDP cookie（诊断脚本用，国家预筛不走此路径）
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
 * 不打开视频 tab：在 tiktok.com 上下文中 fetch 视频 HTML，解析 UNIVERSAL 中的 locationCreated。
 * api-only 模式仍允许（仅用 fetch，无 page.goto 视频页）。
 */
export async function fetchLocationCreatedFromVideoHtmlRequest(page, username, videoId) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const id = String(videoId || "").trim();
  if (!handle || !id) return null;
  const videoUrl = `https://www.tiktok.com/@${handle}/video/${id}`;
  await bootstrapTiktokWebSession(page).catch(() => {});
  if (page) page._ttCountryHtmlLoginStub = false;
  let recoveredOnce = false;
  let sessionRefreshed = false;
  const triedProxyNodes = new Set();
  const maxAttempts = Math.min(
    Number(process.env.TT_LITE_COUNTRY_HTML_FETCH_TRIES || 3),
    6
  );
  const htmlTimeoutMs = Math.max(
    5000,
    Number(process.env.TT_LITE_COUNTRY_HTML_TIMEOUT_MS || 18000)
  );
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (page && (await isPageAccessDenied(page)) && !recoveredOnce) {
      recoveredOnce = true;
      const ok = await recoverTiktokPageFromAccessDenied(page);
      if (!ok) break;
      invalidateTiktokWebSession(page);
      await bootstrapTiktokWebSession(page, { forceRefresh: true }).catch(() => {});
    }
    try {
      const evalPromise = page.evaluate(async ({ url, timeoutMs }) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
      }, { url: videoUrl, timeoutMs: htmlTimeoutMs });
      const html = await Promise.race([
        evalPromise,
        new Promise((r) => setTimeout(() => r(null), htmlTimeoutMs + 2000)),
      ]);
      if (!html) continue;
      if (isAccessDeniedContent(html)) {
        const switched = await switchTiktokProxyAfterHtmlStub(
          triedProxyNodes,
          "video_html_access_denied"
        );
        if (switched && page) {
          recoveredOnce = false;
          await requestTiktok9223Restart("video_html_access_denied");
          invalidateTiktokWebSession(page);
          await recoverTiktokPageFromAccessDenied(page).catch(() => false);
          await bootstrapTiktokWebSession(page, { forceRefresh: true }).catch(
            () => {}
          );
          continue;
        }
        if (!sessionRefreshed && page) {
          sessionRefreshed = true;
          console.warn(
            `[tiktok-direct] video_html access_denied no node left; session refresh (clear cookies + rebootstrap) via ${page._ttApiSessionKey || "cdp"}`
          );
          await refreshTiktokApiSession(page).catch(() => false);
          continue;
        }
        if (!recoveredOnce && page) {
          recoveredOnce = true;
          const ok = await recoverTiktokPageFromAccessDenied(page);
          if (ok) {
            invalidateTiktokWebSession(page);
            await bootstrapTiktokWebSession(page, { forceRefresh: true }).catch(
              () => {}
            );
          }
        }
        continue;
      }
      const loc = parseLocationCreatedFromVideoHtml(html, id);
      if (loc) return loc;
      if (isVideoHtmlLoginStub(html)) {
        if (page) page._ttCountryHtmlLoginStub = true;
        const switched = await switchTiktokProxyAfterHtmlStub(
          triedProxyNodes,
          `video_html_stub_len_${html.length}`
        );
        if (switched && page) {
          recoveredOnce = false;
          await requestTiktok9223Restart(`video_html_stub_len_${html.length}`);
          invalidateTiktokWebSession(page);
          await bootstrapTiktokWebSession(page, { forceRefresh: true }).catch(
            () => {}
          );
          continue;
        }
        if (!sessionRefreshed && page) {
          sessionRefreshed = true;
          console.warn(
            `[tiktok-direct] video_html stub ${html.length}B no node left; session refresh (clear cookies + rebootstrap) via ${page._ttApiSessionKey || "cdp"}`
          );
          await refreshTiktokApiSession(page).catch(() => false);
          continue;
        }
        if (!recoveredOnce && page) {
          recoveredOnce = true;
          invalidateTiktokWebSession(page);
          await bootstrapTiktokWebSession(page, { forceRefresh: true }).catch(
            () => {}
          );
        }
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

/**
 * Lite 国家：只保留 video_html_fetch。
 * @param {object} page
 * @param {{ videoId?: string, username?: string }} opts
 */
export async function resolveVideoLocationCreated(page, opts = {}) {
  const username = String(opts.username || "").replace(/^@/, "").trim();
  const videoId = opts.videoId ? String(opts.videoId) : "";

  if (!videoId || !username) {
    return { locationCreated: null, source: null, error: "missing_video_or_user" };
  }

  if (page) page._ttCountryHtmlLoginStub = false;

  const htmlBrowser = await fetchLocationCreatedFromVideoHtmlRequest(
    page,
    username,
    videoId
  );
  if (htmlBrowser) {
    return { locationCreated: htmlBrowser, source: "video_html_fetch" };
  }

  return { locationCreated: null, source: null, error: "no_location_in_universal" };
}

function buildCountryProbeVideoIds(videoId, altVideoIds = []) {
  const primary = videoId ? String(videoId) : "";
  const altIds = Array.isArray(altVideoIds)
    ? altVideoIds.map(String).filter(Boolean)
    : [];
  const maxSearchAlt = Math.min(
    Number(process.env.TT_LITE_COUNTRY_SEARCH_ALT_VIDEOS || 1),
    20
  );
  return [
    ...(primary ? [primary] : []),
    ...altIds.filter((id) => id && id !== primary),
  ].slice(0, 1 + maxSearchAlt);
}

/**
 * 国家预筛：代表视频与搜索 alt 视频逐条 HTML fetch 探测，只接受 ISO-2 locationCreated。
 * @param {object} page
 * @param {{ videoId?: string, username?: string, altVideoIds?: string[] }} opts
 */
export async function resolveVideoLocationCreatedForInfluencer(page, opts = {}) {
  const username = String(opts.username || "").replace(/^@/, "").trim();
  const videoId = opts.videoId ? String(opts.videoId) : "";

  const tryIds = buildCountryProbeVideoIds(videoId, opts.altVideoIds);
  if (!tryIds.length || !username) {
    return {
      locationCreated: null,
      source: null,
      error: "missing_video_or_user",
      representativeVideoId: videoId || null,
    };
  }

  for (let i = 0; i < tryIds.length; i += 1) {
    const vid = tryIds[i];
    const result = await resolveVideoLocationCreated(page, {
      videoId: vid,
      username,
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

/**
 * Lite 导入 Phase 1：user/detail + post/item_list(count=1) 取首条代表视频
 * @param {import('playwright').Page} page
 * @param {string} username
 * @returns {Promise<{ videoId: string|null, videoUrl: string|null, secUid: string|null, userId: string|null, error?: string }>}
 */
export async function fetchFirstRepresentativeVideoForUser(page, username) {
  const handle = String(username || "").replace(/^@/, "").trim();
  if (!handle) {
    return {
      videoId: null,
      videoUrl: null,
      secUid: null,
      userId: null,
      error: "missing_username",
    };
  }

  let secUid = "";
  let userId = null;
  try {
    const detailJson = await fetchUserDetail(page, handle, {});
    const user = detailJson?.userInfo?.user || detailJson?.user || null;
    secUid = String(user?.secUid || user?.sec_uid || "").trim();
    userId = user?.id || user?.userId || null;
  } catch (e) {
    return {
      videoId: null,
      videoUrl: null,
      secUid: null,
      userId: null,
      error: e.message,
    };
  }

  if (!secUid) {
    return {
      videoId: null,
      videoUrl: null,
      secUid: null,
      userId,
      error: "missing_sec_uid",
    };
  }

  try {
    const listJson = await fetchPostItemList(page, {
      secUid,
      count: 1,
      cursor: 0,
      referer: `https://www.tiktok.com/@${handle}`,
    });
    const items = listJson?.itemList || listJson?.item_list || [];
    const first = items[0];
    if (!first) {
      return {
        videoId: null,
        videoUrl: null,
        secUid,
        userId,
        error: "no_posts",
      };
    }
    const videoId = String(first.id || first.aweme_id || "").trim();
    if (!videoId) {
      return {
        videoId: null,
        videoUrl: null,
        secUid,
        userId,
        error: "no_video_id",
      };
    }
    return {
      videoId,
      videoUrl: `https://www.tiktok.com/@${handle}/video/${videoId}`,
      secUid,
      userId,
    };
  } catch (e) {
    return {
      videoId: null,
      videoUrl: null,
      secUid,
      userId,
      error: e.message,
    };
  }
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
  };
  if (process.env.TT_LITE_POST_ITEM_EXTENDED_PARAMS === "1") {
    params.coverFormat = "2";
    params.from_page = "user";
    params.needPinnedItemIds = "true";
  }
  return tiktokMakeRequest(
    page,
    "https://www.tiktok.com/api/post/item_list/",
    params,
    { referer, requireItems: true, retries: Number(process.env.TT_LITE_POST_ITEM_RETRIES || 2) }
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
    Math.max(Number(process.env.TT_LITE_ITEM_LIST_COUNT || 16), 1),
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

/**
 * 综合搜索（general/full）：返回视频/红人混合数据，无登录可用，
 * 且不受视频搜索（item/full）的账号 2484 每日配额限制。
 * @param {object} page
 * @param {{ keyword: string, cursor?: number|string, searchId?: string }} opts
 */
export async function fetchSearchGeneralFull(page, opts) {
  const { keyword, cursor = 0, searchId = "", count } = opts;
  const searchReferer = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;
  const params = {
    keyword,
    cursor: String(cursor),
    search_id: searchId || "0",
    from_page: "search",
    count: String(count || process.env.TT_LITE_SEARCH_COUNT || 40),
  };
  const json = await tiktokMakeRequest(
    page,
    "https://www.tiktok.com/api/search/general/full/",
    params,
    { referer: searchReferer, allowStatusCode203: true }
  );
  if (json?.status_code === 0 || json?.status_code === 203 || Array.isArray(json?.data)) {
    return json;
  }
  throw new Error(`general search api empty status_code=${json?.status_code}`);
}

/**
 * 综合搜索翻页：cursor + has_more，只保留 status_code 0/203 且有 data 的批次。
 */
export async function fetchSearchGeneralFullAll(page, keyword, opts = {}) {
  const maxPages = Math.min(
    Math.max(Number(opts.maxPages || process.env.TT_LITE_SEARCH_MAX_PAGES || 80), 2),
    80
  );
  const perPage = Math.min(
    Math.max(Number(process.env.TT_LITE_SEARCH_COUNT || 40), 1),
    80
  );
  const batches = [];
  let cursor = 0;
  let hasMore = true;
  let searchId = "";

  for (let i = 0; i < maxPages && hasMore; i += 1) {
    let json;
    try {
      json = await fetchSearchGeneralFull(page, {
        keyword,
        cursor,
        searchId,
        count: perPage,
      });
    } catch (e) {
      console.warn(
        `[tiktok-direct] general search page ${i + 1}/${maxPages} failed: ${e.message}`
      );
      break;
    }
    batches.push(json);
    const items = Array.isArray(json?.data) ? json.data : [];
    const videoCount = items.filter((it) => it?.type === 1).length;
    hasMore =
      (json?.has_more === 1 || json?.has_more === true) &&
      videoCount > 0;
    const nextCursor = json?.cursor;
    if (nextCursor == null || nextCursor === cursor) hasMore = false;
    else cursor = nextCursor;
    if (json?.log_pb?.impr_id) searchId = String(json.log_pb.impr_id);
    if (json?.extra?.logid && !searchId) searchId = String(json.extra.logid);
    const delay = Number(process.env.TT_LITE_SEARCH_DELAY_MS || 180);
    if (hasMore && delay > 0) await page.waitForTimeout(delay);
  }
  return batches;
}

export function resolveTiktokLiteEnrichEndpoints() {
  const explicit = String(process.env.TT_LITE_ENRICH_CDP_ENDPOINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) {
    return [...new Set(explicit)];
  }
  return [
    process.env.TT_LITE_ENRICH_CDP,
    process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223",
    "http://127.0.0.1:9223",
    process.env.CDP_ENDPOINT,
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index);
}

export function resolveTiktokLiteSearchEndpoint() {
  return (
    process.env.TT_LITE_SEARCH_CDP ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9222"
  );
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
