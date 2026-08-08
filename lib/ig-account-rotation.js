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

  // 全部都在冷却：选最早解除冷却的
  const earliest = [...withIndex].sort(
    (a, b) =>
      Number(state.accounts?.[a.endpoint]?.cooldownUntil || 0) -
      Number(state.accounts?.[b.endpoint]?.cooldownUntil || 0)
  )[0];
  return earliest.endpoint;
}

/**
 * 标记账户限流：进入冷却（只延长不缩短）。
 * @param {string} endpoint
 * @param {string} [reason]
 */
export function markIgAccountThrottled(endpoint, reason = "unknown") {
  const e = normalizeEndpoint(endpoint);
  if (!e) return;
  const state = loadState();
  if (!state.accounts) state.accounts = {};
  const prev = state.accounts[e] || {};
  const now = Date.now();
  const cooldownUntil = Math.max(now + getIgAccountCooldownMs(), Number(prev.cooldownUntil || 0));
  state.accounts[e] = {
    cooldownUntil,
    throttleCount: Number(prev.throttleCount || 0) + 1,
    lastThrottledAt: now,
    lastReason: reason,
  };
  saveState(state);
  console.warn(
    `[ig-rotation] 账户 ${e} 限流，冷却至 ${new Date(cooldownUntil).toISOString()}（reason=${reason}）`
  );
}
