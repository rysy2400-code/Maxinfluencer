/**
 * Instagram API 直调：在已登录的 instagram.com 页面上下文内 fetch，无需打开搜索/主页。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  isLiteScraperMode,
  resolveIgLiteDisableEvaluateLock,
} from "../../../scraper/resolve-scraper-mode.js";
import { normalizeInfluencerCountryToIso } from "../../../influencer/campaign-country-codes.js";
import { parseWbloksAboutCountry } from "./extract-instagram-about-country.js";
import { normalizeInstagramSearchKeyword } from "./normalize-instagram-search-keyword.js";

const BLOCKED_RESOURCE_TYPES = new Set(
  String(process.env.LITE_BLOCK_RESOURCE_TYPES || "image,media,font")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const pageEvaluateChains = new WeakMap();
const requestPacingStates = new WeakMap();
const relayWarmupPromises = new WeakMap();
const aboutCircuitStates = new Map();
/** @type {WeakMap<object, string>} */
const relayTemplateStore = new WeakMap();
/** @type {Map<string, { templates: Map<string, string>, fallback: string|null, reqSeq: number, updatedAt: number }>} */
const relaySessionStore = new Map();
/** @type {WeakMap<object, { url: string, postData: string, headers?: object, updatedAt: number }>} */
const aboutBloksTemplateStore = new WeakMap();
/** @type {Map<string, { url: string, postData: string, headers?: object, updatedAt: number }>} */
const aboutBloksSessionStore = new Map();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ABOUT_BLOKS_TEMPLATE_FILE = path.resolve(
  __dirname,
  "../../../../logs/ig-bloks-about-template.json"
);
// 兜底种子模板：新机器/新 profile 尚未 harvest 到 About Bloks 模板时使用。
// 代码会对 postData 里的 lsd/fb_dtsg 等会话令牌做当前会话刷新，因此种子可跨机器复用。
const ABOUT_BLOKS_TEMPLATE_SEED_FILE = path.resolve(
  __dirname,
  "ig-bloks-about-template.seed.json"
);
const IG_ABOUT_BLOKS_APP_ID = "com.bloks.www.ig.about_this_account";

// ============ IG 页面健康状态（僵尸页自愈） ============
// IG 限流后页面 evaluate 可能永久挂起（"僵尸页面"），页内 AbortController 不再生效。
// 这里用 node 层看门狗检测挂起并标记页面不健康，由上层（enrich 流水线）关闭并重建页面。
const igPageHangState = new WeakMap();

function describeHangingPage(page) {
  try {
    return typeof page?.url === "function" ? String(page.url() || "") : "";
  } catch {
    return "";
  }
}

/**
 * 标记页面发生一次 node 层挂起（watchdog 超时）。
 * @param {object|null|undefined} page
 */
export function markIgPageHang(page) {
  if (!page || (typeof page !== "object" && typeof page !== "function")) return;
  const st = igPageHangState.get(page) || { hangCount: 0, hungAt: 0 };
  st.hangCount += 1;
  st.hungAt = Date.now();
  igPageHangState.set(page, st);
  console.warn(
    `[instagram-direct] ⚠️ IG 页面挂起标记 pageHang#${st.hangCount} url=${describeHangingPage(page)}`
  );
}

/**
 * 页面是否已被判定不健康（一小时内发生过挂起）。上层应重建该页面。
 * @param {object|null|undefined} page
 */
export function isIgPageUnhealthy(page) {
  if (!page || (typeof page !== "object" && typeof page !== "function")) return false;
  const st = igPageHangState.get(page);
  if (!st || st.hangCount <= 0) return false;
  return Date.now() - st.hungAt < 60 * 60 * 1000;
}

/**
 * 清除页面健康标记（仅对新建/已恢复页面使用）。
 * @param {object|null|undefined} page
 */
export function resetIgPageHealth(page) {
  if (!page) return;
  igPageHangState.delete(page);
}

export class IgPageHangError extends Error {
  constructor(message) {
    super(message);
    this.name = "IgPageHangError";
    this.code = "IG_PAGE_HANG";
  }
}

/**
 * node 层看门狗：fn 在 ms 内未 settle 则返回挂起标记（不等待 fn 结束）。
 * 页内 AbortController 在僵尸页下失效，必须由这里兜底。
 */
