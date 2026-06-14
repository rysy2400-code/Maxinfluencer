/**
 * TikTok Web API 客户端（参考 TikTok-Api）：
 * - 仅在 tiktok.com 首页 bootstrap 一次（获取 msToken + byted_acrawler）
 * - 后续全部 signed fetch，不打开搜索页/红人主页
 */

/** @type {Map<string, { params: object, msToken: string|null, bootstrappedAt: number }>} */
const sessionStore = new Map();

function sessionKey(page) {
  return page?._ttApiSessionKey || process.env.CDP_ENDPOINT || "default";
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

async function buildSessionParams(page) {
  const region = process.env.TT_WEB_REGION || "US";
  return page.evaluate((regionCode) => {
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
      device_id: String(Math.floor(Math.random() * 9e18) + 1e18),
      device_platform: "web_pc",
      focus_state: "true",
      history_len: String(Math.floor(Math.random() * 9) + 1),
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
  }, region);
}

/**
 * Bootstrap：只访问 tiktok.com 首页（不打开搜索/主页），加载 acrawler + msToken
 * @param {object} page
 */
export async function bootstrapTiktokWebSession(page) {
  const key = sessionKey(page);
  const cached = sessionStore.get(key);
  if (cached && Date.now() - cached.bootstrappedAt < 30 * 60_000) {
    page._ttSessionParams = cached.params;
    page._ttMsToken = cached.msToken;
    return cached;
  }

  let ready = await hasAcrawler(page);
  if (!ready) {
    const current = String(typeof page.url === "function" ? page.url() : "");
    const needsHome =
      !current.includes("tiktok.com") ||
      /\/search\/|\/@|\/video\//.test(current.split("?")[0]);
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
  const params = await buildSessionParams(page);
  const session = { params, msToken, bootstrappedAt: Date.now() };
  sessionStore.set(key, session);
  page._ttSessionParams = params;
  page._ttMsToken = msToken;
  console.log(
    `[tiktok-api] session ready key=${key} msToken=${msToken ? "yes" : "no"}`
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
    return `${u}${sep}X-Bogus=${encodeURIComponent(xBogus)}`;
  }, urlWithQuery);
}

function mergeParams(session, extraParams = {}) {
  const merged = { ...(session.params || {}), ...extraParams };
  if (session.msToken) merged.msToken = session.msToken;
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

/**
 * TikTok-Api 风格 signed fetch（page 上下文内 fetch，带 X-Bogus）
 * @param {object} page
 * @param {string} apiUrl 不含 query 的 API URL
 * @param {Record<string,string|number>} [extraParams]
 * @param {{ referer?: string, retries?: number }} [opts]
 */
export async function tiktokMakeRequest(page, apiUrl, extraParams = {}, opts = {}) {
  const session = await bootstrapTiktokWebSession(page);
  const referer = opts.referer || "https://www.tiktok.com/";
  const retries = Math.min(Math.max(Number(opts.retries || 2), 1), 4);
  let lastErr = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const qs = toQuery(mergeParams(session, extraParams));
      const base = `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}${qs}`;
      const signedUrl = await signTiktokUrl(page, base);

      const result = await page.evaluate(
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

      if (result.json && !result.isHtml) {
        return result.json;
      }
      lastErr = new Error(
        `signed fetch empty status=${result.status} preview=${result.textPreview || ""}`
      );
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries - 1) {
      await page.waitForTimeout(300 * (attempt + 1));
    }
  }

  throw lastErr || new Error("TikTok signed fetch failed");
}
