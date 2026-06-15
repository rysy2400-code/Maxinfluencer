/**
 * Instagram API 直调：在已登录的 instagram.com 页面上下文内 fetch，无需打开搜索/主页。
 */

import { isLiteScraperMode } from "../../../scraper/resolve-scraper-mode.js";

const BLOCKED_RESOURCE_TYPES = new Set(
  String(process.env.LITE_BLOCK_RESOURCE_TYPES || "image,media,font")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const pageEvaluateChains = new WeakMap();
/** @type {WeakMap<object, string>} */
const relayTemplateStore = new WeakMap();
/** @type {Map<string, { templates: Map<string, string>, fallback: string|null, reqSeq: number, updatedAt: number }>} */
const relaySessionStore = new Map();

function resolveIgRelaySessionKey(page) {
  if (page?._igRelaySessionKey) return page._igRelaySessionKey;
  return process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
}

function parseRelayFriendlyName(requestBody) {
  try {
    return new URLSearchParams(String(requestBody)).get("fb_api_req_friendly_name") || null;
  } catch {
    return null;
  }
}

function isUsableRelayTemplate(requestBody) {
  const body = String(requestBody || "");
  if (body.length < 80) return false;
  return (
    body.includes("lsd=") &&
    (body.includes("fb_dtsg=") || body.includes("__dyn=") || body.includes("__csr="))
  );
}

function getRelaySessionEntry(key) {
  let entry = relaySessionStore.get(key);
  if (!entry) {
    entry = { templates: new Map(), fallback: null, reqSeq: 0, updatedAt: 0 };
    relaySessionStore.set(key, entry);
  }
  return entry;
}

/**
 * @param {object|null|undefined} page
 * @param {string} requestBody
 * @param {string} [sessionKey]
 */
export function setIgRelayTemplate(page, requestBody, sessionKey) {
  if (!isUsableRelayTemplate(requestBody)) return;
  const body = String(requestBody);
  const key = sessionKey || resolveIgRelaySessionKey(page);
  const friendlyName = parseRelayFriendlyName(body);
  const entry = getRelaySessionEntry(key);
  entry.fallback = body;
  entry.updatedAt = Date.now();
  if (friendlyName) entry.templates.set(friendlyName, body);
  if (page) {
    relayTemplateStore.set(page, body);
    page._igRelaySessionKey = key;
    if (friendlyName) {
      if (!page._igRelayTemplates) page._igRelayTemplates = new Map();
      page._igRelayTemplates.set(friendlyName, body);
    }
  }
}

/**
 * @param {object|null|undefined} page
 * @param {string} [friendlyName]
 */
export function getIgRelayTemplate(page, friendlyName) {
  if (page?._igRelayTemplates && friendlyName) {
    const localNamed = page._igRelayTemplates.get(friendlyName);
    if (localNamed) return localNamed;
  }
  if (page && !friendlyName) {
    const local = relayTemplateStore.get(page);
    if (local) return local;
  }
  const key = resolveIgRelaySessionKey(page);
  const entry = relaySessionStore.get(key);
  if (!entry) return null;
  if (friendlyName && entry.templates.has(friendlyName)) {
    return entry.templates.get(friendlyName);
  }
  return entry.fallback;
}

function nextRelayReqCounter(page) {
  const key = resolveIgRelaySessionKey(page);
  const entry = getRelaySessionEntry(key);
  entry.reqSeq = (entry.reqSeq || 0) + 1;
  return String(entry.reqSeq);
}

/**
 * 无模板时等待被动 harvest 或做一次轻量 reload
 * @param {object} page
 */
export async function warmUpIgRelayTemplateIfNeeded(page) {
  if (getIgRelayTemplate(page)) return true;
  if (process.env.IG_LITE_SKIP_RELAY_WARMUP === "1") return false;

  const maxWait = Math.min(
    Math.max(Number(process.env.IG_LITE_RELAY_WARMUP_MS || 8000), 2000),
    25_000
  );
  const step = 400;

  for (let waited = 0; waited < maxWait; waited += step) {
    if (getIgRelayTemplate(page)) return true;
    await page.waitForTimeout(step);
  }

  if (typeof page.reload === "function") {
    try {
      await page.reload({ waitUntil: "commit", timeout: 60_000 });
    } catch {
      try {
        await page.reload({ ignoreCache: true });
      } catch {
        /* ignore */
      }
    }
  } else if (typeof page.goto === "function") {
    const current = String(page.url?.() || "");
    if (!current.includes("instagram.com")) {
      await page
        .goto("https://www.instagram.com/", {
          waitUntil: "commit",
          timeout: 60_000,
        })
        .catch(() => {});
    }
  }

  for (let waited = 0; waited < maxWait; waited += step) {
    if (getIgRelayTemplate(page)) return true;
    await page.waitForTimeout(step);
  }
  return !!getIgRelayTemplate(page);
}

/**
 * 会话就绪：被动 harvest + reload，必要时用 bootstrap GraphQL 探活（不打开搜索页）
 * @param {object} page
 */
export async function ensureIgRelaySessionReady(page) {
  if (getIgRelayTemplate(page, IG_GQL_SEARCH_FRIENDLY)) return true;
  await warmUpIgRelayTemplateIfNeeded(page);
  if (getIgRelayTemplate(page, IG_GQL_SEARCH_FRIENDLY)) return true;

  const bootstrap = await extractIgRelayBootstrap(page);
  if (!bootstrap?.csrf) return false;

  const probe = await igGraphqlFetch(page, {
    docId: IG_GQL_SEARCH_DOC_ID,
    friendlyName: IG_GQL_SEARCH_FRIENDLY,
    variables: {
      query: "instagram",
      search_session_id: await newIgSessionId(page),
      serp_session_id: await newIgSessionId(page),
    },
    referer: "https://www.instagram.com/",
  });
  if (probe && !probe.__error) {
    if (process.env.IG_LITE_DEBUG_RELAY === "1") {
      console.log("[instagram-direct] relay session ready via bootstrap graphql");
    }
    return true;
  }
  return !!getIgRelayTemplate(page);
}

function buildRelayBodyFromTemplate(templateBody, { docId, friendlyName, variables }, bootstrap = null, page = null) {
  const params = new URLSearchParams(templateBody);
  if (bootstrap) {
    if (bootstrap.lsd) params.set("lsd", bootstrap.lsd);
    if (bootstrap.dtsg) params.set("fb_dtsg", bootstrap.dtsg);
    if (bootstrap.jazoest) params.set("jazoest", bootstrap.jazoest);
    if (bootstrap.av) params.set("av", bootstrap.av);
    if (bootstrap.hsi) params.set("__hsi", bootstrap.hsi);
    if (bootstrap.rev) params.set("__rev", bootstrap.rev);
    if (bootstrap.hs) params.set("__hs", bootstrap.hs);
  }
  params.set("variables", JSON.stringify(variables));
  params.set("doc_id", docId);
  if (friendlyName) params.set("fb_api_req_friendly_name", friendlyName);
  params.set("__req", nextRelayReqCounter(page));
  return params.toString();
}

function withPageEvaluateLock(page, fn) {
  const prev = pageEvaluateChains.get(page) || Promise.resolve();
  const run = prev.then(() => fn());
  pageEvaluateChains.set(
    page,
    run.catch(() => {}).then(() => undefined)
  );
  return run;
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
 * @param {import('playwright').Page} page
 */
export async function extractIgFetchCredentials(page) {
  if (typeof page.getInstagramCookies === "function") {
    const map = await page.getInstagramCookies();
    let wwwClaim = map.wwwClaimV2 || null;
    if (!wwwClaim) {
      try {
        const extra = await page.evaluate(() => ({
          wwwClaim: sessionStorage.getItem("wwwClaimV2") || null,
        }));
        wwwClaim = extra?.wwwClaim || null;
      } catch {
        /* ignore */
      }
    }
    return {
      csrf: map.csrftoken || null,
      appId: map.__ig_app_id || "936619743392459",
      wwwClaim,
      origin: "https://www.instagram.com",
    };
  }
  return page.evaluate(() => {
    const cookies = document.cookie || "";
    const csrf = cookies.match(/csrftoken=([^;]+)/)?.[1] || null;
    const appId =
      window.__igAppId ||
      sessionStorage.getItem("__ig_app_id") ||
      "936619743392459";
    const wwwClaim =
      cookies.match(/ig_nrcb=1/)?.input ||
      sessionStorage.getItem("wwwClaimV2") ||
      null;
    return { csrf, appId, wwwClaim, origin: location.origin };
  });
}

async function newIgSessionId(page) {
  return page.evaluate(() => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  });
}

/**
 * 从 instagram.com 页面提取 GraphQL relay 公共参数
 * @param {import('playwright').Page} page
 */
export async function extractIgRelayBootstrap(page) {
  if (typeof page.getInstagramCookies === "function") {
    const map = await page.getInstagramCookies();
    let htmlBoot = {};
    try {
      htmlBoot = await page.evaluate(() => {
        const html = document.documentElement?.innerHTML || "";
        const scripts = [...document.querySelectorAll("script")].map((s) => s.textContent || "");
        const blob = [html, ...scripts].join("\n");
        const pick = (...patterns) => {
          for (const p of patterns) {
            const m = blob.match(p);
            if (m?.[1]) return m[1];
          }
          return null;
        };
        return {
          lsd: pick(/"LSD",\[\],\{"token":"([^"]+)"/, /"lsd":"([^"]+)"/, /name="lsd" value="([^"]+)"/),
          dtsg: pick(/"dtsg":\{"token":"([^"]+)"/, /name="fb_dtsg" value="([^"]+)"/, /"DTSGInitialData",\[\],\{"token":"([^"]+)"/),
          jazoest: pick(/name="jazoest" value="(\d+)"/, /jazoest=(\d+)/),
          rev: pick(/"__rev":(\d+)/, /"client_revision":(\d+)/),
          hsi: pick(/"hsi":"(\d+)"/, /"hsi":(\d+)/),
          dyn: pick(/"__dyn":"([^"]+)"/, /__dyn=([^&"]+)/),
          csr: pick(/"__csr":"([^"]+)"/, /__csr=([^&"]+)/),
          hs: pick(/"haste_session":"([^"]+)"/),
          hsdp: pick(/"hsdp":"([^"]+)"/),
          hblp: pick(/"hblp":"([^"]+)"/),
          sjsp: pick(/"sjsp":"([^"]+)"/),
          spinR: pick(/"__spin_r":(\d+)/),
          spinB: pick(/"__spin_b":"([^"]+)"/),
          spinT: pick(/"__spin_t":(\d+)/),
        };
      });
    } catch {
      htmlBoot = {};
    }
    return {
      csrf: map.csrftoken || null,
      av: map.ds_user_id || null,
      wwwClaim: map.wwwClaimV2 || null,
      appId: map.__ig_app_id || "936619743392459",
      origin: "https://www.instagram.com",
      ...htmlBoot,
    };
  }
  return page.evaluate(() => {
    const html = document.documentElement?.innerHTML || "";
    const scripts = [...document.querySelectorAll("script")].map((s) => s.textContent || "");
    const blob = [html, ...scripts].join("\n");
    const pick = (...patterns) => {
      for (const p of patterns) {
        const m = blob.match(p);
        if (m?.[1]) return m[1];
      }
      return null;
    };
    const cookies = document.cookie || "";
    const csrf = cookies.match(/csrftoken=([^;]+)/)?.[1] || null;
    const av = cookies.match(/ds_user_id=([^;]+)/)?.[1] || null;
    return {
      csrf,
      av,
      lsd: pick(/"LSD",\[\],\{"token":"([^"]+)"/, /"lsd":"([^"]+)"/, /name="lsd" value="([^"]+)"/),
      dtsg: pick(/"dtsg":\{"token":"([^"]+)"/, /name="fb_dtsg" value="([^"]+)"/, /"DTSGInitialData",\[\],\{"token":"([^"]+)"/),
      jazoest: pick(/name="jazoest" value="(\d+)"/, /jazoest=(\d+)/),
      rev: pick(/"__rev":(\d+)/, /"client_revision":(\d+)/),
      hsi: pick(/"hsi":"(\d+)"/, /"hsi":(\d+)/),
      dyn: pick(/"__dyn":"([^"]+)"/, /__dyn=([^&"]+)/),
      csr: pick(/"__csr":"([^"]+)"/, /__csr=([^&"]+)/),
      hs: pick(/"haste_session":"([^"]+)"/),
      hsdp: pick(/"hsdp":"([^"]+)"/),
      hblp: pick(/"hblp":"([^"]+)"/),
      sjsp: pick(/"sjsp":"([^"]+)"/),
      spinR: pick(/"__spin_r":(\d+)/),
      spinB: pick(/"__spin_b":"([^"]+)"/),
      spinT: pick(/"__spin_t":(\d+)/),
      wwwClaim: sessionStorage.getItem("wwwClaimV2") || null,
      appId:
        window.__igAppId ||
        sessionStorage.getItem("__ig_app_id") ||
        "936619743392459",
      origin: location.origin,
    };
  });
}