async function withIgPageWatchdog(ms, fn) {
  let timer = null;
  let settled = false;
  try {
    return await Promise.race([
      (async () => {
        try {
          return await fn();
        } finally {
          settled = true;
        }
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          if (!settled) resolve({ __igPageHang: true });
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ============ IG 账户限流检测（多账户轮换） ============
// 检测到 clips/reels 连续失败、feedback_required、HTTP 429 时，
// 通知轮换模块把当前账户标记冷却，worker 下一任务切到其他账户。
const igClipsFailStreak = new WeakMap();
const igThrottleNotifyAt = new WeakMap();

function isClipsOrReelsRequest(pathOrName) {
  const s = String(pathOrName || "");
  return (
    s.includes("/clips/") ||
    s.includes("/reels/") ||
    s.includes("PolarisProfileReelsTabContentQuery") ||
    s.includes("ClipsUser")
  );
}

function notifyAccountThrottleIfNeeded(page, reason) {
  if (!page || (typeof page !== "object" && typeof page !== "function")) return;
  const now = Date.now();
  const last = igThrottleNotifyAt.get(page) || 0;
  // 同一页面 30 秒内只上报一次，避免 burst 刷状态文件
  if (now - last < 30_000) return;
  igThrottleNotifyAt.set(page, now);
  const endpoint =
    page._igRelaySessionKey ||
    process.env.IG_LITE_ENRICH_CDP_ENDPOINTS ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9222";
  void import("../../../ig-account-rotation.js")
    .then(({ markIgAccountThrottled }) => {
      markIgAccountThrottled(endpoint, reason);
    })
    .catch((e) => {
      console.warn(`[instagram-direct] 标记账户限流失败: ${e?.message || e}`);
    });
}

function noteClipsRequestResult(page, ok, reason) {
  if (!page || (typeof page !== "object" && typeof page !== "function")) return;
  if (ok) {
    igClipsFailStreak.delete(page);
    return;
  }
  const streak = (igClipsFailStreak.get(page) || 0) + 1;
  igClipsFailStreak.set(page, streak);
  const threshold = (() => {
    const n = Number(process.env.IG_ACCOUNT_THROTTLE_400_STREAK);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 20) : 3;
  })();
  if (streak >= threshold) {
    notifyAccountThrottleIfNeeded(page, reason || `clips_fail_x${streak}`);
  }
}

// ============ IG 会话自愈 + 资料端点熔断 ============
// 认证拒绝（Please log in / cannot be displayed / 1357001 / 1357031）表示
// relay viewer/csrf 上下文失效：每页每 5 分钟最多 reload 一次刷新上下文后重试。
const igSessionRepairAt = new WeakMap();
const IG_SESSION_REPAIR_INTERVAL_MS = 5 * 60 * 1000;

function isIgAuthRejection(json) {
  const err = String(json?.__error || "");
  const preview = String(json?.__preview || "");
  return (
    err === "api_1357001" ||
    err === "api_1357031" ||
    /please log in/i.test(preview) ||
    /cannot be displayed/i.test(preview)
  );
}

async function repairIgSessionOnAuthRejection(page) {
  if (!page || (typeof page !== "object" && typeof page !== "function")) return false;
  if (isIgPageUnhealthy(page)) return false;
  const now = Date.now();
  const last = igSessionRepairAt.get(page) || 0;
  if (now - last < IG_SESSION_REPAIR_INTERVAL_MS) return false;
  igSessionRepairAt.set(page, now);
  try {
    if (typeof page.reload === "function") {
      await page
        .reload({ waitUntil: "commit", timeout: 60_000 })
        .catch(async () => {
          try {
            await page.reload({ ignoreCache: true });
          } catch {
            /* ignore */
          }
        });
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
    await page.waitForTimeout(
      Math.min(Math.max(Number(process.env.IG_LITE_SESSION_SETTLE_MS || 2000), 800), 8000)
    );
    console.warn("[instagram-direct] 会话认证被拒，已 reload 刷新 viewer/csrf 上下文");
    return true;
  } catch (e) {
    console.warn(`[instagram-direct] 会话自愈失败: ${e?.message || e}`);
    return false;
  }
}

// web_profile_info 按 IP/账户滑窗限流（实测约 20 次/30-60min）：
// 任务内限量 + 连续失败熔断，命中后跳过该端点，走 users/info / clips 兜底，
// 避免继续加重封锁。generation 机制保证每个任务开始时计数器归零。
let igProfileCircuitGen = 0;
const igWebProfileCircuitState = new WeakMap();

export function resetIgProfileCircuits() {
  igProfileCircuitGen += 1;
}

function igWebProfileCircuitOpen(page) {
  const st = igWebProfileCircuitState.get(page);
  if (!st || st.gen !== igProfileCircuitGen) return false;
  const maxCalls = Math.max(Number(process.env.IG_LITE_WEB_PROFILE_MAX_PER_TASK || 30), 5);
  const streakLimit = Math.max(Number(process.env.IG_LITE_WEB_PROFILE_FAIL_STREAK || 5), 2);
  return st.calls >= maxCalls || st.streak >= streakLimit;
}

function noteIgWebProfileResult(page, ok) {
  if (!page) return;
  let st = igWebProfileCircuitState.get(page);
  if (!st || st.gen !== igProfileCircuitGen) {
    st = { gen: igProfileCircuitGen, calls: 0, streak: 0 };
    igWebProfileCircuitState.set(page, st);
  }
  st.calls += 1;
  if (ok) st.streak = 0;
  else st.streak += 1;
}

function resolveIgRequestDelayRange() {
  const min = Math.max(0, Number(process.env.IG_REQUEST_DELAY_MIN_MS || 0));
  const max = Math.max(min, Number(process.env.IG_REQUEST_DELAY_MAX_MS || min));
  return {
    min: Math.min(Math.floor(min), 60_000),
    max: Math.min(Math.floor(max), 60_000),
  };
}

async function paceInstagramRequest(page) {
  if (!page || (typeof page !== "object" && typeof page !== "function")) return;
  const { min, max } = resolveIgRequestDelayRange();
  if (max <= 0) return;

  let state = requestPacingStates.get(page);
  if (!state) {
    state = { chain: Promise.resolve(), lastStartedAt: 0 };
    requestPacingStates.set(page, state);
  }

  const run = state.chain.catch(() => {}).then(async () => {
    if (state.lastStartedAt > 0) {
      const targetDelay = min + Math.floor(Math.random() * (max - min + 1));
      const waitMs = Math.max(0, state.lastStartedAt + targetDelay - Date.now());
      if (waitMs > 0) {
        if (typeof page.waitForTimeout === "function") await page.waitForTimeout(waitMs);
        else await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    state.lastStartedAt = Date.now();
  });
  state.chain = run;
  await run;
}

function resolveIgRelaySessionKey(page) {
  if (page?._igRelaySessionKey) return page._igRelaySessionKey;
  return process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
}

function resolveIgAboutBloksTemplateFile() {
  const raw = String(process.env.IG_BLOKS_ABOUT_TEMPLATE_FILE || "").trim();
  return raw || DEFAULT_ABOUT_BLOKS_TEMPLATE_FILE;
}

function isAboutBloksUrl(url) {
  const s = String(url || "");
  return s.includes("/async/wbloks/fetch/") && s.includes(`appid=${IG_ABOUT_BLOKS_APP_ID}`);
}

function isUsableAboutBloksTemplate(url, postData) {
  const body = String(postData || "");
  let decoded = body;
  try {
    decoded = decodeURIComponent(body);
  } catch {
    decoded = body;
  }
  let paramsHasTargetUserId = false;
  try {
    const params = new URLSearchParams(body).get("params");
    paramsHasTargetUserId = !!params && String(params).includes("target_user_id");
  } catch {
    paramsHasTargetUserId = false;
  }
  return (
    isAboutBloksUrl(url) &&
    body.includes("fb_dtsg=") &&
    body.includes("lsd=") &&
    body.includes("params=") &&
    (body.includes("target_user_id") ||
      decoded.includes("target_user_id") ||
      paramsHasTargetUserId)
  );
}

function persistIgAboutBloksTemplate(entry) {
  if (process.env.IG_BLOKS_ABOUT_TEMPLATE_PERSIST === "0") return;
  try {
    const file = resolveIgAboutBloksTemplateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          url: entry.url,
          postData: entry.postData,
          headers: entry.headers || {},
          updatedAt: entry.updatedAt || Date.now(),
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {
    /* template cache is opportunistic */
  }
}

function loadIgAboutBloksTemplateFromFile() {
  const readOne = (file) => {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isUsableAboutBloksTemplate(raw?.url, raw?.postData)) return null;
    return {
      url: String(raw.url),
      postData: String(raw.postData),
      headers: raw.headers && typeof raw.headers === "object" ? raw.headers : {},
      updatedAt: Number(raw.updatedAt || 0) || Date.now(),
    };
  };
  try {
    const file = resolveIgAboutBloksTemplateFile();
    const primary = readOne(file);
    if (primary) return primary;
    // 主文件缺失/失效时回退到内置种子模板，并持久化为本地模板文件，便于后续 harvest 覆盖。
    const seed = readOne(ABOUT_BLOKS_TEMPLATE_SEED_FILE);
    if (seed) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          JSON.stringify({ ...seed, updatedAt: Date.now() }, null, 2),
          "utf-8"
        );
      } catch {
        /* 持久化失败不影响使用种子 */
      }
      return seed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {object|null|undefined} page
 * @param {{ url: string, postData: string, headers?: object }} template
 * @param {string} [sessionKey]
 */
export function setIgAboutBloksTemplate(page, template, sessionKey) {
  if (!isUsableAboutBloksTemplate(template?.url, template?.postData)) return false;
  const key = sessionKey || resolveIgRelaySessionKey(page);
  const entry = {
    url: String(template.url),
    postData: String(template.postData),
    headers: template.headers && typeof template.headers === "object" ? template.headers : {},
    updatedAt: Date.now(),
  };
  aboutBloksSessionStore.set(key, entry);
  if (page) {
    aboutBloksTemplateStore.set(page, entry);
    page._igRelaySessionKey = key;
  }
  persistIgAboutBloksTemplate(entry);
  return true;
}

/**
 * @param {object|null|undefined} page
 */
export function getIgAboutBloksTemplate(page) {
  if (page) {
    const local = aboutBloksTemplateStore.get(page);
    if (local) return local;
  }
  const key = resolveIgRelaySessionKey(page);
  const session = aboutBloksSessionStore.get(key);
  if (session) return session;
  const fromFile = loadIgAboutBloksTemplateFromFile();
  if (fromFile) {
    aboutBloksSessionStore.set(key, fromFile);
    if (page) aboutBloksTemplateStore.set(page, fromFile);
    return fromFile;
  }
  return null;
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
async function warmUpIgRelayTemplate(page) {
  if (page?.__httpOnly) return false;
  if (isIgPageUnhealthy(page)) return false;
  if (getIgRelayTemplate(page)) return true;
  if (process.env.IG_LITE_SKIP_RELAY_WARMUP === "1") return false;

  const maxWait = Math.min(
    Math.max(Number(process.env.IG_LITE_RELAY_WARMUP_MS || 4000), 1000),
    25_000
  );
  const step = 400;

  for (let waited = 0; waited < maxWait; waited += step) {
    if (getIgRelayTemplate(page)) return true;
    await page.waitForTimeout(step);
  }

  const noNavigation = ["1", "true", "yes"].includes(
    String(process.env.IG_API_ONLY_NO_NAVIGATION || "").trim().toLowerCase()
  );
  if (noNavigation) return !!getIgRelayTemplate(page);

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

export async function warmUpIgRelayTemplateIfNeeded(page) {
  if (page?.__httpOnly) return false;
  if (isIgPageUnhealthy(page)) return false;
  if (getIgRelayTemplate(page)) return true;
  const pending = relayWarmupPromises.get(page);
  if (pending) return pending;
  const run = warmUpIgRelayTemplate(page);
  relayWarmupPromises.set(page, run);
  try {
    return await run;
  } finally {
    if (relayWarmupPromises.get(page) === run) relayWarmupPromises.delete(page);
  }
}

/**
 * 会话就绪：被动 harvest + reload，必要时用 bootstrap GraphQL 探活（不打开搜索页）
 * @param {object} page
 */
export async function ensureIgRelaySessionReady(page) {
  if (page?.__httpOnly) return false;
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
  if (resolveIgLiteDisableEvaluateLock()) return withPageEvaluateConcurrency(page, fn);
  const prev = pageEvaluateChains.get(page) || Promise.resolve();
  const run = prev.then(() => fn());
  pageEvaluateChains.set(
    page,
    run.catch(() => {}).then(() => undefined)
  );
  return run;
}

const pageEvaluateGates = new WeakMap();

function resolvePageEvaluateConcurrency() {
  const value = Number(process.env.IG_LITE_EVALUATE_CONCURRENCY || 10);
  if (!Number.isFinite(value) || value < 1) return 10;
  return Math.min(Math.floor(value), 50);
}

async function withPageEvaluateConcurrency(page, fn) {
  let gate = pageEvaluateGates.get(page);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    pageEvaluateGates.set(page, gate);
  }
  const limit = resolvePageEvaluateConcurrency();
  if (gate.active >= limit) {
    await new Promise((resolve) => gate.waiters.push(resolve));
  }
  gate.active += 1;
  try {
    return await fn();
  } finally {
    gate.active = Math.max(0, gate.active - 1);
    gate.waiters.shift()?.();
  }
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
      appId: "936619743392459",
      wwwClaim,
      origin: "https://www.instagram.com",
    };
  }
  try {
    return await page.evaluate(() => {
      const cookies = document.cookie || "";
      const csrf = cookies.match(/csrftoken=([^;]+)/)?.[1] || null;
      const appId = "936619743392459";
      const wwwClaim = sessionStorage.getItem("wwwClaimV2") || null;
      return { csrf, appId, wwwClaim, origin: "https://www.instagram.com" };
    });
  } catch {
    try {
      const cookies = await page.context().cookies("https://www.instagram.com");
      const get = (name) => cookies.find((c) => c.name === name)?.value || null;
      return {
        csrf: get("csrftoken"),
        appId: "936619743392459",
        wwwClaim: null,
        origin: "https://www.instagram.com",
      };
    } catch {
      return {
        csrf: null,
        appId: "936619743392459",
        wwwClaim: null,
        origin: "https://www.instagram.com",
      };
    }
  }
}

async function newIgSessionId(page) {
  if (page?.__httpOnly) {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
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
      appId: "936619743392459",
      origin: "https://www.instagram.com",
      ...htmlBoot,
    };
  }
  try {
    return await page.evaluate(() => {
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
        appId: "936619743392459",
        origin: "https://www.instagram.com",
      };
    });
  } catch {
    try {
      const cookies = await page.context().cookies("https://www.instagram.com");
      const get = (name) => cookies.find((c) => c.name === name)?.value || null;
      return {
        csrf: get("csrftoken"),
        av: get("ds_user_id"),
        wwwClaim: null,
        appId: "936619743392459",
        origin: "https://www.instagram.com",
      };
    } catch {
      return {
        csrf: null,
        av: null,
        wwwClaim: null,
        appId: "936619743392459",
        origin: "https://www.instagram.com",
      };
    }
  }
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
const IG_GQL_SEARCH_PAGINATION_DOC_ID =
  process.env.IG_GQL_SEARCH_PAGINATION_DOC_ID || "27606696395582173";
const IG_GQL_SEARCH_PAGINATION_FRIENDLY =
  process.env.IG_GQL_SEARCH_PAGINATION_FRIENDLY ||
  "PolarisKeywordSearchExplorePageRelayPaginationQuery";
const IG_GQL_REELS_DOC_ID =
  process.env.IG_GQL_REELS_DOC_ID || "28096073060084187";
const IG_GQL_REELS_FRIENDLY =
  process.env.IG_GQL_REELS_FRIENDLY || "PolarisProfileReelsTabContentQuery";
const IG_GQL_PROFILE_DOC_ID =
  process.env.IG_GQL_PROFILE_DOC_ID || "26672929172408668";
const IG_GQL_PROFILE_FRIENDLY =
  process.env.IG_GQL_PROFILE_FRIENDLY || "PolarisProfilePageContentQuery";
const IG_GQL_REELS_PATHS = String(
  process.env.IG_GQL_REELS_PATHS || "/graphql/query,/api/graphql"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
      if (
        !(
          res.url().includes("/api/graphql") ||
          res.url().includes("/graphql/query")
        ) ||
        !requestBody
      ) {
        return;
      }
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
        async ({ template, path, docId, friendlyName, variables, referer, reqCounter, rootField }) => {
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
          if (rootField) headers["X-Root-Field-Name"] = rootField;
          headers["X-IG-Max-Touch-Points"] = "0";
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
          rootField: payload.rootField || null,
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
  await paceInstagramRequest(page);
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
        async ({ path, bootstrap, body, friendlyName, referer, rootField }) => {
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
          if (rootField) headers["X-Root-Field-Name"] = rootField;
          headers["X-IG-Max-Touch-Points"] = "0";
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
        { path, bootstrap, body, friendlyName, referer, rootField: payload.rootField || null }
      )
    );
    if (!json || json.__error) {
      console.warn(
        `[instagram-direct] graphql ${friendlyName || payload.docId} failed: ${json?.__error || "empty"}${json?.__preview ? ` preview=${json.__preview}` : ""}`
      );
      const gqlErr = String(json?.__error || "empty");
      const gqlPreview = String(json?.__preview || "");
      if (gqlErr === "http_429" || gqlPreview.includes("feedback_required")) {
        notifyAccountThrottleIfNeeded(
          page,
          gqlErr === "http_429" ? "graphql_http_429" : "graphql_feedback_required"
        );
      } else if (isClipsOrReelsRequest(friendlyName || payload.docId)) {
        noteClipsRequestResult(page, false, gqlErr);
      }
      return null;
    }
    if (json.status === "fail") {
      console.warn(
        `[instagram-direct] graphql ${friendlyName || payload.docId} api fail: ${json.message || "unknown"}`
      );
      const gqlMsg = String(json.message || "");
      if (gqlMsg.includes("feedback_required")) {
        notifyAccountThrottleIfNeeded(page, "graphql_feedback_required");
      } else if (isClipsOrReelsRequest(friendlyName || payload.docId)) {
        noteClipsRequestResult(page, false, "api_fail");
      }
      return null;
    }
    if (isClipsOrReelsRequest(friendlyName || payload.docId)) noteClipsRequestResult(page, true);
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
  // 页面已被判定不健康时直接快速失败，避免继续等僵尸页。
  if (isIgPageUnhealthy(page)) {
    throw new IgPageHangError(`IG page marked unhealthy, skip request: ${pathWithQuery}`);
  }
  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs || process.env.IG_API_FETCH_TIMEOUT_MS || 12_000), 1000),
    60_000
  );
  // node 层看门狗：比页内超时略长；僵尸页下页内 abort 失效，由这里兜底。
  const watchdogMs = Math.min(Math.max(timeoutMs + 3000, 12_000), 60_000);
  const outcome = await withIgPageWatchdog(watchdogMs, () =>
    igApiFetchInner(page, pathWithQuery, options, timeoutMs)
  );
  if (outcome && outcome.__igPageHang) {
    markIgPageHang(page);
    throw new IgPageHangError(
      `igApiFetch hung > ${watchdogMs}ms (page zombie): ${String(pathWithQuery || "").split("?")[0]}`
    );
  }
  return outcome;
}

async function igApiFetchInner(page, pathWithQuery, options, timeoutMs) {
  await paceInstagramRequest(page);
  const creds = await extractIgFetchCredentials(page);
  if (!creds?.csrf) {
    console.warn("[instagram-direct] 缺少 csrftoken，请确认 9222 Chrome 已登录 Instagram");
    return null;
  }
  const referer =
    options.referer ||
    (typeof page.url === "function" ? String(page.url() || "") : "") ||
    "https://www.instagram.com/";

  if (page?.__httpOnly && typeof page.getInstagramCookies === "function") {
    try {
      const cookieMap = await page.getInstagramCookies();
      const cookieHeader = Object.entries(cookieMap || {})
        .filter(([, value]) => value != null && value !== "")
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
      const url = pathWithQuery.startsWith("http")
        ? pathWithQuery
        : `${creds.origin}${pathWithQuery.startsWith("/") ? "" : "/"}${pathWithQuery}`;
      const headers = {
        Cookie: cookieHeader,
        "User-Agent":
          process.env.IG_HTTP_USER_AGENT ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "X-CSRFToken": creds.csrf || "",
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
        "X-ASBD-ID": "359341",
        "X-Instagram-AJAX": "1",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        Accept: "*/*",
        Referer: referer,
        ...(options.headers || {}),
      };
      if (options.body && !headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
      if (creds.wwwClaim) headers["X-IG-WWW-Claim"] = creds.wwwClaim;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          method: options.method || "GET",
          headers,
          body: options.body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      const jsonText = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "");
      if (!res.ok) {
        console.warn(`[instagram-direct] api ${pathWithQuery} failed: http_${res.status}`);
        if (res.status === 429) {
          notifyAccountThrottleIfNeeded(page, "api_http_429");
        } else if (isClipsOrReelsRequest(pathWithQuery)) {
          noteClipsRequestResult(page, false, `api_http_${res.status}`);
        }
        return null;
      }
      if (isClipsOrReelsRequest(pathWithQuery)) noteClipsRequestResult(page, true);
      try {
        return JSON.parse(jsonText);
      } catch {
        console.warn(`[instagram-direct] api ${pathWithQuery} failed: invalid_json`);
        return null;
      }
    } catch (e) {
      console.warn(
        `[instagram-direct] api ${pathWithQuery} http-only fetch failed: ${e?.message || e}`
      );
      return null;
    }
  }

  try {
    const json = await withPageEvaluateLock(page, () =>
      page.evaluate(
        async ({ pathWithQuery, options, creds, referer, timeoutMs }) => {
          const url = pathWithQuery.startsWith("http")
            ? pathWithQuery
            : `${creds.origin}${pathWithQuery.startsWith("/") ? "" : "/"}${pathWithQuery}`;
          const headers = {
            "X-CSRFToken": creds.csrf || "",
            "X-IG-App-ID": "936619743392459",
            "X-Requested-With": "XMLHttpRequest",
            "X-ASBD-ID": "359341",
            "X-Instagram-AJAX": "1",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            Accept: "*/*",
            Referer: referer,
            ...(options.headers || {}),
          };
          if (creds.wwwClaim) headers["X-IG-WWW-Claim"] = creds.wwwClaim;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let res;
          try {
            res = await fetch(url, {
              method: options.method || "GET",
              headers,
              credentials: "include",
              body: options.body,
              signal: controller.signal,
            });
          } catch (e) {
            return { __error: e?.name === "AbortError" ? "timeout" : e?.message || "fetch_failed" };
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) return { __error: `http_${res.status}` };
          try {
            return await res.json();
          } catch {
            return { __error: "invalid_json" };
          }
        },
        { pathWithQuery, options, creds, referer, timeoutMs }
      )
    );
    if (!json || json.__error) {
      console.warn(
        `[instagram-direct] ${pathWithQuery.split("?")[0]} failed: ${json?.__error || "empty"}`
      );
      if (json?.__error === "http_429") {
        notifyAccountThrottleIfNeeded(page, "api_http_429");
      } else if (isClipsOrReelsRequest(pathWithQuery)) {
        noteClipsRequestResult(page, false, json?.__error || "empty");
      }
      return null;
    }
    if (json.status === "fail") {
      console.warn(
        `[instagram-direct] ${pathWithQuery.split("?")[0]} api fail: ${json.message || "unknown"}`
      );
      const msg = String(json.message || "");
      if (msg.includes("feedback_required")) {
        notifyAccountThrottleIfNeeded(page, "api_feedback_required");
      } else if (isClipsOrReelsRequest(pathWithQuery)) {
        noteClipsRequestResult(page, false, "api_fail");
      }
      return null;
    }
    if (isClipsOrReelsRequest(pathWithQuery)) noteClipsRequestResult(page, true);
    return json;
  } catch (e) {
    console.warn(`[instagram-direct] fetch evaluate: ${e.message}`);
    return null;
  }
}

/**
 * Bloks About this account 直调。无模板时不触发 UI，不打开 About，直接返回 country_unknown。
 * @param {import('playwright').Page} page
 * @param {string} userId
 * @param {{ username?: string }} [options]
 */
function igAboutBloksHangResult(page) {
  return {
    success: false,
    accountCountry: null,
    accountCountryRaw: null,
    accountCountryIso: null,
    videoPublishCountry: null,
    source: null,
    error: "ig_page_hang",
    templateAvailable: !!getIgAboutBloksTemplate(page),
  };
}

async function fetchIgAboutCountryBloksRaw(page, userId, options = {}) {
  if (isIgPageUnhealthy(page)) {
    return igAboutBloksHangResult(page);
  }
  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs || process.env.IG_API_FETCH_TIMEOUT_MS || 12_000), 1000),
    60_000
  );
  const watchdogMs = Math.min(Math.max(timeoutMs + 3000, 12_000), 60_000);
  const outcome = await withIgPageWatchdog(watchdogMs, () =>
    fetchIgAboutCountryBloksRawInner(page, userId, options)
  );
  if (outcome && outcome.__igPageHang) {
    markIgPageHang(page);
    return igAboutBloksHangResult(page);
  }
  return outcome;
}

