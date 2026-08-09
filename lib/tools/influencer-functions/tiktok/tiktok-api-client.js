/**
 * TikTok Web API 客户端（参考 TikTok-Api）：
 * - 仅在 tiktok.com 首页 bootstrap 一次（获取 msToken + byted_acrawler）
 * - 后续全部 signed fetch，不打开搜索页/红人主页
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { attachLitePageNavTracker } from "./lite-page-nav.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const API_LOG = path.join(PROJECT_ROOT, "logs", "tiktok-api.log");

/** API 请求事件落盘：空响应/stub/冷却/慢请求（排查限流与停滞） */
function logApi(msg) {
  try {
    fs.mkdirSync(path.dirname(API_LOG), { recursive: true });
    fs.appendFileSync(API_LOG, `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

/** @type {Map<string, { params: object, msToken: string|null, verifyFp: string|null, bootstrappedAt: number }>} */
const sessionStore = new Map();
const pageOperationLocks = new WeakMap();

function sessionKey(page) {
  return page?._ttApiSessionKey || process.env.CDP_ENDPOINT || "default";
}

function stableDeviceId(cached) {
  if (cached?.params?.device_id) return cached.params.device_id;
  return String(Math.floor(Math.random() * 9e18) + 1e18);
}

async function readTiktokCookies(page) {
  if (typeof page.getTiktokCookies === "function") {
    return page.getTiktokCookies();
  }
  return page.evaluate(() => {
    const out = {};
    for (const part of String(document.cookie || "").split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
    return out;
  });
}

async function hasAcrawler(page) {
  try {
    return await page.evaluate(
      () => typeof window.byted_acrawler?.frontierSign === "function"
    );
  } catch {
    return false;
  }
}

async function waitForAcrawler(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasAcrawler(page)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function refreshTiktokHomepageContext(page) {
  if (!page || typeof page.reload !== "function") return false;
  try {
    const current = String(typeof page.url === "function" ? page.url() : "");
    const path = current.split("?")[0].split("#")[0];
    const reusableHome =
      current.includes("tiktok.com") && !/\/search\/|\/@|\/video\/|\/api\//.test(path);
    if (reusableHome) {
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } else {
      await page.goto("https://www.tiktok.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }
    await page.waitForTimeout(Number(process.env.TT_LITE_BOOTSTRAP_WAIT_MS || 1200));
    return true;
  } catch {
    return false;
  }
}

async function buildSessionParams(page, deviceId) {
  const region = process.env.TT_WEB_REGION || "US";
  return page.evaluate(
    ({ regionCode, devId }) => {
      const language = navigator.language || "en-US";
      const platform = navigator.platform || "Win32";
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const local = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key != null) local[key] = localStorage.getItem(key);
      }
      const session = {};
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (key != null) session[key] = sessionStorage.getItem(key);
      }
      const cookies = Object.fromEntries(
        String(document.cookie || "")
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const i = part.indexOf("=");
            return [i > 0 ? part.slice(0, i) : part, i > 0 ? part.slice(i + 1) : ""];
          })
      );
      let userSession = null;
      try {
        userSession = session.user_session ? JSON.parse(session.user_session) : null;
      } catch {
        userSession = null;
      }
      const loggedIn = !!(
        (userSession?.uid && String(userSession.uid) !== "0") ||
        cookies.sessionid ||
        cookies.sid_tt ||
        cookies.sessionid_ss
      );
      const sessionDeviceId =
        local.ttwid ||
        local.shopNotificationWID ||
        cookies.ttwid ||
        cookies.shopNotificationWID ||
        devId;
      const odinId =
        (userSession?.uid && String(userSession.uid) !== "0" && String(userSession.uid)) ||
        cookies.odin_tt ||
        cookies.odinId ||
        sessionDeviceId ||
        String(Math.floor(Math.random() * 9e18) + 1e18);
      const webIdLastTime =
        local.LIVE_CLEAN_INDEX_DB_LAST ||
        session.lastUpdated ||
        String(Math.floor(Date.now() / 1000));
      const webIdNumber = Number(webIdLastTime);
      const webIdSeconds =
        Number.isFinite(webIdNumber) && webIdNumber > 0
          ? webIdNumber > 99_999_999_999
            ? Math.floor(webIdNumber / 1000)
            : Math.floor(webIdNumber)
          : Math.floor(Date.now() / 1000);
      return {
        aid: "1988",
        app_language: language,
        app_name: "tiktok_web",
        browser_language: language,
        browser_name: "Mozilla",
        browser_online: "true",
        browser_platform: platform,
        browser_version: String(navigator.userAgent || "").replace(/^Mozilla\//, ""),
        channel: "tiktok_web",
        cookie_enabled: "true",
        device_id: sessionDeviceId,
        device_platform: "web_pc",
        focus_state: "true",
        history_len: String(window.history?.length || 2),
        is_fullscreen: "false",
        is_page_visible: "true",
        language,
        os: /Mac/i.test(platform) ? "mac" : platform,
        priority_region: loggedIn ? regionCode : "",
        referer: "",
        region: regionCode,
        screen_height: String(window.screen?.height || 1080),
        screen_width: String(window.screen?.width || 1920),
        tz_name: timezone,
        data_collection_enabled: "true",
        odinId,
        user_is_login: loggedIn ? "true" : "false",
        video_encoding: "dash",
        WebIdLastTime: String(webIdSeconds),
        webcast_language: language,
      };
    },
    { regionCode: region, devId: deviceId }
  );
}

function parseJsonText(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) return null;
  try {
    return JSON.parse(trimmed.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, ""));
  } catch {
    return null;
  }
}

function hasUsableJson(json, allow203 = false) {
  if (!json || typeof json !== "object") return false;
  const ok = (v) => v === 0 || (allow203 && v === 203);
  if (json.status_code != null && !ok(json.status_code)) return false;
  if (json.statusCode != null && !ok(json.statusCode)) return false;
  return true;
}

function itemListLength(json) {
  if (!json) return 0;
  return (json.itemList || json.item_list || []).length;
}

async function withPageOperationLock(page, name, fn) {
  if (!page || typeof page !== "object") return fn();
  const prev = pageOperationLocks.get(page) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const next = prev.catch(() => {}).then(() => current);
  pageOperationLocks.set(page, next);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (pageOperationLocks.get(page) === next) {
      pageOperationLocks.delete(page);
    }
  }
}

/** TikTok Web API 常需 verifyFp（s_v_web_id）；9222 长期会话可能缺失 */
function generateVerifyFp() {
  const seg = (n) => {
    let out = "";
    const chars =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    for (let i = 0; i < n; i += 1) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  };
  return `verify_${seg(8)}_${seg(8)}_${seg(4)}_${seg(4)}_${seg(4)}_${seg(12)}`;
}

async function waitForVerifyFpCookie(page, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cookies = await readTiktokCookies(page);
    const fp = cookies.s_v_web_id || cookies.verifyFp;
    if (fp) return fp;
    await page.waitForTimeout(400);
  }
  return null;
}

async function trySetVerifyFpCookie(page, verifyFp) {
  if (!verifyFp) return;
  try {
    await page.evaluate((fp) => {
      document.cookie = `s_v_web_id=${fp}; path=/; max-age=31536000; secure; samesite=none`;
    }, verifyFp);
  } catch {
    /* ignore */
  }
}

async function resolveVerifyFp(page, cachedFp = null) {
  let verifyFp =
    cachedFp ||
    (await waitForVerifyFpCookie(
      page,
      Number(process.env.TT_LITE_VERIFYFP_WAIT_MS || 12_000)
    ));
  if (!verifyFp) {
    verifyFp = generateVerifyFp();
    await trySetVerifyFpCookie(page, verifyFp);
  }
  if (page) page._ttVerifyFp = verifyFp;
  return verifyFp;
}

/**
 * Bootstrap：只访问 tiktok.com 首页（不打开搜索/主页），加载 acrawler + msToken
 * @param {object} page
 */
export function invalidateTiktokWebSession(page) {
  const key = sessionKey(page);
  sessionStore.delete(key);
  if (page) {
    page._ttSessionParams = null;
    page._ttMsToken = null;
    page._ttVerifyFp = null;
  }
}

export function isAccessDeniedContent(text) {
  if (!text || typeof text !== "string") return false;
  return /Access Denied|edgesuite\.net|don't have permission to access/i.test(text);
}

export async function isPageAccessDenied(page) {
  if (!page || typeof page.evaluate !== "function") return false;
  try {
    const info = await page.evaluate(() => ({
      title: document.title || "",
      body: (document.body?.innerText || "").slice(0, 600),
      url: location.href || "",
    }));
    return (
      isAccessDeniedContent(`${info.title}\n${info.body}`) ||
      /errors\.edgesuite\.net/i.test(info.url)
    );
  } catch {
    return false;
  }
}

/** 仅刷新 tiktok.com 首页会话，不打开视频/搜索/主页 tab */
export async function recoverTiktokPageFromAccessDenied(page) {
  if (!page || typeof page.goto !== "function") return false;
  invalidateTiktokWebSession(page);
  try {
    await page.goto("https://www.tiktok.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(1200);
    }
    return !(await isPageAccessDenied(page));
  } catch {
    return false;
  }
}

export async function bootstrapTiktokWebSession(page, options = {}) {
  attachLitePageNavTracker(page);
  const key = sessionKey(page);
  if (options.forceRefresh) {
    invalidateTiktokWebSession(page);
  }
  const cached = sessionStore.get(key);
  if (cached && Date.now() - cached.bootstrappedAt < 30 * 60_000 && cached.verifyFp) {
    page._ttSessionParams = cached.params;
    page._ttMsToken = cached.msToken;
    page._ttVerifyFp = cached.verifyFp;
    return cached;
  }

  let ready = await hasAcrawler(page);
  if (!ready) {
    const current = String(typeof page.url === "function" ? page.url() : "");
    const needsHome =
      !current.includes("tiktok.com") ||
      /\/search\/|\/@|\/video\/|\/api\//.test(current.split("?")[0]);
    if (needsHome && typeof page.goto === "function") {
      const apiDoc = current.includes("tiktok.com") && /\/api\//.test(current.split("?")[0]);
      if (process.env.TT_LITE_STRICT_API_ONLY_NO_GOTO === "1" && !apiDoc) {
        throw new Error(
          `TikTok API-only strict mode: current page is not a reusable TikTok session (${current || "unknown"})`
        );
      }
      console.log(`[tiktok-api] bootstrap homepage via ${key}`);
      await page
        .goto("https://www.tiktok.com/", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        .catch(() => {});
    } else if (current.includes("tiktok.com")) {
      console.log(`[tiktok-api] refresh homepage context for acrawler via ${key}`);
      await refreshTiktokHomepageContext(page);
    }
    ready = await waitForAcrawler(
      page,
      Number(process.env.TT_LITE_ACRAWLER_WAIT_MS || 20_000)
    );
    if (!ready && current.includes("tiktok.com")) {
      console.log(`[tiktok-api] acrawler still missing; force homepage bootstrap via ${key}`);
      await page
        .goto("https://www.tiktok.com/", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        .catch(() => {});
      ready = await waitForAcrawler(
        page,
        Number(process.env.TT_LITE_ACRAWLER_WAIT_MS || 20_000)
      );
    }
  }

  if (!ready) {
    throw new Error("TikTok byted_acrawler 未就绪，无法签名 API 请求");
  }

  await page.waitForTimeout(Number(process.env.TT_LITE_BOOTSTRAP_WAIT_MS || 1200));
  const cookies = await readTiktokCookies(page);
  const msToken = cookies.msToken || cookies.mstoken || null;
  const verifyFp = await resolveVerifyFp(page, cookies.s_v_web_id || cookies.verifyFp || null);
  const deviceId = stableDeviceId(cached);
  const params = await buildSessionParams(page, deviceId);
  const session = { params, msToken, verifyFp, bootstrappedAt: Date.now() };
  sessionStore.set(key, session);
  page._ttSessionParams = params;
  page._ttMsToken = msToken;
  page._ttVerifyFp = verifyFp;
  console.log(
    `[tiktok-api] session ready key=${key} msToken=${msToken ? "yes" : "no"} verifyFp=${verifyFp ? "yes" : "no"}`
  );
  return session;
}

async function signTiktokUrl(_page, urlWithQuery) {
  // TikTok Lite 生产路径固定使用 webmssdk auto-sign：
  // 在浏览器 tiktok.com 上下文内 fetch，让前端 SDK 自动补齐签名参数。
  return urlWithQuery;
}

async function mergeParams(session, extraParams = {}, page = null) {
  let msToken = session.msToken;
  let verifyFp = session.verifyFp;
  if (page) {
    try {
      const cookies = await readTiktokCookies(page);
      msToken = cookies.msToken || cookies.mstoken || msToken;
      verifyFp = cookies.s_v_web_id || cookies.verifyFp || verifyFp;
      if (msToken !== session.msToken || verifyFp !== session.verifyFp) {
        session.msToken = msToken;
        session.verifyFp = verifyFp;
        sessionStore.set(sessionKey(page), session);
      }
    } catch {
      /* ignore cookie refresh */
    }
  }
  if (!verifyFp) {
    verifyFp = await resolveVerifyFp(page, null);
    session.verifyFp = verifyFp;
    if (page) sessionStore.set(sessionKey(page), session);
  }
  if (page) {
    try {
      session.params = await buildSessionParams(page, stableDeviceId(session));
      sessionStore.set(sessionKey(page), session);
    } catch {
      /* ignore session refresh */
    }
  }
  const merged = { ...(session.params || {}), ...extraParams };
  if (verifyFp) merged.verifyFp = verifyFp;
  return merged;
}

function toQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

async function fetchSignedJsonInBrowser(page, signedUrl, referer) {
  let actualUrl = null;
  const targetPath = new URL(signedUrl).pathname;
  const handler = (request) => {
    try {
      const url = typeof request?.url === "function" ? request.url() : "";
      if (url.includes(targetPath)) actualUrl = url;
    } catch {
      /* ignore */
    }
  };
  try {
    if (typeof page.on === "function") page.on("request", handler);
    const result = await page.evaluate(
      async ({ fetchUrl, refererUrl }) => {
        const res = await fetch(fetchUrl, {
          method: "GET",
          credentials: "include",
          referrer: refererUrl,
          referrerPolicy: "unsafe-url",
          headers: {
            accept: "application/json, text/plain, */*",
          },
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, ""));
        } catch {
          json = null;
        }
        return {
          ok: res.ok,
          status: res.status,
          url: res.url || fetchUrl,
          json,
          isHtml: text.trimStart().startsWith("<!"),
          textPreview: text.slice(0, 240),
        };
      },
      { fetchUrl: signedUrl, refererUrl: referer }
    );
    if (result.url) actualUrl = result.url;
    if (process.env.TT_LITE_API_FETCH_DEBUG === "1") {
      const items = itemListLength(result.json);
      console.log(
        `[tiktok-api] browser fetch status=${result.status} html=${!!result.isHtml} usable=${hasUsableJson(result.json)} items=${items} path=${targetPath} actual=${actualUrl ? "yes" : "no"} preview=${String(result.textPreview || "").slice(0, 120)}`
      );
      if (actualUrl) {
        const limit = Number(process.env.TT_LITE_API_FETCH_DEBUG_URL_CHARS || 500);
        console.log(`[tiktok-api] browser fetch actualUrl=${actualUrl.slice(0, limit)}`);
      }
    }
    return { ...result, actualUrl };
  } finally {
    try {
      if (typeof page.off === "function") page.off("request", handler);
    } catch {
      /* ignore */
    }
  }
}

/**
 * TikTok-Api 风格 signed fetch（page 上下文内 fetch，由 webmssdk 自动签名）
 * @param {object} page
 * @param {string} apiUrl 不含 query 的 API URL
 * @param {Record<string,string|number>} [extraParams]
 * @param {{ referer?: string, retries?: number, requireItems?: boolean }} [opts]
 */
export async function tiktokMakeRequest(page, apiUrl, extraParams = {}, opts = {}) {
  const profileApi =
    apiUrl.includes("/api/user/detail/") || apiUrl.includes("/api/post/item_list/");
  if (profileApi && !opts._pageLockHeld) {
    return withPageOperationLock(page, "tiktok-profile-api", () =>
      tiktokMakeRequest(page, apiUrl, extraParams, {
        ...opts,
        _pageLockHeld: true,
      })
    );
  }
  const session = await bootstrapTiktokWebSession(page);
  const referer = opts.referer || "https://www.tiktok.com/";
  const retries = Math.min(Math.max(Number(opts.retries || 2), 1), 4);
  let lastErr = null;
  const t0 = Date.now();

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const qs = toQuery(await mergeParams(session, extraParams, page));
      const base = `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}${qs}`;
      const signedUrl = await signTiktokUrl(page, base);

      let result = await fetchSignedJsonInBrowser(page, signedUrl, referer);
      const browserEmpty =
        !result.json ||
        result.isHtml ||
        !hasUsableJson(result.json, opts.allowStatusCode203) ||
        (opts.requireItems && itemListLength(result.json) === 0);

      if (browserEmpty) {
        logApi(
          `EMPTY status=${result.status} html=${result.isHtml ? "yes" : "no"} ` +
            `items=${itemListLength(result.json)} url=${apiUrl} attempt=${attempt + 1}/${retries} ` +
            `preview=${String(result.textPreview || "").slice(0, 80)}`
        );
        if (result.isHtml) {
          invalidateTiktokWebSession(page);
          await bootstrapTiktokWebSession(page, { forceRefresh: true });
        }
      }

      if (
        result.json &&
        !result.isHtml &&
        hasUsableJson(result.json, opts.allowStatusCode203)
      ) {
        if (!opts.requireItems || itemListLength(result.json) > 0) {
          return result.json;
        }
      }

      const items = itemListLength(result.json);
      lastErr = new Error(
        `signed fetch empty status=${result.status} items=${items} preview=${result.textPreview || ""}`
      );
      if (result.isHtml || items === 0) {
        invalidateTiktokWebSession(page);
        await bootstrapTiktokWebSession(page, { forceRefresh: true });
        const cooldownMs = Math.max(
          0,
          Number(process.env.TT_LITE_EMPTY_ITEMS_COOLDOWN_MS || 3000)
        );
        if (cooldownMs > 0) {
          logApi(`COOLDOWN ${cooldownMs}ms after empty url=${apiUrl} attempt=${attempt + 1}/${retries}`);
          await page.waitForTimeout(cooldownMs);
        }
      }
    } catch (e) {
      lastErr = e;
      logApi(`ERR ${apiUrl} attempt=${attempt + 1}/${retries} ${String(e.message || e).slice(0, 160)}`);
    }
    if (attempt < retries - 1) {
      await page.waitForTimeout(400 * (attempt + 1));
    }
  }

  const totalMs = Date.now() - t0;
  if (totalMs > 10000) {
    logApi(`SLOW ${totalMs}ms url=${apiUrl} retries=${retries} err=${String(lastErr?.message || "").slice(0, 120)}`);
  }
  throw lastErr || new Error("TikTok signed fetch failed");
}