function buildRelayFormBody(bootstrap, { docId, friendlyName, variables, referer }) {
  const params = new URLSearchParams();
  if (bootstrap.av) params.set("av", bootstrap.av);
  params.set("__d", "www");
  params.set("__user", bootstrap.av || "0");
  params.set("__a", "1");
  params.set("__req", String(Math.floor(Math.random() * 8) + 1));
  if (bootstrap.hs) params.set("__hs", bootstrap.hs);
  params.set("dpr", "1");
  params.set("__ccg", "EXCELLENT");
  if (bootstrap.rev) params.set("__rev", bootstrap.rev);
  params.set("__s", "lite::lite");
  if (bootstrap.hsi) params.set("__hsi", bootstrap.hsi);
  if (bootstrap.dyn) params.set("__dyn", bootstrap.dyn);
  if (bootstrap.csr) params.set("__csr", bootstrap.csr);
  if (bootstrap.hsdp) params.set("__hsdp", bootstrap.hsdp);
  if (bootstrap.hblp) params.set("__hblp", bootstrap.hblp);
  if (bootstrap.sjsp) params.set("__sjsp", bootstrap.sjsp);
  params.set("__comet_req", "7");
  if (bootstrap.dtsg) params.set("fb_dtsg", bootstrap.dtsg);
  if (bootstrap.jazoest) params.set("jazoest", bootstrap.jazoest);
  if (bootstrap.lsd) params.set("lsd", bootstrap.lsd);
  if (bootstrap.spinR) params.set("__spin_r", bootstrap.spinR);
  if (bootstrap.spinB) params.set("__spin_b", bootstrap.spinB);
  if (bootstrap.spinT) params.set("__spin_t", bootstrap.spinT);
  params.set("fb_api_caller_class", "RelayModern");
  if (friendlyName) params.set("fb_api_req_friendly_name", friendlyName);
  params.set("server_timestamps", "true");
  params.set("variables", JSON.stringify(variables));
  params.set("doc_id", docId);
  void referer;
  return params.toString();
}

