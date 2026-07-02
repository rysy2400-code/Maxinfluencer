/**
 * TikTok Web API 客户端（参考 TikTok-Api）：
 * - 仅在 tiktok.com 首页 bootstrap 一次（获取 msToken + byted_acrawler）
 * - 后续全部 signed fetch，不打开搜索页/红人主页
 */

import { attachLitePageNavTracker } from "./lite-page-nav.js";

/** @type {Map<string, { params: object, msToken: string|null, verifyFp: string|null, bootstrappedAt: number }>} */
const sessionStore = new Map();

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

async function buildSessionParams(page, deviceId) {
  const region = process.env.TT_WEB_REGION || "US";
  return page.evaluate(
    ({ regionCode, devId }) => {
      const language = navigator.language || "en-US";
      const platform = navigator.platform || "Win32";
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      return {
        aid: "1988",
        app_language: language,
        app_name: "tiktok_web",
        browser_language: language,
        browser_name: "Mozilla",
        browser_online: "true",
        browser_platform: platform,
        browser_version: navigator.userAgent,
        channel: "tiktok_web",
        cookie_enabled: "true",
        device_id: devId,
        device_platform: "web_pc",
        focus_state: "true",
        history_len: "3",
        is_fullscreen: "false",
        is_page_visible: "true",
        language,
        os: platform,
        priority_region: "",
        referer: "",
        region: regionCode,
        screen_height: String(window.screen?.height || 1080),
        screen_width: String(window.screen?.width || 1920),
        tz_name: timezone,
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

function hasUsableJson(json) {
  if (!json || typeof json !== "object") return false;
  if (json.status_code != null && json.status_code !== 0) return false;
  if (json.statusCode != null && json.statusCode !== 0) return false;
  return true;
}

function itemListLength(json) {
  if (!json) return 0;
  return (json.itemList || json.item_list || []).length;
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
export async function bootstrapTiktokWebSession(page) {
  attachLitePageNavTracker(page);
  const key = sessionKey(page);
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
      console.log(`[tiktok-api] bootstrap homepage via ${key}`);
      await page
        .goto("https://www.tiktok.com/", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        .catch(() => {});
    }
    ready = await waitForAcrawler(
      page,
      Number(process.env.TT_LITE_ACRAWLER_WAIT_MS || 20_000)
    );
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

async function signTiktokUrl(page, urlWithQuery) {
  return page.evaluate((u) => {
    if (typeof window.byted_acrawler?.frontierSign !== "function") return u;
    const signed = window.byted_acrawler.frontierSign(u);
    const xBogus = signed?.["X-Bogus"] || signed?.X_Bogus;
    if (!xBogus) return u;
    const sep = u.includes("?") ? "&" : "?";
    // TikTok-Api 不对 X-Bogus 做 URL 编码
    return `${u}${sep}X-Bogus=${xBogus}`;
  }, urlWithQuery);
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
  const merged = { ...(session.params || {}), ...extraParams };
  if (msToken) merged.msToken = msToken;
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
  return page.evaluate(
    async ({ fetchUrl, refererUrl }) => {
      const res = await fetch(fetchUrl, {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          referer: refererUrl,
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
        json,
        isHtml: text.trimStart().startsWith("<!"),
        textPreview: text.slice(0, 240),
      };
    },
    { fetchUrl: signedUrl, refererUrl: referer }
  );
}

async function fetchSignedJsonViaNode(page, signedUrl, referer) {
  const ua =
    typeof page.evaluate === "function"
      ? await page.evaluate(() => navigator.userAgent)
      : "Mozilla/5.0";
  const cookies = await readTiktokCookies(page);
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const res = await fetch(signedUrl, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      referer,
      "user-agent": ua,
      cookie: cookieHeader,
    },
    redirect: "follow",
  });
  const text = await res.text();
  const json = parseJsonText(text);
  return {
    ok: res.ok,
    status: res.status,
    json,
    isHtml: text.trimStart().startsWith("<!"),
    textPreview: text.slice(0, 240),
  };
}

/**
 * TikTok-Api 风格 signed fetch（page 上下文内 fetch，带 X-Bogus）
 * @param {object} page
 * @param {string} apiUrl 不含 query 的 API URL
 * @param {Record<string,string|number>} [extraParams]
 * @param {{ referer?: string, retries?: number, requireItems?: boolean }} [opts]
 */
export async function tiktokMakeRequest(page, apiUrl, extraParams = {}, opts = {}) {
  const session = await bootstrapTiktokWebSession(page);
  const referer = opts.referer || "https://www.tiktok.com/";
  const retries = Math.min(Math.max(Number(opts.retries || 2), 1), 4);
  let lastErr = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const qs = toQuery(await mergeParams(session, extraParams, page));
      const base = `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}${qs}`;
      const signedUrl = await signTiktokUrl(page, base);

      let result = await fetchSignedJsonInBrowser(page, signedUrl, referer);
      const browserEmpty =
        !result.json ||
        result.isHtml ||
        !hasUsableJson(result.json) ||
        (opts.requireItems && itemListLength(result.json) === 0);

      if (browserEmpty) {
        result = await fetchSignedJsonViaNode(page, signedUrl, referer);
      }

      if (result.json && !result.isHtml && hasUsableJson(result.json)) {
        if (!opts.requireItems || itemListLength(result.json) > 0) {
          return result.json;
        }
      }

      const items = itemListLength(result.json);
      lastErr = new Error(
        `signed fetch empty status=${result.status} items=${items} preview=${result.textPreview || ""}`
      );
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries - 1) {
      await page.waitForTimeout(400 * (attempt + 1));
    }
  }

  throw lastErr || new Error("TikTok signed fetch failed");
}