async function fetchIgAboutCountryBloksRawInner(page, userId, options = {}) {
  await paceInstagramRequest(page);
  const uid = String(userId || "").trim();
  if (!uid) {
    return {
      success: false,
      accountCountry: null,
      accountCountryRaw: null,
      accountCountryIso: null,
      videoPublishCountry: null,
      source: null,
      error: "missing_user_id",
      templateAvailable: !!getIgAboutBloksTemplate(page),
    };
  }

  const template = getIgAboutBloksTemplate(page);
  if (!template) {
    return {
      success: false,
      accountCountry: null,
      accountCountryRaw: null,
      accountCountryIso: null,
      videoPublishCountry: null,
      source: null,
      error: "about_bloks_template_missing",
      templateAvailable: false,
    };
  }

  const handle = String(options.username || "").replace(/^@/, "").trim();
  const referer = handle
    ? `https://www.instagram.com/${encodeURIComponent(handle)}/`
    : "https://www.instagram.com/";
  const bodyParams = new URLSearchParams(template.postData);
  // Bloks templates contain short-lived page tokens. Refresh them from the
  // current Instagram document before every parallel request.
  let bootstrap = null;
  try {
    bootstrap = await extractIgRelayBootstrap(page);
  } catch {
    bootstrap = null;
  }
  for (const key of ["lsd", "fb_dtsg", "jazoest", "__rev", "__hsi", "__dyn", "__csr"]) {
    const value = key === "fb_dtsg" ? bootstrap?.dtsg : bootstrap?.[key];
    if (value) bodyParams.set(key, String(value));
  }
  bodyParams.set(
    "params",
    JSON.stringify({ referer_type: "ProfileMore", target_user_id: uid })
  );
  bodyParams.set("__req", nextRelayReqCounter(page));

  try {
    const result = await withPageEvaluateLock(page, () =>
      page.evaluate(
        async ({ url, body, templateHeaders, referer }) => {
          const headers = {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Accept: "*/*",
            Referer: referer,
          };
          try {
            const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || "";
            if (csrf) headers["X-CSRFToken"] = csrf;
          } catch {
            /* ignore */
          }
          const res = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers,
            body,
          });
          const text = await res.text();
          return {
            ok: res.ok,
            status: res.status,
            text,
            textPreview: text.slice(0, 240),
          };
        },
        {
          url: template.url,
          body: bodyParams.toString(),
          referer,
        }
      )
    );

    if (!result?.ok) {
      return {
        success: false,
        accountCountry: null,
        accountCountryRaw: null,
        accountCountryIso: null,
        videoPublishCountry: null,
        source: null,
        error: `about_bloks_http_${result?.status || "unknown"}`,
        templateAvailable: true,
      };
    }

    const accountCountryRaw = parseWbloksAboutCountry(result.text);
    const accountCountryIso = normalizeInfluencerCountryToIso(accountCountryRaw);
    return {
      // A valid HTTP/JSON response with no country is still a successful
      // About lookup; Instagram legitimately omits this field for many users.
      success: true,
      accountCountry: accountCountryRaw || null,
      accountCountryRaw: accountCountryRaw || null,
      accountCountryIso,
      videoPublishCountry: accountCountryIso,
      source: accountCountryIso ? "bloks_about_api" : null,
      error: null,
      templateAvailable: true,
    };
  } catch (e) {
    return {
      success: false,
      accountCountry: null,
      accountCountryRaw: null,
      accountCountryIso: null,
      videoPublishCountry: null,
      source: null,
      error: e?.message || "about_bloks_fetch_failed",
      templateAvailable: true,
    };
  }
}