const IG_GQL_SEARCH_DOC_ID =
  process.env.IG_GQL_SEARCH_DOC_ID || "27261995973455813";
const IG_GQL_SEARCH_FRIENDLY =
  process.env.IG_GQL_SEARCH_FRIENDLY || "PolarisKeywordSearchExplorePageRelayQuery";
const IG_GQL_REELS_DOC_ID =
  process.env.IG_GQL_REELS_DOC_ID || "26909206778772295";
const IG_GQL_REELS_FRIENDLY =
  process.env.IG_GQL_REELS_FRIENDLY || "PolarisProfileReelsTabContentQuery";

function parseIgGraphqlResponseText(text) {
  const jsonText = String(text || "").replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "");
  return JSON.parse(jsonText);
}

/**
 * @param {object} page
 * @param {{ navigateUrl: string, matchPost: (post: string) => boolean, timeoutMs?: number }} opts
 */
async function captureGraphqlViaNavigation(page, opts) {
  if (typeof page.captureGraphqlResponse === "function") {
    const captured = await page.captureGraphqlResponse(opts);
    if (captured?.requestBody) setIgRelayTemplate(page, captured.requestBody);
    return captured;
  }
  if (typeof page.goto !== "function") return null;

  const timeoutMs = opts.timeoutMs || 25_000;
  return new Promise((resolve, reject) => {
    let requestBody = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("graphql capture timeout"));
    }, timeoutMs);

    const onRequest = (req) => {
      const post = req.postData() || "";
      if (opts.matchPost(post)) requestBody = post;
    };

    const onResponse = async (res) => {
      if (!res.url().includes("/api/graphql") || !requestBody) return;
      try {
        const json = parseIgGraphqlResponseText(await res.text());
        if (requestBody) setIgRelayTemplate(page, requestBody);
        cleanup();
        resolve({ json, requestBody });
      } catch {
        /* wait */
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      page.off("request", onRequest);
      page.off("response", onResponse);
    };

    page.on("request", onRequest);
    page.on("response", onResponse);
    page.goto(opts.navigateUrl, { waitUntil: "commit", timeout: 60_000 }).catch((e) => {
      cleanup();
      reject(e);
    });
  });
}

