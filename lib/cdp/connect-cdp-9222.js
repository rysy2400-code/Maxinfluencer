/**
 * 统一 9222 CDP 连接：parallel（多 loop 各管各 Tab）| serial（全局互斥）。
 * 共享 Chrome 时通过 withCdp9222PreparedSession 在整段任务期间持锁，并在连接后 prune 遗留 tab。
 */
import { chromium } from "playwright";
import { withCdp9222Lock } from "./cdp-9222-mutex.js";
import { pruneCdpContextTabs } from "./cdp-tab-utils.js";
import {
  disconnectCdpBrowser,
  requestChrome9222Restart,
  waitForCdp9222Ready,
  cdp9222EndpointForHealth,
} from "./cdp-chrome-restart.js";

export function resolveCdp9222Mode() {
  const m = String(process.env.CDP_9222_MODE || "serial").trim().toLowerCase();
  return m === "parallel" ? "parallel" : "serial";
}

export function isCdp9222Parallel() {
  return resolveCdp9222Mode() === "parallel";
}

export function cdp9222Endpoint() {
  return cdp9222EndpointForHealth();
}

function connectTimeoutMs() {
  return Number(process.env.CDP_CONNECT_TIMEOUT_MS) || 10_000;
}

function connectAttemptsBeforeRestart() {
  const n = Number(process.env.CDP_CONNECT_ATTEMPTS_BEFORE_RESTART);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}

function useCdp9222SessionLock() {
  const raw = String(process.env.CDP_9222_SESSION_LOCK || "true").trim().toLowerCase();
  if (raw === "false" || raw === "0") return false;
  return true;
}

async function connectOverCdpOnce(meta = {}) {
  const endpoint = cdp9222Endpoint();
  return chromium.connectOverCDP(endpoint, {
    timeout: connectTimeoutMs(),
  });
}

/**
 * 连接 9222；失败时发 guard 重启信号并等待恢复后再试。
 * @param {object} [meta]
 */
export async function connectCdp9222WithRestart(meta = {}) {
  const attempts = connectAttemptsBeforeRestart();
  let lastError = null;

  for (let round = 0; round < 2; round += 1) {
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await connectOverCdpOnce(meta);
      } catch (e) {
        lastError = e;
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    if (round === 0) {
      const reason = `connect_failed:${meta.platform || "?"}:${meta.phase || "?"}`;
      const signaled = await requestChrome9222Restart(reason);
      if (signaled) {
        const settleMs = Number(process.env.CDP_RESTART_SETTLE_MS) || 12_000;
        await new Promise((r) => setTimeout(r, settleMs));
      }
      const waitMs = Number(process.env.CDP_RESTART_WAIT_MS) || 30_000;
      await waitForCdp9222Ready(waitMs);
    }
  }

  throw lastError || new Error("CDP 连接失败");
}

/**
 * @param {object} [meta]
 * @param {string} [meta.platform]
 * @param {number} [meta.taskId]
 * @param {string} [meta.phase]
 */
export async function connectCdp9222(meta = {}) {
  const connectFn = () => connectCdp9222WithRestart(meta);

  if (isCdp9222Parallel() && !useCdp9222SessionLock()) {
    return connectFn();
  }
  return withCdp9222Lock(meta, connectFn);
}

/**
 * 连接 → prune（只留 1 个 blank tab）→ 执行 fn → 断开。
 * 共享 Chrome 时默认整段持锁，避免并发任务互相 prune 掉对方 tab。
 *
 * @param {object} meta
 * @param {(session: { browser: import('playwright').Browser, context: import('playwright').BrowserContext }) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withCdp9222PreparedSession(meta, fn) {
  const run = async () => {
    const browser = await connectCdp9222WithRestart(meta);
    try {
      const context = browser.contexts()[0] || (await browser.newContext());
      await pruneCdpContextTabs(context, meta);
      return await fn({ browser, context });
    } finally {
      await disconnectCdpBrowser(browser);
    }
  };

  if (isCdp9222Parallel() && !useCdp9222SessionLock()) {
    return run();
  }
  return withCdp9222Lock(meta, run);
}

/**
 * @param {object} meta
 * @param {(browser: import('playwright').Browser) => Promise<unknown>} fn
 */
export async function withCdp9222Browser(meta, fn) {
  return withCdp9222PreparedSession(meta, async ({ browser, context }) => {
    void context;
    return fn(browser);
  });
}