function aboutCircuitConfig(options = {}) {
  return {
    threshold: Math.min(
      Math.max(Number(process.env.IG_ABOUT_429_CIRCUIT_THRESHOLD || 5), 5),
      10
    ),
    probeSize: Math.min(
      Math.max(Number(process.env.IG_ABOUT_429_PROBE_SIZE || 10), 5),
      20
    ),
    concurrency: Math.min(
      Math.max(
        Number(options.aboutConcurrency || process.env.IG_ABOUT_CONCURRENCY || 100),
        1
      ),
      500
    ),
  };
}

function getAboutCircuitState(taskId) {
  const key = String(taskId || "").trim();
  if (!key) return null;
  let state = aboutCircuitStates.get(key);
  if (!state) {
    state = {
      key,
      active: 0,
      consecutive429: 0,
      probeCompleted: 0,
      probeAdmitted: 0,
      probe429: 0,
      probeHealthy: false,
      open: false,
      waiters: [],
    };
    aboutCircuitStates.set(key, state);
  }
  return state;
}

function aboutCircuitOpenResult(state) {
  return {
    success: false,
    accountCountry: null,
    accountCountryRaw: null,
    accountCountryIso: null,
    videoPublishCountry: null,
    source: null,
    error: "about_bloks_circuit_open",
    templateAvailable: true,
    circuitOpen: true,
    consecutive429: state?.consecutive429 || 0,
  };
}