/**
 * 在浏览器内复用已捕获 relay body 发 GraphQL（保留 __dyn/__csr）
 */
async function igGraphqlFetchWithTemplate(page, payload) {
  const friendlyName = payload.friendlyName || null;
  const template = getIgRelayTemplate(page, friendlyName);
  if (!template) return null;
  const path = payload.path || "/api/graphql";
  const referer =
    payload.referer ||
    (typeof page.url === "function" ? page.url() : "") ||
    "https://www.instagram.com/";

  try {
    const json = await withPageEvaluateLock(page, () =>
      page.evaluate(
        async ({ template, path, docId, friendlyName, variables, referer, reqCounter }) => {
          const params = new URLSearchParams(template);
          params.set("variables", JSON.stringify(variables));
          params.set("doc_id", docId);
          if (friendlyName) params.set("fb_api_req_friendly_name", friendlyName);
          params.set("__req", reqCounter);

          let csrf = null;
          let wwwClaim = null;
          try {
            csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || null;
            wwwClaim = sessionStorage.getItem("wwwClaimV2") || null;
          } catch {
            csrf = null;
            wwwClaim = null;
          }
          const lsd = params.get("lsd") || "";
          const url = `${location.origin}${path.startsWith("/") ? path : `/${path}`}`;
          const headers = {
            "X-CSRFToken": csrf || "",
            "X-IG-App-ID": "936619743392459",
            "X-Requested-With": "XMLHttpRequest",
            "X-ASBD-ID": "359341",
            "X-Instagram-AJAX": "1",
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "*/*",
            Referer: referer,
          };
          if (lsd) headers["X-FB-LSD"] = lsd;
          if (friendlyName) headers["X-FB-Friendly-Name"] = friendlyName;
          if (wwwClaim) headers["X-IG-WWW-Claim"] = wwwClaim;

          const res = await fetch(url, {
            method: "POST",
            headers,
            credentials: "include",
            body: params.toString(),
          });
          const text = await res.text();
          const jsonText = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "");
          if (!res.ok) return { __error: `http_${res.status}`, __preview: jsonText.slice(0, 120) };
          try {
            const parsed = JSON.parse(jsonText);
            if (parsed?.error && !parsed?.data) {
              return {
                __error: `api_${parsed.error}`,
                __preview: parsed.errorDescription || parsed.errorSummary || "",
              };
            }
            return parsed;
          } catch {
            return { __error: "invalid_json", __preview: text.slice(0, 200) };
          }
        },
        {
          template,
          path,
          docId: payload.docId,
          friendlyName,
          variables: payload.variables,
          referer,
          reqCounter: nextRelayReqCounter(page),
        }
      )
    );
    if (!json || json.__error) {
      console.warn(
        `[instagram-direct] graphql(template) ${friendlyName || payload.docId} failed: ${json?.__error || "empty"}${json?.__preview ? ` preview=${json.__preview}` : ""}`
      );
      return null;
    }
    if (process.env.IG_LITE_DEBUG_RELAY === "1") {
      console.log(
        `[instagram-direct] graphql(template) ok ${friendlyName || payload.docId}`
      );
    }
    return json;
  } catch (e) {
    console.warn(`[instagram-direct] graphql(template) evaluate: ${e.message}`);
    return null;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {{ docId: string, friendlyName?: string, variables: object, path?: string }} payload
 */
export async function igGraphqlFetch(page, payload) {
  const friendlyName = payload.friendlyName || null;
  const template = getIgRelayTemplate(page, friendlyName);
  if (template) {
    const viaTemplate = await igGraphqlFetchWithTemplate(page, payload);
    if (viaTemplate) return viaTemplate;
  }

  const bootstrap = await extractIgRelayBootstrap(page);
  if (!bootstrap?.csrf) {
    console.warn("[instagram-direct] 缺少 csrftoken，请确认 9222 Chrome 已登录 Instagram");
    return null;
  }

  const path = payload.path || "/api/graphql";
  const referer = payload.referer || (typeof page.url === "function" ? page.url() : "") || "https://www.instagram.com/";
  const relayTemplate = getIgRelayTemplate(page, friendlyName);
  const body = relayTemplate
    ? buildRelayBodyFromTemplate(
        relayTemplate,
        {
          docId: payload.docId,
          friendlyName,
          variables: payload.variables,
        },
        bootstrap,
        page
      )
    : buildRelayFormBody(bootstrap, {
        docId: payload.docId,
        friendlyName,
        variables: payload.variables,
        referer,
      });

  try {
    const json = await withPageEvaluateLock(page, () =>
      page.evaluate(
        async ({ path, bootstrap, body, friendlyName, referer }) => {
          const url = `${bootstrap.origin}${path.startsWith("/") ? path : `/${path}`}`;
          const headers = {
            "X-CSRFToken": bootstrap.csrf || "",
            "X-IG-App-ID": bootstrap.appId || "",
            "X-Requested-With": "XMLHttpRequest",
            "X-ASBD-ID": "359341",
            "X-Instagram-AJAX": "1",
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "*/*",
            Referer: referer,
          };
          if (bootstrap.lsd) headers["X-FB-LSD"] = bootstrap.lsd;
          if (friendlyName) headers["X-FB-Friendly-Name"] = friendlyName;
          if (bootstrap.wwwClaim) headers["X-IG-WWW-Claim"] = bootstrap.wwwClaim;

          const res = await fetch(url, {
            method: "POST",
            headers,
            credentials: "include",
            body,
          });
          const text = await res.text();
          const jsonText = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "");
          if (!res.ok) return { __error: `http_${res.status}`, __preview: jsonText.slice(0, 120) };
          try {
            const parsed = JSON.parse(jsonText);
            if (parsed?.error && !parsed?.data) {
              return {
                __error: `api_${parsed.error}`,
                __preview: parsed.errorDescription || parsed.errorSummary || "",
              };
            }
            return parsed;
          } catch {
            return { __error: "invalid_json", __preview: text.slice(0, 200) };
          }
        },
        { path, bootstrap, body, friendlyName, referer }
      )
    );
    if (!json || json.__error) {
      console.warn(
        `[instagram-direct] graphql ${friendlyName || payload.docId} failed: ${json?.__error || "empty"}${json?.__preview ? ` preview=${json.__preview}` : ""}`
      );
      return null;
    }
    if (json.status === "fail") {
      console.warn(
        `[instagram-direct] graphql ${friendlyName || payload.docId} api fail: ${json.message || "unknown"}`
      );
      return null;
    }
    return json;
  } catch (e) {
    console.warn(`[instagram-direct] graphql evaluate: ${e.message}`);
    return null;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} pathWithQuery 如 /api/v1/users/web_profile_info/?username=x
 * @param {{ method?: string, body?: string, headers?: object }} [options]
 */
export async function igApiFetch(page, pathWithQuery, options = {}) {
  const creds = await extractIgFetchCredentials(page);
  if (!creds?.csrf) {
    console.warn("[instagram-direct] 缺少 csrftoken，请确认 9222 Chrome 已登录 Instagram");
    return null;
  }

  try {
    const json = await withPageEvaluateLock(page, () =>
      page.evaluate(
        async ({ pathWithQuery, options, creds }) => {
          const url = pathWithQuery.startsWith("http")
            ? pathWithQuery
            : `${creds.origin}${pathWithQuery.startsWith("/") ? "" : "/"}${pathWithQuery}`;
          const headers = {
            "X-CSRFToken": creds.csrf || "",
            "X-IG-App-ID": creds.appId || "",
            "X-Requested-With": "XMLHttpRequest",
            "X-ASBD-ID": "359341",
            "X-Instagram-AJAX": "1",
            Accept: "*/*",
            ...(options.headers || {}),
          };
          const res = await fetch(url, {
            method: options.method || "GET",
            headers,
            credentials: "include",
            body: options.body,
          });
          if (!res.ok) return { __error: `http_${res.status}` };
          try {
            return await res.json();
          } catch {
            return { __error: "invalid_json" };
          }
        },
        { pathWithQuery, options, creds }
      )
    );
    if (!json || json.__error) {
      console.warn(
        `[instagram-direct] ${pathWithQuery.split("?")[0]} failed: ${json?.__error || "empty"}`
      );
      return null;
    }
    if (json.status === "fail") {
      console.warn(
        `[instagram-direct] ${pathWithQuery.split("?")[0]} api fail: ${json.message || "unknown"}`
      );
      return null;
    }
    return json;
  } catch (e) {
    console.warn(`[instagram-direct] fetch evaluate: ${e.message}`);
    return null;
  }
}

function isUsableInstagramPage(page) {
  try {
    if (!page || page.isClosed()) return false;
    const url = String(page.url() || "");
    if (url.startsWith("chrome-error:")) return false;
    return url.includes("instagram.com");
  } catch {
    return false;
  }
}

function rankInstagramPage(page) {
  const url = String(page.url() || "").split("?")[0];
  if (url === "https://www.instagram.com/") return 0;
  if (url.includes("instagram.com")) return 1;
  return 9;
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ forceNewTab?: boolean }} [options]
 */
