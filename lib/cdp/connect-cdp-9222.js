/**
 * 统一 9222 CDP 连接：parallel（多 loop 各管各 Tab）| serial（全局互斥）。
 */
import { chromium } from "playwright";
import { withCdp9222Lock } from "./cdp-9222-mutex.js";

export function resolveCdp9222Mode() {
  const m = String(process.env.CDP_9222_MODE || "serial").trim().toLowerCase();
  return m === "parallel" ? "parallel" : "serial";
}

export function isCdp9222Parallel() {
  return resolveCdp9222Mode() === "parallel";
}

export function cdp9222Endpoint() {
  return (
    process.env.CDP_ENDPOINT_ENRICH ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9222"
  );
}

/**
 * @param {object} [meta]
 * @param {string} [meta.platform]
 * @param {number} [meta.taskId]
 * @param {string} [meta.phase]
 */
export async function connectCdp9222(meta = {}) {
  const endpoint = cdp9222Endpoint();
  const connectFn = () =>
    chromium.connectOverCDP(endpoint, {
      timeout: Number(process.env.CDP_CONNECT_TIMEOUT_MS) || 10_000,
    });

  if (isCdp9222Parallel()) {
    return connectFn();
  }
  return withCdp9222Lock(meta, connectFn);
}

/**
 * @param {object} meta
 * @param {(browser: import('playwright').Browser) => Promise<unknown>} fn
 */
export async function withCdp9222Browser(meta, fn) {
  const run = async () => {
    const browser = await connectCdp9222(meta);
    try {
      return await fn(browser);
    } finally {
      try {
        await browser.close();
      } catch {
        /* disconnect only */
      }
    }
  };

  if (isCdp9222Parallel()) {
    return run();
  }
  return withCdp9222Lock(meta, run);
}
