/**
 * X GraphQL 请求驱动：在已登录 x.com 页面上下文内 fetch，读取限流头，处理 X 错误码。
 * 风控策略对齐 Instagram Lite（保守并发 + 请求间隔 + 限流冷却），并对齐 twscrape/x-relay 的
 * 错误分类：429 → 冷却；88/326/32/403 → 账号异常；404/336 → queryId/features 漂移。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveXLiteRequestDelay } from "../../../scraper/resolve-scraper-mode.js";
import {
  XAccountBlockedError,
  XGraphqlConfigError,
  XRateLimitedError,
} from "./x-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG_PATH = path.join(__dirname, "x-gql-config.json");
const API_ROOT = process.env.X_GQL_API_ROOT || "https://x.com";

let cachedConfig = null;

export function loadXGqlConfig(forceRefresh = false) {
  if (cachedConfig && !forceRefresh) return cachedConfig;
  const configPath = process.env.X_GQL_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  cachedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return cachedConfig;
}

export function reloadXGqlConfig() {
  return loadXGqlConfig(true);
}

function stableStringify(obj) {
  return JSON.stringify(obj);
}

function buildQueryUrl(config, queryName, variables) {
  const q = config.queries?.[queryName];
  if (!q?.queryId) throw new XGraphqlConfigError(`X GQL 配置缺少 ${queryName}`);
  const url = `${API_ROOT}/i/api/graphql/${q.queryId}/${queryName}`;
  const params = new URLSearchParams();
  params.set("variables", stableStringify(variables));
  if (q.features && Object.keys(q.features).length) {
    params.set("features", stableStringify(q.features));
  }
  if (q.fieldToggles && Object.keys(q.fieldToggles).length) {
    params.set("fieldToggles", stableStringify(q.fieldToggles));
  }
  return `${url}?${params.toString()}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function isJsonText(text) {
  const t = String(text || "").trim();
  return t.startsWith("{") || t.startsWith("[");
}

function classifyGraphqlError(status, body, headers = {}) {
  const remainingRaw = headers["x-rate-limit-remaining"];
  const resetRaw = headers["x-rate-limit-reset"];
  const remaining = Number(remainingRaw);
  const resetSec = Number(resetRaw);

  if (status === 429 || (Number.isFinite(remaining) && remaining === 0 && resetSec > 0)) {
    return { kind: "rate_limited", resetAtMs: resetSec > 0 ? resetSec * 1000 : 0 };
  }
  if (status === 403 && !isJsonText(body)) {
    return { kind: "challenge_html", detail: "403 HTML（可能为 cf/风控页）" };
  }
  let codes = [];
  if (isJsonText(body)) {
    try {
      const parsed = JSON.parse(body);
      codes = Array.isArray(parsed?.errors)
        ? parsed.errors.map((e) => Number(e?.code))
        : [];
    } catch {
      codes = [];
    }
  }
  if (status === 404 || codes.includes(404)) {
    return { kind: "gql_config", detail: `404: queryId 可能已轮换 (${body.slice(0, 120)})` };
  }
  if (codes.includes(336)) {
    return { kind: "gql_config", detail: "336: features 漂移，需刷新配置" };
  }
  if (codes.includes(88) || codes.includes(326) || codes.includes(32) || status === 403) {
    return { kind: "account_bad", detail: `错误码 ${codes.join(",")} / HTTP ${status}` };
  }
  if (codes.includes(131)) {
    return { kind: "no_data", detail: "131: 无数据" };
  }
  return { kind: "unknown", detail: `HTTP ${status} codes=[${codes.join(",")}] ${body.slice(0, 120)}` };
}

/**
 * 页内 fetch GraphQL（串行化）。
 * @param {object} session x-session
 * @param {string} queryName SearchTimeline | UserByScreenName | UserTweets
 * @param {object} variables
 * @param {{ txid?: string|null, noTxid?: boolean }} [opts]
 */