export async function acquireInstagramApiSession(context, options = {}) {
  const { closeDisposableCdpPage, openCdpTaskPage } = await import("../../../cdp/cdp-tab-utils.js");
  const { acquireInstagramCdpPage } = await import("../../../cdp/cdp-target-page.js");

  const persistent =
    options.persistent !== false &&
    (options.persistent === true ||
      (isLiteScraperMode() &&
        String(process.env.CDP_9222_PERSIST_PLATFORM_TABS ?? "true") !== "false"));

  const candidates = context.pages().filter((p) => {
    try {
      return p && !p.isClosed();
    } catch {
      return false;
    }
  });
  let page = null;
  let pageCreated = false;
  let pageMode = "playwright";

  const preferCdp = process.env.IG_LITE_USE_CDP_PAGE !== "0";

  if (preferCdp) {
    try {
      const cdpSession = await acquireInstagramCdpPage(undefined, {
        forceNew: !!options.forceNewTab,
      });
      page = cdpSession.page;
      pageMode = "cdp";
    } catch (e) {
      console.warn(`[instagram-direct] CDP page attach failed: ${e.message}`);
    }
  }

  if (!page) {
    page = candidates
      .filter(isUsableInstagramPage)
      .sort((a, b) => rankInstagramPage(a) - rankInstagramPage(b))[0];
  }
  if (!page) {
    page = candidates.find((p) => {
      try {
        return p && !p.isClosed() && !String(p.url() || "").startsWith("chrome-error:");
      } catch {
        return false;
      }
    });
  }
  if (!page) {
    page = await openCdpTaskPage(context);
    pageCreated = true;
    pageMode = "playwright";
  }

  const unblock =
    pageMode === "playwright" && typeof page.route === "function"
      ? await attachLiteResourceBlocker(page)
      : async () => {};

  let relayHarvestOff = null;
  if (typeof page.on === "function") {
    const onRelayHarvest = (req) => {
      try {
        const url = req.url?.() || req.url || "";
        const post = req.postData?.() || req.postData || "";
        if (url.includes("/api/graphql") && post.includes("lsd=")) {
          setIgRelayTemplate(page, post);
        }
      } catch {
        /* ignore */
      }
    };
    page.on("request", onRelayHarvest);
    relayHarvestOff = () => {
      try {
        page.off("request", onRelayHarvest);
      } catch {
        /* ignore */
      }
    };
    if (!page._igRelaySessionKey) {
      page._igRelaySessionKey = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
    }
  }

  try {
    const currentUrl = pageMode === "cdp" ? page.url() : String(page.url() || "");
    if (pageMode !== "cdp" && (!currentUrl.includes("instagram.com") || currentUrl.startsWith("chrome-error:"))) {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.goto("https://www.instagram.com/", {
            waitUntil: "commit",
            timeout: 90_000,
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await page.waitForTimeout(1500 + attempt * 1000);
        }
      }
      if (lastErr) throw lastErr;
    }
    await page.waitForTimeout(
      Math.min(Math.max(Number(process.env.IG_LITE_SESSION_SETTLE_MS) || 2000, 800), 8000)
    );
    const creds =
      pageMode === "cdp"
        ? await extractIgFetchCredentials(page)
        : await extractIgFetchCredentials(page);
    if (!creds?.csrf) {
      throw new Error("Instagram csrftoken 未就绪，请确认 9222 Chrome 已登录 Instagram");
    }
    await warmUpIgRelayTemplateIfNeeded(page);
    await ensureIgRelaySessionReady(page);
    if (process.env.IG_LITE_DEBUG_RELAY === "1") {
      console.log(
        `[instagram-direct] session relay template=${getIgRelayTemplate(page) ? "yes" : "no"} mode=${pageMode}`
      );
    }
  } catch (e) {
    relayHarvestOff?.();
    await unblock();
    if (pageCreated) {
      try {
        if (!page.isClosed()) await page.close();
      } catch {
        /* ignore */
      }
    }
    throw e;
  }

  return {
    page,
    pageCreated,
    pageMode,
    persistent,
    hasRelayTemplate: !!getIgRelayTemplate(page),
    async dispose() {
      relayHarvestOff?.();
      await unblock();
      if (persistent) {
        if (pageMode === "cdp" && typeof page?.dispose === "function") {
          try {
            await page.dispose();
          } catch {
            /* ignore */
          }
        } else {
          const { releaseLitePersistentPage } = await import("../../../cdp/cdp-tab-utils.js");
          await releaseLitePersistentPage(page, { persistent: true, platform: "instagram" });
        }
        return;
      }
      await closeDisposableCdpPage(page, { created: pageCreated });
    },
  };
}