function aboutCircuitLimit(state, config) {
  return state.probeHealthy ? config.concurrency : config.probeSize;
}

function wakeAboutCircuitWaiters(state, config) {
  if (!state.probeHealthy && state.probeAdmitted >= config.probeSize && !state.open) {
    return;
  }
  const limit = aboutCircuitLimit(state, config);
  while (!state.open && state.active < limit && state.waiters.length) {
    state.active += 1;
    state.waiters.shift()(true);
  }
  if (state.open && state.waiters.length) {
    for (const wake of state.waiters.splice(0)) wake(false);
  }
}

async function acquireAboutCircuitSlot(state, config) {
  if (!state || state.open) return false;
  if (!state.probeHealthy && state.probeAdmitted >= config.probeSize) {
    return new Promise((resolve) => state.waiters.push(resolve));
  }
  if (state.active < aboutCircuitLimit(state, config)) {
    state.active += 1;
    if (!state.probeHealthy) state.probeAdmitted += 1;
    return true;
  }
  return new Promise((resolve) => state.waiters.push(resolve));
}

/**
 * Task-scoped About circuit breaker. A new taskId always starts closed.
 * Accounts skipped by an open circuit fall through to the bio-language gate.
 */
export async function fetchIgAboutCountryBloks(page, userId, options = {}) {
  const state = getAboutCircuitState(options.taskId || options.circuitKey);
  if (!state) return fetchIgAboutCountryBloksRaw(page, userId, options);
  const config = aboutCircuitConfig(options);
  const { threshold } = config;
  const acquired = await acquireAboutCircuitSlot(state, config);
  if (!acquired || state.open) return aboutCircuitOpenResult(state);

  try {
    const result = await fetchIgAboutCountryBloksRaw(page, userId, options);
    if (!state.probeHealthy) {
      state.probeCompleted += 1;
      if (result?.error === "about_bloks_http_429") state.probe429 += 1;
      if (state.probeCompleted >= config.probeSize) {
        if (state.probe429 >= threshold) {
          state.open = true;
          console.warn(
            `[instagram-direct] About probe circuit open task=${state.key} ` +
              `429=${state.probe429}/${state.probeCompleted}`
          );
        } else {
          state.probeHealthy = true;
          console.log(
            `[instagram-direct] About probe healthy task=${state.key} ` +
              `429=${state.probe429}/${state.probeCompleted} concurrency=${config.concurrency}`
          );
        }
      }
    }
    if (result?.error === "about_bloks_http_429") {
      state.consecutive429 += 1;
      if (state.probeHealthy && state.consecutive429 >= threshold) {
        state.open = true;
        console.warn(
          `[instagram-direct] About 429 circuit open task=${state.key} ` +
            `consecutive=${state.consecutive429} threshold=${threshold}`
        );
      }
    } else {
      state.consecutive429 = 0;
    }
    return {
      ...result,
      circuitOpen: state.open,
      consecutive429: state.consecutive429,
    };
  } finally {
    state.active = Math.max(0, state.active - 1);
    wakeAboutCircuitWaiters(state, config);
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
 * @param {{ forceNewTab?: boolean, targetId?: string, endpointKey?: string }} [options]
 */
export async function acquireInstagramApiSession(context, options = {}) {
  const { closeDisposableCdpPage, openCdpTaskPage } = await import("../../../cdp/cdp-tab-utils.js");
  const { acquireInstagramCdpPage } = await import("../../../cdp/cdp-target-page.js");
  const noNavigation =
    ["1", "true", "yes"].includes(
      String(process.env.IG_API_ONLY_NO_NAVIGATION || "").trim().toLowerCase()
    );

  const persistent =
    options.persistent !== false &&
    (options.persistent === true ||
      (isLiteScraperMode() &&
        String(process.env.CDP_9222_PERSIST_PLATFORM_TABS ?? "true") !== "false"));

  const candidates =
    context && typeof context.pages === "function"
      ? context.pages().filter((p) => {
          try {
            return p && !p.isClosed();
          } catch {
            return false;
          }
        })
      : [];
  let page = null;
  let pageCreated = false;
  let pageMode = "playwright";

  const preferCdp = process.env.IG_LITE_USE_CDP_PAGE !== "0";

  if (preferCdp) {
    try {
      const endpointKey =
        options.endpointKey ||
        process.env.IG_LITE_ENRICH_CDP ||
        process.env.CDP_ENDPOINT ||
        "http://127.0.0.1:9222";
      const cdpSession = await acquireInstagramCdpPage(endpointKey, {
        forceNew: !!options.forceNewTab,
        targetId: options.targetId || null,
      });
      page = cdpSession.page;
      page._igRelaySessionKey = endpointKey;
      if (cdpSession.target?.id) page._igCdpTargetId = cdpSession.target.id;
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
  if (!page && noNavigation) {
    throw new Error(
      "IG_API_ONLY_NO_NAVIGATION=1: no existing Instagram API page; refusing to create a task page"
    );
  }
  if (!page) {
    if (!context || typeof context.pages !== "function") {
      throw new Error(
        "Instagram API session requires an existing CDP target or a Playwright context"
      );
    }
    page = await openCdpTaskPage(context);
    pageCreated = true;
    pageMode = "playwright";
  }

  const unblock =
    BLOCKED_RESOURCE_TYPES.size > 0
      ? typeof page.route === "function"
        ? await attachLiteResourceBlocker(page)
        : typeof page.enableLiteResourceBlocker === "function"
          ? await page.enableLiteResourceBlocker([...BLOCKED_RESOURCE_TYPES])
          : async () => {}
      : async () => {};

  let relayHarvestOff = null;
  if (typeof page.on === "function") {
    const onRelayHarvest = (req) => {
      try {
        const url = req.url?.() || req.url || "";
        const post = req.postData?.() || req.postData || "";
        if (
          (url.includes("/api/graphql") || url.includes("/graphql/query")) &&
          post.includes("lsd=")
        ) {
          setIgRelayTemplate(page, post);
        }
        if (isUsableAboutBloksTemplate(url, post)) {
          const headers =
            typeof req.headers === "function" ? req.headers() : req.headers || {};
          setIgAboutBloksTemplate(page, { url, postData: post, headers });
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
      page._igRelaySessionKey =
        options.endpointKey ||
        process.env.IG_LITE_ENRICH_CDP ||
        process.env.CDP_ENDPOINT ||
        "http://127.0.0.1:9222";
    }
  }

  try {
    const currentUrl = pageMode === "cdp" ? page.url() : String(page.url() || "");
    if (pageMode !== "cdp" && (!currentUrl.includes("instagram.com") || currentUrl.startsWith("chrome-error:"))) {
      if (noNavigation) {
        throw new Error(
          "IG_API_ONLY_NO_NAVIGATION=1: existing page is not Instagram; refusing page.goto"
        );
      }
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
    const relayReady = await ensureIgRelaySessionReady(page);
    const requireRelay =
      process.env.IG_LITE_REQUIRE_RELAY_SESSION !== "0" && isLiteScraperMode();
    if (requireRelay && !relayReady) {
      throw new Error(
        "Instagram API session unavailable: login expired, challenged, or relay probe rejected"
      );
    }
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

function extractSearchPaginationHints(json) {
  const pageInfo =
    json?.data?.xdt_fbsearch__top_serp_graphql?.page_info ||
    json?.data?.search_query?.page_info ||
    json?.media_grid?.page_info ||
    json?.page_info ||
    null;
  const cursor =
    pageInfo?.end_cursor ??
    pageInfo?.max_id ??
    json?.media_grid?.next_max_id ??
    json?.next_max_id ??
    json?.data?.search_query?.pagination_token ??
    null;

  let hasMore = null;
  if (typeof pageInfo?.has_next_page === "boolean") {
    hasMore = pageInfo.has_next_page;
  } else if (typeof pageInfo?.more_available === "boolean") {
    hasMore = pageInfo.more_available;
  } else if (typeof json?.media_grid?.has_more === "boolean") {
    hasMore = json.media_grid.has_more;
  } else if (typeof json?.has_more === "boolean") {
    hasMore = json.has_more;
  }

  return {
    cursor: cursor == null ? null : String(cursor),
    hasMore: hasMore == null ? !!cursor : hasMore,
  };
}

function extractReelsMaxId(json) {
  const conn =
    json?.data?.xdt_api__v1__clips__user__connection_v2 ||
    json?.data?.fetch__XDTUserDict?.clips_connection;
  const paging = json?.paging_info || conn?.page_info || conn?.paging_info;
  const fromPaging =
    paging?.max_id ??
    json?.max_id ??
    paging?.end_cursor ??
    conn?.page_info?.end_cursor ??
    conn?.cursor ??
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
  const paging =
    json?.paging_info ||
    json?.data?.xdt_api__v1__clips__user__connection_v2?.page_info ||
    json?.data?.fetch__XDTUserDict?.clips_connection?.page_info;
  if (typeof paging?.more_available === "boolean") return paging.more_available;
  if (typeof paging?.has_next_page === "boolean") return paging.has_next_page;
  return json?.more_available ?? null;
}

/**
 * 关键词搜索 API 全挂时的 hashtag 兜底：tag web_info / feed tag（纯 API，不导航）。
 * 返回结构与搜索批次一致（media 节点可被 extractMediaNodesFromJson 消费）。
 * @param {import('playwright').Page} page
 * @param {string} keyword
 */
export async function fetchKeywordSearchTagFallback(page, keyword) {
  const tag = String(keyword || "").replace(/^#/, "").trim();
  if (!tag) return null;
  const referer = `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;
  const candidates = [
    `/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`,
    `/api/v1/feed/tag/${encodeURIComponent(tag)}/`,
  ];
  for (const path of candidates) {
    const json = await igApiFetch(page, path, {
      referer,
      headers: { Referer: referer },
    });
    if (json && !json.__error) {
      console.log(
        `[instagram-direct] 搜索 API 兜底成功（${path.split("?")[0]}）: query=${keyword}`
      );
      return json;
    }
  }
  return null;
}

/**
 * 关键词搜索首屏（GraphQL）
 * @param {import('playwright').Page} page
 * @param {string} keyword
 * @param {{ nextMaxId?: string|null, sessionId?: string|null }} [options]
 */
export async function fetchKeywordSearchPage(page, keyword, options = {}) {
  const q = normalizeInstagramSearchKeyword(keyword);
  if (!q) return null;
  const sessionId = options.sessionId || (await newIgSessionId(page));
  const isPagination = !!options.nextMaxId;
  const variables = {
    query: q,
    search_session_id: sessionId,
    serp_session_id: sessionId,
  };
  if (isPagination) {
    variables.after = String(options.nextMaxId);
    variables.first = Math.min(
      Math.max(Number(options.pageSize || process.env.IG_LITE_SEARCH_PAGE_SIZE || 50), 1),
      50
    );
  }

  let graphqlJson = await igGraphqlFetch(page, {
    docId: isPagination
      ? IG_GQL_SEARCH_PAGINATION_DOC_ID
      : IG_GQL_SEARCH_DOC_ID,
    friendlyName: isPagination
      ? IG_GQL_SEARCH_PAGINATION_FRIENDLY
      : IG_GQL_SEARCH_FRIENDLY,
    variables,
    referer: `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`,
  });
  if (graphqlJson) return graphqlJson;

  // REST 优先于打开搜索页（更低流量）
  const body = { query: q, search_surface: "keyword_serp" };
  if (options.nextMaxId) body.next_max_id = options.nextMaxId;
  let json = await igApiFetch(page, "/api/v1/fbsearch/web/top_serp/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encodeFormBody(body),
  });
  if (json) return json;

  // GraphQL + REST 双失败时先 reload 修复会话（5 分钟/页保护），再各重试一次。
  // igGraphqlFetch 失败返回 null（错误对象内部吞掉），因此按双失败判定。
  if (!graphqlJson && !json) {
    const repaired = await repairIgSessionOnAuthRejection(page);
    if (repaired) {
      graphqlJson = await igGraphqlFetch(page, {
        docId: isPagination
          ? IG_GQL_SEARCH_PAGINATION_DOC_ID
          : IG_GQL_SEARCH_DOC_ID,
        friendlyName: isPagination
          ? IG_GQL_SEARCH_PAGINATION_FRIENDLY
          : IG_GQL_SEARCH_FRIENDLY,
        variables,
        referer: `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`,
      });
      if (graphqlJson) return graphqlJson;
      json = await igApiFetch(page, "/api/v1/fbsearch/web/top_serp/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeFormBody(body),
      });
      if (json) return json;
    }
  }

  // hashtag 关键词：GraphQL + top_serp 全挂时，用 tag web_info / feed 兜底（仍纯 API，不导航）
  if (!json && /^#/.test(q) && !isPagination) {
    const tagJson = await fetchKeywordSearchTagFallback(page, q);
    if (tagJson) return tagJson;
  }

  if (!isLiteScraperMode() && !options.skipCapture && !getIgRelayTemplate(page, IG_GQL_SEARCH_FRIENDLY)) {
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
  } else if (isLiteScraperMode() && !json) {
    console.warn(
      `[instagram-direct] Lite 搜索 API 失败（GraphQL+REST），不打开搜索页: query=${q}`
    );
  }

  return null;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} keyword
 * @param {{ maxPages?: number, delayMs?: number, onBatch?: Function }} [options]
 */
export async function fetchKeywordSearchAll(page, keyword, options = {}) {
  const maxPages = Math.min(
    Math.max(Number(options.maxPages || process.env.IG_LITE_SEARCH_MAX_PAGES || 8), 1),
    60
  );
  const delayMs = Math.min(
    Math.max(Number(options.delayMs ?? process.env.IG_LITE_SEARCH_DELAY_MS ?? 0), 0),
    500
  );
  const batches = [];
  let nextMaxId = null;
  const sessionId = await newIgSessionId(page);

  for (let i = 0; i < maxPages; i++) {
    const startedAt = Date.now();
    const json = await fetchKeywordSearchPage(page, keyword, {
      nextMaxId,
      sessionId,
      skipCapture: i > 0,
    });
    if (!json) break;
    batches.push(json);

    const paging = extractSearchPaginationHints(json);
    const shouldContinue =
      typeof options.onBatch === "function"
        ? await options.onBatch(json, {
            pageIndex: i,
            pageNumber: i + 1,
            durationMs: Date.now() - startedAt,
            cursor: paging.cursor,
            hasMore: paging.hasMore,
          })
        : true;
    if (shouldContinue === false) break;

    if (
      !paging.hasMore ||
      !paging.cursor ||
      paging.cursor === nextMaxId
    ) {
      break;
    }
    nextMaxId = paging.cursor;
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
  if (igWebProfileCircuitOpen(page)) {
    console.warn(
      `[instagram-direct] web_profile_info 熔断（任务内限量/连续失败），跳过，走 users/info 或 clips 兜底: @${handle}`
    );
    return null;
  }
  const referer = `https://www.instagram.com/${handle}/`;
  if (!isLiteScraperMode()) {
    try {
      const current = typeof page.url === "function" ? String(page.url() || "") : "";
      if (!current.includes(`instagram.com/${handle}`) && typeof page.goto === "function") {
        await page
          .goto(referer, { waitUntil: "commit", timeout: 60_000 })
          .catch(() => {});
        await page.waitForTimeout(1200);
      }
    } catch {
      /* ignore */
    }
  }
  const result = await igApiFetch(
    page,
    `/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
    { referer, headers: { Referer: referer } }
  );
  noteIgWebProfileResult(page, !!result && !result.__error);
  return result;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} userId
 * @param {{ username?: string }} [options]
 */
export async function fetchUserInfoById(page, userId, options = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const handle = String(options.username || "").replace(/^@/, "").trim();
  const referer = handle
    ? `https://www.instagram.com/${encodeURIComponent(handle)}/`
    : "https://www.instagram.com/";
  return igApiFetch(page, `/api/v1/users/${encodeURIComponent(uid)}/info/`, {
    referer,
    headers: { Referer: referer },
  });
}

/**
 * API-only username -> user pk 解析（IG 名单导入用）。
 * web_profile_info 被 Instagram feedback_required 拦截时，
 * /web/search/topsearch/ 仍可精确命中 username 并返回 pk；
 * 不导航页面、单个 GET，拿到 pk 后由 users/info + clips 兜底补资料。
 */
export async function resolveIgUserPkByUsername(page, username) {
  const handle = String(username || "").replace(/^@/, "").trim();
  if (!handle) return null;
  const json = await igApiFetch(
    page,
    `/web/search/topsearch/?query=${encodeURIComponent(handle)}`,
    {
      referer: "https://www.instagram.com/",
      headers: { Referer: "https://www.instagram.com/" },
    }
  );
  if (!json) return null;
  const entries = Array.isArray(json.users) ? json.users : [];
  const lower = handle.toLowerCase();
  const match = entries.find(
    (x) => String(x?.user?.username || "").toLowerCase() === lower
  );
  const user = match?.user || null;
  const pk = user?.pk || user?.pk_id || user?.id || null;
  if (!pk) return null;
  return { pk: String(pk), username: user.username || handle };
}

/**
 * Profile metadata GraphQL fallback. IG changes variables often, so try a few
 * known light shapes and keep the first response that resolves.
 * @param {import('playwright').Page} page
 * @param {{ userId?: string|null, username?: string|null }} options
 */
export async function fetchProfilePageContentGraphql(page, options = {}) {
  const uid = String(options.userId || "").trim();
  const handle = String(options.username || "").replace(/^@/, "").trim();
  if (!uid && !handle) return null;
  const referer = handle
    ? `https://www.instagram.com/${encodeURIComponent(handle)}/`
    : "https://www.instagram.com/";
  const candidates = [];
  if (uid) {
    candidates.push({
      enable_integrity_filters: true,
      id: uid,
      __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
      __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
      __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
      __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: true,
    });
    candidates.push({ user_id: uid, render_surface: "PROFILE" });
    candidates.push({ userID: uid, render_surface: "PROFILE" });
  }
  if (handle) {
    candidates.push({ username: handle, render_surface: "PROFILE" });
    candidates.push({ data: { username: handle }, render_surface: "PROFILE" });
  }
  for (const variables of candidates) {
    const json = await igGraphqlFetch(page, {
      docId: IG_GQL_PROFILE_DOC_ID,
      friendlyName: IG_GQL_PROFILE_FRIENDLY,
      variables,
      referer,
    });
    if (json?.data) return json;
  }
  return null;
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
  const basePayload = {
    docId: IG_GQL_REELS_DOC_ID,
    friendlyName: IG_GQL_REELS_FRIENDLY,
    rootField: "fetch__XDTUserDict",
    variables: {
      data,
      user_id: uid,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    },
    referer: handle
      ? `https://www.instagram.com/${handle}/reels/`
      : `https://www.instagram.com/`,
  };

  const paths = [...IG_GQL_REELS_PATHS];
  if (options.maxId && getIgRelayTemplate(page, IG_GQL_REELS_FRIENDLY)) {
    for (const gqlPath of paths) {
      const viaTemplate = await igGraphqlFetchWithTemplate(page, {
        ...basePayload,
        path: gqlPath,
      });
      if (viaTemplate) return viaTemplate;
    }
  }

  for (const gqlPath of paths) {
    const json = await igGraphqlFetch(page, { ...basePayload, path: gqlPath });
    if (json) return json;
  }
  return null;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} userId
 * @param {{ maxId?: string|null, pageSize?: number, username?: string, skipCapture?: boolean }} [options]
 */
async function fetchUserClipsRestPayload(page, userId, options = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const pageSize = Math.min(Math.max(Number(options.pageSize || 24), 6), 24);
  const params = new URLSearchParams({
    target_user_id: uid,
    page_size: String(pageSize),
  });
  if (options.maxId) params.set("max_id", String(options.maxId));
  const body = params.toString();
  let json = await igApiFetch(page, `/api/v1/clips/user/?${body}`, { method: "POST", body });
  if (json) return json;
  return igApiFetch(page, `/api/v1/clips/user/?${body}`);
}

export async function fetchUserClipsPage(page, userId, options = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const handle = String(options.username || "").replace(/^@/, "");
  const { isUsableIgClipsJson } = await import("./instagram-json-utils.js");

  const graphqlAttempts = Math.min(
    Math.max(Number(process.env.IG_LITE_REELS_GRAPHQL_ATTEMPTS || 3), 1),
    5
  );
  const retryDelayMs = Math.min(
    Math.max(Number(process.env.IG_LITE_REELS_RETRY_DELAY_MS || 180), 0),
    1500
  );

  // 首次获取：若尚无该查询的真实 relay 模板（页面请求体带 __dyn/__csr，IG 新版必需，
  // 我们手工拼接的 body 缺这两个参数会被 1357001 "请登录" 拒绝），先导航 /reels/ 收割
  // 一次真实请求体作为模板，之后的分页全部走 API-only 模板回放。
  const noNavigation = ["1", "true", "yes"].includes(
    String(process.env.IG_API_ONLY_NO_NAVIGATION || "").trim().toLowerCase()
  );
  if (
    !noNavigation &&
    !options.skipCapture &&
    handle &&
    !getIgRelayTemplate(page, IG_GQL_REELS_FRIENDLY)
  ) {
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
      if (captured?.json && isUsableIgClipsJson(captured.json)) return captured.json;
      if (captured?.requestBody) {
        console.log(
          `[instagram-direct] 已收割 reels 真实 relay 模板（@${handle}），后续走 API-only 模板回放`
        );
      }
    } catch (e) {
      console.warn(`[instagram-direct] reels 模板收割失败: ${e?.message || e}`);
    }
  }

  let json = null;
  for (let attempt = 1; attempt <= graphqlAttempts; attempt++) {
    json = await fetchUserClipsGraphqlPayload(page, uid, options);
    if (json && isUsableIgClipsJson(json)) return json;
    if (attempt < graphqlAttempts) {
      await warmUpIgRelayTemplateIfNeeded(page).catch(() => false);
      if (retryDelayMs > 0) await page.waitForTimeout(retryDelayMs * attempt);
    }
  }

  // 会话认证被拒（Please log in / cannot be displayed）时，reload 修复后重试一次 GraphQL
  if (!json) {
    const repaired = await repairIgSessionOnAuthRejection(page);
    if (repaired) {
      json = await fetchUserClipsGraphqlPayload(page, uid, options);
      if (json && isUsableIgClipsJson(json)) return json;
    }
  }

  if (!noNavigation && !options.skipCapture && handle) {
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
      if (captured?.json && isUsableIgClipsJson(captured.json)) return captured.json;
    } catch (e) {
      console.warn(`[instagram-direct] reels navigation capture: ${e.message}`);
    }
  } else if (noNavigation && !json) {
    console.warn(
      `[instagram-direct] IG_API_ONLY_NO_NAVIGATION=1，不打开 /reels/ 页: userId=${uid}`
    );
  }

  json = await fetchUserClipsRestPayload(page, uid, options);
  if (json && isUsableIgClipsJson(json)) return json;

  return json || null;
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
