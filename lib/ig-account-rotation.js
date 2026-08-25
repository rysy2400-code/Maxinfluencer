/**
 * IG 多账户轮换：遇限流标记账户冷却，按 round-robin 选择非冷却账户。
 * 状态持久化到 <repo>/data/ig-account-state.json，worker 重启不丢失。
 *
 * 环境变量：
 *   IG_ACCOUNT_ENDPOINTS      逗号分隔的 CDP 端点列表，如 http://127.0.0.1:9222,http://127.0.0.1:9223
 *   IG_ACCOUNT_COOLDOWN_MS    限流冷却毫秒（默认 30 分钟）
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.resolve(__dirname, "../data/ig-account-state.json");

function normalizeEndpoint(endpoint) {
  return String(endpoint || "").trim().replace(/\/+$/, "");
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) || { accounts: {} };
  } catch {
    return { accounts: {} };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    console.warn(`[ig-rotation] 保存账户状态失败: ${e?.message || e}`);
  }
}

export function resolveIgAccountEndpoints() {
  const raw =
    process.env.IG_ACCOUNT_ENDPOINTS ||
    process.env.IG_LITE_ENRICH_CDP_ENDPOINTS ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9222";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeEndpoint);
}

export function getIgAccountCooldownMs() {
  const n = Number(process.env.IG_ACCOUNT_COOLDOWN_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
}

export function getIgAccountThrottle400Streak() {
  const n = Number(process.env.IG_ACCOUNT_THROTTLE_400_STREAK);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 20) : 3;
}

/** 全部账户冷却时的轮询间隔（默认 60 秒） */
export function getIgAccountCooldownPollMs() {
  const n = Number(process.env.IG_ACCOUNT_COOLDOWN_POLL_MS);
  return Number.isFinite(n) && n >= 5000
    ? Math.min(Math.floor(n), 3600_000)
    : 60_000;
}