function encodeFormBody(params) {
  return new URLSearchParams(params).toString();
}

function extractSearchNextMaxId(json) {
  return (
    json?.media_grid?.next_max_id ??
    json?.next_max_id ??
    json?.data?.search_query?.pagination_token ??
    null
  );
}

function extractReelsMaxId(json) {
  const conn = json?.data?.xdt_api__v1__clips__user__connection_v2;
  const paging = json?.paging_info || conn?.page_info || conn?.paging_info;
  const fromPaging =
    paging?.max_id ??
    json?.max_id ??
    paging?.end_cursor ??
    conn?.page_info?.end_cursor ??
    null;
  if (fromPaging) return String(fromPaging);

  const medias = [];
  const walk = (obj, depth = 0) => {
    if (depth > 14 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, depth + 1));
      return;
    }
    if ((obj.code || obj.shortcode) && (obj.pk || obj.id)) {
      medias.push(obj);
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  walk(json);
  if (!medias.length) return null;
  const pks = medias
    .map((m) => m.pk || m.id)
    .filter(Boolean)
    .map((x) => BigInt(String(x)));
  if (!pks.length) return null;
  return String(pks.reduce((min, pk) => (pk < min ? pk : min)));
}

function extractReelsMoreAvailable(json) {
  const paging = json?.paging_info || json?.data?.xdt_api__v1__clips__user__connection_v2?.page_info;
  if (typeof paging?.more_available === "boolean") return paging.more_available;
  if (typeof paging?.has_next_page === "boolean") return paging.has_next_page;
  return json?.more_available ?? null;
}

/**
 * 关键词搜索首屏（GraphQL）
 * @param {import('playwright').Page} page
 * @param {string} keyword
 * @param {{ nextMaxId?: string|null, sessionId?: string|null }} [options]
 */