export async function gqlRequest(session, queryName, variables, opts = {}) {
  const config = loadXGqlConfig();
  const q = config.queries?.[queryName];
  if (!q) throw new XGraphqlConfigError(`X GQL 配置缺少 ${queryName}`);
  const url = buildQueryUrl(config, queryName, variables);

  let txid = null;
  if (q.needsTransactionId && !opts.noTxid && session.clientTx) {
    await session.clientTx.ensureReady(false).catch((e) => {
      console.warn(`[x-graphql] txid ensureReady 失败: ${e.message}（本次不带 txid）`);
    });
    try {
      const u = new URL(url);
      txid = session.clientTx.generateTransactionId(q.httpMethod || "GET", u.pathname);
    } catch (e) {
      console.warn(`[x-graphql] txid 生成失败: ${e.message}`);
    }
  }

  const headers = {
    authorization: config.bearerToken,
    "x-csrf-token": session.ct0,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "content-type": "application/json",
    referer: "https://x.com/",
    origin: "https://x.com",
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
  if (txid) headers["x-client-transaction-id"] = txid;

  const result = await session.evaluate(
    async ({ url: fetchUrl, headers: fetchHeaders }) => {
      const resp = await fetch(fetchUrl, {
        method: "GET",
        credentials: "include",
        headers: fetchHeaders,
      });
      const body = await resp.text();
      const rateHeaders = {};
      for (const key of ["x-rate-limit-remaining", "x-rate-limit-reset", "x-rate-limit-limit"]) {
        const v = resp.headers.get(key);
        if (v) rateHeaders[key] = v;
      }
      return { status: resp.status, body, rateHeaders };
    },
    { url, headers }
  );

  session.state.requestCount += 1;
  session.state.lastRequestAt = Date.now();

  const verdict = classifyGraphqlError(result.status, result.body, result.rateHeaders);
  if (verdict.kind === "rate_limited") {
    session.markRateLimited(verdict.resetAtMs || 0);
    throw new XRateLimitedError(`X 限流 (429/remaining=0)`, verdict.resetAtMs || 0);
  }
  if (verdict.kind === "gql_config") {
    throw new XGraphqlConfigError(`X GQL 元数据失效: ${verdict.detail}`);
  }
  if (verdict.kind === "account_bad") {
    session.markBad(`账号风控/失效: ${verdict.detail}`, { url });
  }
  if (verdict.kind === "challenge_html") {
    session.markBad(`返回 403 HTML（风控挑战页）`, { url });
  }
  if (verdict.kind === "no_data") {
    return null;
  }
  if (verdict.kind === "unknown") {
    console.warn(`[x-graphql] ${queryName} 未知响应: ${verdict.detail}`);
  }
  if (!isJsonText(result.body)) {
    throw new Error(`X GraphQL ${queryName} 响应非 JSON: ${result.body.slice(0, 160)}`);
  }
  try {
    return JSON.parse(result.body);
  } catch {
    throw new Error(`X GraphQL ${queryName} JSON 解析失败: ${result.body.slice(0, 160)}`);
  }
}

/**
 * 请求前节奏控制（冷却 + 随机间隔）。
 * @param {object} session
 */
export async function paceBeforeRequest(session) {
  if (session.isCoolingDown()) {
    await sleep(Math.min(session.coolDownRemainingMs(), 15 * 60 * 1000));
  }
  const { min, max } = resolveXLiteRequestDelay();
  const sinceLast = Date.now() - (session.state.lastRequestAt || 0);
  const wait = Math.max(0, randomBetween(min, max) - sinceLast);
  if (wait > 0) await sleep(wait);
}

/**
 * SearchTimeline 单页（带分页 cursor 与 txid）。
 * @param {object} session
 * @param {string} keyword
 * @param {{ cursor?: string|null, product?: string, count?: number }} [opts]
 */
export async function fetchSearchTimelinePage(session, keyword, opts = {}) {
  const { cursor = null, product = "Latest", count = 20 } = opts;
  await paceBeforeRequest(session);
  const variables = {
    rawQuery: keyword,
    count,
    querySource: "",
    product,
    withGrokTranslatedBio: false,
    withQuickPromoteEligibilityTweetFields: false,
  };
  if (cursor) variables.cursor = cursor;
  try {
    return await gqlRequest(session, "SearchTimeline", variables);
  } catch (e) {
    if (e instanceof XGraphqlConfigError || (e?.code === "X_GQL_CONFIG")) {
      // queryId 轮换：刷新配置后重试一次（best-effort，失败交给上层）
      try {
        const { refreshXGqlConfigFromCatalog } = await import("./x-gql-refresh.js");
        const changed = await refreshXGqlConfigFromCatalog({ forcePinned: true });
        if (changed) {
          await paceBeforeRequest(session);
          return await gqlRequest(session, "SearchTimeline", variables);
        }
      } catch (refreshErr) {
        console.warn(`[x-graphql] 自动刷新 GQL 配置失败: ${refreshErr.message}`);
      }
      throw e;
    }
    throw e;
  }
}

/** UserByScreenName 单页 */
export async function fetchUserByScreenName(session, screenName) {
  await paceBeforeRequest(session);
  return gqlRequest(session, "UserByScreenName", { screen_name: screenName });
}

/** UserTweets 单页（近期推文互动） */
export async function fetchUserTweetsPage(session, userId, opts = {}) {
  const { cursor = null, count = 20 } = opts;
  await paceBeforeRequest(session);
  const variables = {
    userId,
    count,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: true,
  };
  if (cursor) variables.cursor = cursor;
  return gqlRequest(session, "UserTweets", variables);
}