/** 登录态异常（掉登录/封号/验证码）账户的冷却时长，默认 12 小时（需人工处理） */
export function getIgAccountLoginBrokenCooldownMs() {
  const n = Number(process.env.IG_ACCOUNT_LOGIN_BROKEN_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 60_000
    ? Math.min(Math.floor(n), 7 * 24 * 3600_000)
    : 12 * 3600_000;
}

/** CDP 连接失败的短冷却，默认 5 分钟（等 guard/重启兜底拉起 Chrome） */
export function getIgAccountUnreachableCooldownMs() {
  const n = Number(process.env.IG_ACCOUNT_UNREACHABLE_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 30_000
    ? Math.min(Math.floor(n), 3600_000)
    : 5 * 60_000;
}

/** 连续空搜索结果阈值，默认 3 次后标记该账户异常并切换其他账户 */
export function getIgAccountEmptySearchStreak() {
  const n = Number(process.env.IG_ACCOUNT_EMPTY_SEARCH_STREAK);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 20) : 3;
}

// 内存级"任务中途限流"标记：markIgAccountThrottled 时置位，
// enrich 流水线每处理完一位红人检查一次，命中即中止当前任务。
let lastMarkedThrottled = null;

export function resetIgAccountThrottleFlag() {
  lastMarkedThrottled = null;
}

/**
 * 消费任务中途限流标记（仅匹配指定端点；一次性）。
 * @param {string} endpoint
 * @returns {{ endpoint: string, reason: string, at: number }|null}
 */
export function consumeIgAccountThrottleFlag(endpoint) {
  const e = normalizeEndpoint(endpoint);
  if (!e || !lastMarkedThrottled || lastMarkedThrottled.endpoint !== e) {
    return null;
  }
  const flag = lastMarkedThrottled;
  lastMarkedThrottled = null;
  return flag;
}

/**
 * 选择下一个要使用的账户端点（round-robin，跳过冷却中的账户）。
 * @param {string|null} [preferred] 上一次使用的端点；从它之后开始轮询
 * @returns {string|null}
 */
export function pickNextIgAccount(preferred = null) {
  const endpoints = resolveIgAccountEndpoints();
  if (!endpoints.length) return null;
  const state = loadState();
  const now = Date.now();
  const preferredNorm = preferred ? normalizeEndpoint(preferred) : null;
  const preferredIdx = preferredNorm
    ? endpoints.indexOf(preferredNorm)
    : -1;

  const withIndex = endpoints.map((endpoint, index) => ({ endpoint, index }));
  const notInCooldown = withIndex.filter(
    (c) =>
      !state.accounts?.[c.endpoint] ||
      Number(state.accounts[c.endpoint].cooldownUntil || 0) <= now
  );

  if (notInCooldown.length) {
    const sorted = [...notInCooldown].sort((a, b) => {
      const ai = (a.index - (preferredIdx + 1) + endpoints.length) % endpoints.length;
      const bi = (b.index - (preferredIdx + 1) + endpoints.length) % endpoints.length;
      return ai - bi;
    });
    const chosen = sorted[0].endpoint;
    if (!state.accounts) state.accounts = {};
    state.accounts[chosen] = {
      ...(state.accounts[chosen] || {}),
      lastUsedAt: now,
    };
    saveState(state);
    return chosen;
  }

  // 全部都在冷却：返回 null，由调用方进入休息轮询
  return null;
}

/**
 * 账户当前是否处于限流冷却。
 * @param {string} endpoint
 * @returns {boolean}
 */
export function isIgAccountThrottled(endpoint) {
  const e = normalizeEndpoint(endpoint);
  if (!e) return false;
  const state = loadState();
  const cd = Number(state.accounts?.[e]?.cooldownUntil || 0);
  return cd > Date.now();
}

/**
 * 标记账户限流：进入冷却（只延长不缩短）。
 * @param {string} endpoint
 * @param {string} [reason]
 * @param {number} [cooldownMs] 覆盖默认冷却时长
 */
export function markIgAccountThrottled(endpoint, reason = "unknown", cooldownMs = null) {
  const e = normalizeEndpoint(endpoint);
  if (!e) return;
  const state = loadState();
  if (!state.accounts) state.accounts = {};
  const prev = state.accounts[e] || {};
  const now = Date.now();
  const baseMs = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : getIgAccountCooldownMs();
  const cooldownUntil = Math.max(now + baseMs, Number(prev.cooldownUntil || 0));
  state.accounts[e] = {
    cooldownUntil,
    throttleCount: Number(prev.throttleCount || 0) + 1,
    lastThrottledAt: now,
    lastReason: reason,
    emptySearchStreak: Number(prev.emptySearchStreak || 0),
  };
  saveState(state);
  lastMarkedThrottled = { endpoint: e, reason, at: now };
  console.warn(
    `[ig-rotation] 账户 ${e} 限流，冷却至 ${new Date(cooldownUntil).toISOString()}（reason=${reason}）`
  );
}

/**
 * 标记账户登录态异常（掉登录/封号/验证码等），进入长冷却，需人工处理后由 clearIgAccountCooldown 解除。
 * @param {string} endpoint
 * @param {string} [reason]
 */
export function markIgAccountLoginBroken(endpoint, reason = "login_broken") {
  markIgAccountThrottled(endpoint, `login_broken:${reason}`, getIgAccountLoginBrokenCooldownMs());
}

/**
 * 标记账户 CDP 不可达（Chrome 未起/连接失败），短冷却后由 guard 重启兜底。
 * @param {string} endpoint
 */
export function markIgAccountUnreachable(endpoint) {
  markIgAccountThrottled(endpoint, "cdp_unreachable", getIgAccountUnreachableCooldownMs());
}

/**
 * 记录一次搜索结果：连续空结果达到阈值时自动标记该账户限流。
 * @param {string} endpoint
 * @param {boolean} empty 本次搜索是否空结果
 */
export function noteIgAccountSearchResult(endpoint, empty) {
  const e = normalizeEndpoint(endpoint);
  if (!e) return;
  const state = loadState();
  if (!state.accounts) state.accounts = {};
  const prev = state.accounts[e] || {};
  const streak = empty ? Number(prev.emptySearchStreak || 0) + 1 : 0;
  state.accounts[e] = { ...prev, emptySearchStreak: streak };
  saveState(state);
  if (empty) {
    const threshold = getIgAccountEmptySearchStreak();
    if (streak >= threshold) {
      markIgAccountThrottled(e, `empty_search_streak_x${streak}`);
    } else {
      console.warn(
        `[ig-rotation] 账户 ${e} 空搜索结果 ${streak}/${threshold}，继续观察`
      );
    }
  }
}

/**
 * 手动解除账户冷却（如人工补登后调用）。
 * @param {string} endpoint
 */
export function clearIgAccountCooldown(endpoint) {
  const e = normalizeEndpoint(endpoint);
  if (!e) return;
  const state = loadState();
  if (!state.accounts) state.accounts = {};
  const prev = state.accounts[e] || {};
  state.accounts[e] = { ...prev, cooldownUntil: 0, lastReason: "cleared_manually" };
  saveState(state);
  console.warn(`[ig-rotation] 账户 ${e} 冷却已手动解除`);
}

/**
 * 通过 CDP 探测账户登录态（只读 cookies / 页面 URL，不导航）。
 * @param {string} endpoint
 * @returns {Promise<{ok: boolean, reason: string|null, sessionId: boolean, pageUrl: string|null}>}
 */
export async function checkIgAccountLoginState(endpoint) {
  const e = normalizeEndpoint(endpoint);
  const result = { ok: false, reason: null, sessionId: false, pageUrl: null };
  if (!e) {
    result.reason = "no_endpoint";
    return result;
  }
  let browser = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.connectOverCDP(e, { timeout: 12000 });
    const ctx = browser.contexts()[0];
    let cookies = [];
    try {
      cookies = ctx ? await ctx.cookies("https://www.instagram.com") : [];
    } catch {
      cookies = [];
    }
    const hasSessionId = cookies.some((c) => c.name === "sessionid" && c.value);
    result.sessionId = hasSessionId;

    let igUrls = [];
    try {
      const pages = ctx ? ctx.pages() : [];
      igUrls = pages
        .map((p) => p.url())
        .filter((u) => /instagram\.com/i.test(u || ""));
      if (!igUrls.length && pages.length) {
        const chromeErrorPage = pages.find((p) => /chrome-error/i.test(p.url() || ""));
        if (chromeErrorPage) igUrls.push(chromeErrorPage.url());
      }
    } catch {
      /* ignore */
    }
    result.pageUrl = igUrls[0] || null;

    const joined = igUrls.map((u) => String(u)).join(" ");
    if (/accounts\/suspended|accounts\/disabled/i.test(joined)) {
      result.reason = "suspended";
    } else if (/chrome-error/i.test(joined)) {
      result.reason = "chrome_error";
    } else if (!hasSessionId) {
      result.reason = "no_sessionid";
    } else if (
      igUrls.length > 0 &&
      igUrls.every((u) =>
        /accounts\/(login|checkpoint|scraping_warning)|auth_platform|challenge/i.test(
          String(u)
        )
      )
    ) {
      result.reason = "all_pages_abnormal";
    } else {
      result.ok = true;
      result.reason = null;
    }
    return result;
  } catch (err) {
    result.reason = `cdp_connect_failed:${String(err?.message || err).slice(0, 120)}`;
    return result;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
