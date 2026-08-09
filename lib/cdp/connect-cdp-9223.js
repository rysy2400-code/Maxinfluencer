/**
 * TikTok Enrich 专用 CDP 9223（不登录 profile，与 9222 搜索隔离）
 */
import { chromium } from "playwright";
import { pruneCdpContextTabs } from "./cdp-tab-utils.js";

export function cdp9223Endpoint() {
  return (
    process.env.CDP_ENDPOINT_ENRICH ||
    process.env.CDP_ENDPOINT_9223 ||
    "http://127.0.0.1:9223"
  );
}

function connectTimeoutMs() {
  return Number(process.env.CDP_CONNECT_TIMEOUT_MS) || 20_000;
}

export async function connectCdp9223(meta = {}) {
  const endpoint = cdp9223Endpoint();
  return chromium.connectOverCDP(endpoint, {
    timeout: connectTimeoutMs(),
  });
}

/**
 * @param {object} meta
 * @param {(session: { browser: import('playwright').Browser, context: import('playwright').BrowserContext }) => Promise<T>} fn
 * @template T
 */
export async function withCdp9223PreparedSession(meta, fn) {
  const browser = await connectCdp9223(meta);
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    await pruneCdpContextTabs(context, { ...meta, phase: meta.phase || "enrich-9223" });
    return await fn({ browser, context });
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}