export async function fetchKeywordSearchPage(page, keyword, options = {}) {
  const q = String(keyword || "").trim();
  if (!q) return null;
  const sessionId = options.sessionId || (await newIgSessionId(page));
  const variables = {
    query: q,
    search_session_id: sessionId,
    serp_session_id: sessionId,
  };
  if (options.nextMaxId) {
    variables.pagination_token = options.nextMaxId;
  }

  let json = await igGraphqlFetch(page, {
    docId: IG_GQL_SEARCH_DOC_ID,
    friendlyName: IG_GQL_SEARCH_FRIENDLY,
    variables,
    referer: `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`,
  });
  if (json) return json;

  // REST 优先于打开搜索页（更低流量）
  const body = { query: q, search_surface: "keyword_serp" };
  if (options.nextMaxId) body.next_max_id = options.nextMaxId;
  json = await igApiFetch(page, "/api/v1/fbsearch/web/top_serp/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encodeFormBody(body),
  });
  if (json) return json;

  if (!options.skipCapture && !getIgRelayTemplate(page, IG_GQL_SEARCH_FRIENDLY)) {
    try {
      const searchUrl = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`;
      const current = typeof page.url === "function" ? String(page.url() || "") : "";
      const captured = await captureGraphqlViaNavigation(page, {
        navigateUrl: searchUrl,
        matchPost: (post) =>
          post.includes(IG_GQL_SEARCH_FRIENDLY) || post.includes(IG_GQL_SEARCH_DOC_ID),
        forceReload: current.includes("instagram.com/explore/search"),
        timeoutMs: 35_000,
      });
      if (captured?.json) return captured.json;
    } catch (e) {
      console.warn(`[instagram-direct] search navigation capture: ${e.message}`);
    }
  }

  return null;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} keyword
 * @param {{ maxPages?: number, delayMs?: number }} [options]
 */
export async function fetchKeywordSearchAll(page, keyword, options = {}) {
  const maxPages = Math.min(
    Math.max(Number(options.maxPages || process.env.IG_LITE_SEARCH_MAX_PAGES || 8), 1),
    30
  );
  const delayMs = Math.min(
    Math.max(Number(options.delayMs || process.env.IG_LITE_SEARCH_DELAY_MS || 120), 0),
    500
  );
  const batches = [];
  let nextMaxId = null;
  const sessionId = await newIgSessionId(page);

  for (let i = 0; i < maxPages; i++) {
    const json = await fetchKeywordSearchPage(page, keyword, {
      nextMaxId,
      sessionId,
      skipCapture: i > 0,
    });
    if (!json) break;
    batches.push(json);

    const paging = extractSearchNextMaxId(json);
    const hasMore = json?.media_grid?.has_more ?? json?.has_more ?? !!paging;
    if (!hasMore || !paging || paging === nextMaxId) break;
    nextMaxId = String(paging);
    if (delayMs > 0) await page.waitForTimeout(delayMs);
  }

  return batches;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 */
export async function fetchWebProfileInfo(page, username) {
  const handle = String(username || "").replace(/^@/, "").trim();
  if (!handle) return null;
  return igApiFetch(
    page,
    `/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {string} userId
 * @param {{ maxId?: string|null, pageSize?: number }} [options]
 */
async function fetchUserClipsGraphqlPayload(page, userId, options = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const pageSize = Math.min(Math.max(Number(options.pageSize || 24), 6), 24);
  const handle = String(options.username || "").replace(/^@/, "");
  const data = {
    include_feed_video: true,
    page_size: pageSize,
    target_user_id: uid,
  };
  if (options.maxId) data.max_id = String(options.maxId);
  const payload = {
    docId: IG_GQL_REELS_DOC_ID,
    friendlyName: IG_GQL_REELS_FRIENDLY,
    variables: { data },
    referer: handle
      ? `https://www.instagram.com/${handle}/reels/`
      : `https://www.instagram.com/`,
  };

  if (options.maxId && getIgRelayTemplate(page, IG_GQL_REELS_FRIENDLY)) {
    const viaTemplate = await igGraphqlFetchWithTemplate(page, payload);
    if (viaTemplate) return viaTemplate;
  }

  return igGraphqlFetch(page, payload);
}

export async function fetchUserClipsPage(page, userId, options = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const pageSize = Math.min(Math.max(Number(options.pageSize || 24), 6), 24);
  const handle = String(options.username || "").replace(/^@/, "");

  let json = await fetchUserClipsGraphqlPayload(page, uid, options);
  if (json) return json;

  if (!options.skipCapture && handle && !getIgRelayTemplate(page, IG_GQL_REELS_FRIENDLY)) {
    try {
      const reelsUrl = `https://www.instagram.com/${handle}/reels/`;
      const current = typeof page.url === "function" ? String(page.url() || "") : "";
      const captured = await captureGraphqlViaNavigation(page, {
        navigateUrl: reelsUrl,
        matchPost: (post) =>
          post.includes(IG_GQL_REELS_FRIENDLY) || post.includes(IG_GQL_REELS_DOC_ID),
        forceReload: current.includes(`/${handle}/reels`),
        timeoutMs: 35_000,
      });
      if (captured?.json) return captured.json;
    } catch (e) {
      console.warn(`[instagram-direct] reels navigation capture: ${e.message}`);
    }
  }

  const params = new URLSearchParams({
    target_user_id: uid,
    page_size: String(pageSize),
  });
  if (options.maxId) params.set("max_id", String(options.maxId));
  return igApiFetch(page, `/api/v1/clips/user/?${params.toString()}`);
}

/**
 * @param {import('playwright').Page} page
 * @param {string} userId
 * @param {{ maxPages?: number, delayMs?: number, pageSize?: number }} [options]
 */
export async function fetchUserClipsAll(page, userId, options = {}) {
  const maxPages = Math.min(
    Math.max(Number(options.maxPages || process.env.IG_LITE_CLIPS_MAX_PAGES || 8), 1),
    25
  );
  const delayMs = Math.min(
    Math.max(Number(options.delayMs || process.env.IG_LITE_CLIPS_DELAY_MS || 80), 0),
    400
  );
  const { extractReelsPaginationHints, extractClipsMediaFromJson } = await import(
    "./instagram-json-utils.js"
  );
  const batches = [];
  const seenBatchKeys = new Set();
  let maxId = null;
  let stalePages = 0;

  for (let i = 0; i < maxPages; i++) {
    let json = await fetchUserClipsPage(page, userId, {
      maxId,
      pageSize: options.pageSize,
      username: options.username,
      skipCapture: i > 0,
    });

    if (!json && i > 0 && maxId && typeof page.captureGraphqlViaScroll === "function") {
      try {
        const handle = String(options.username || "").replace(/^@/, "");
        const captured = await page.captureGraphqlViaScroll({
          matchPost: (post) =>
            post.includes(IG_GQL_REELS_FRIENDLY) || post.includes(IG_GQL_REELS_DOC_ID),
          matchMaxId: String(maxId),
          timeoutMs: 18_000,
        });
        if (captured?.requestBody) setIgRelayTemplate(page, captured.requestBody);
        json = captured?.json || null;
      } catch (e) {
        console.warn(`[instagram-direct] reels scroll capture page ${i + 1}: ${e.message}`);
      }
    }

    if (!json) break;

    const medias = extractClipsMediaFromJson(json);
    const batchKey = medias
      .map((m) => String(m.pk || m.id || m.code || ""))
      .filter(Boolean)
      .sort()
      .join(",");
    if (batchKey && seenBatchKeys.has(batchKey)) {
      stalePages += 1;
      if (stalePages >= 2) break;
    } else if (batchKey) {
      seenBatchKeys.add(batchKey);
      stalePages = 0;
    }

    batches.push(json);

    const hints = extractReelsPaginationHints(json);
    const paging = json?.paging_info || {};
    const more = extractReelsMoreAvailable(json);
    const next =
      extractReelsMaxId(json) ??
      hints.maxId ??
      paging.max_id ??
      json?.max_id ??
      null;
    const hasMore =
      more === true ||
      (more !== false && next && next !== maxId);
    if (!hasMore || !next || next === maxId) break;
    maxId = String(next);
    if (delayMs > 0) await page.waitForTimeout(delayMs);
  }

  return batches;
}

/**
 * Reels 滚动拦截兜底：对齐 Standard 近 50 条（Lite 在 GraphQL 翻页不足时使用）
 * @param {object} page
 * @param {string} username
 * @param {{ maxReels?: number, scrollRounds?: number, skipGoto?: boolean }} [options]
 */
export async function fetchUserReelsViaScrollCapture(page, username, options = {}) {
  const handle = String(username || "").replace(/^@/, "").trim();
  if (!handle) return [];
  const maxReels = Math.min(
    Math.max(Number(options.maxReels || process.env.IG_REELS_MAX_VIDEOS || 50), 1),
    80
  );
  const scrollRounds = Math.min(
    Math.max(Number(options.scrollRounds || process.env.IG_REELS_SCROLL_ROUNDS || 15), 3),
    40
  );
  const reelsUrl = `https://www.instagram.com/${handle}/reels/`;

  const { extractMediaNodesFromJson, mergeIgReelIntoMap, extractReelsPaginationHints } =
    await import("./instagram-json-utils.js");

  const videoMap = new Map();
  let lastPagination = { moreAvailable: null, maxId: null };

  const ingestText = (text) => {
    if (!text || (text[0] !== "{" && text[0] !== "[")) return;
    try {
      const json = parseIgGraphqlResponseText(text);
      const pageInfo = extractReelsPaginationHints(json);
      if (pageInfo.moreAvailable != null || pageInfo.maxId != null) {
        lastPagination = pageInfo;
      }
      for (const m of extractMediaNodesFromJson(json)) {
        mergeIgReelIntoMap(videoMap, m, handle);
      }
    } catch {
      /* ignore */
    }
  };

  let unwatch = null;
  if (typeof page.watchInstagramApiResponses === "function") {
    unwatch = page.watchInstagramApiResponses((url, text) => {
      if (!String(url).includes("instagram.com")) return;
      if (!url.includes("graphql") && !url.includes("/api/")) return;
      ingestText(text);
    });
  } else if (typeof page.on === "function") {
    const handler = async (response) => {
      const url = response.url();
      if (!url.includes("instagram.com")) return;
      if (!url.includes("/graphql") && !url.includes("/api/")) return;
      try {
        ingestText(await response.text());
      } catch {
        /* ignore */
      }
    };
    page.on("response", handler);
    unwatch = () => page.off("response", handler);
  }

  try {
    const alreadyOnReels =
      options.skipGoto ||
      String(typeof page.url === "function" ? page.url() : "").includes(`/${handle}/reels`);
    if (!alreadyOnReels && typeof page.goto === "function") {
      await page.goto(reelsUrl, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
      await page.waitForTimeout(3000);
    } else {
      await page.waitForTimeout(2000);
    }

    let stale = 0;
    for (let round = 0; round < scrollRounds && videoMap.size < maxReels; round++) {
      const before = videoMap.size;
      await page.evaluate(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
      });
      await page.waitForTimeout(1800);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.85));
      await page.waitForTimeout(1800);
      if (videoMap.size === before) stale += 1;
      else stale = 0;
      if (stale >= 4) break;
      if (lastPagination.moreAvailable === false && videoMap.size === before && round > 3) break;
    }
    await page.waitForTimeout(2500);
  } finally {
    unwatch?.();
  }

  return Array.from(videoMap.values()).slice(0, maxReels);
}

export function resolveLiteIgContinuationConfig() {
  return {
    searchMaxPages: Math.min(
      Math.max(Number(process.env.IG_LITE_SEARCH_MAX_PAGES || 8), 2),
      30
    ),
    clipsMaxPages: Math.min(
      Math.max(Number(process.env.IG_LITE_CLIPS_MAX_PAGES || 8), 2),
      25
    ),
  };
}
