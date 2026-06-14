#!/usr/bin/env node
/** 探测 innertube 直调 search 是否可用 */
import { chromium } from "playwright";

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const context = browser.contexts()[0];
let page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());

await page.goto("https://www.youtube.com", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);

const probe = await page.evaluate(async () => {
  const ytcfg = window.ytcfg?.data_ || {};
  const apiKey =
    ytcfg.INNERTUBE_API_KEY ||
    (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_API_KEY") : null);
  const ctx =
    ytcfg.INNERTUBE_CONTEXT ||
    (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_CONTEXT") : null);
  if (!apiKey || !ctx) return { error: "missing_ytcfg", url: location.href, hasYtcfg: !!window.ytcfg };

  const url = `https://www.youtube.com/youtubei/v1/search?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        context: ctx,
        query: "cat litter box",
        params: "EgIQAQ==",
      }),
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      bytes: text.length,
      preview: text.slice(0, 200),
      url: location.href,
    };
  } catch (e) {
    return { error: String(e), url: location.href };
  }
});

console.log(JSON.stringify(probe, null, 2));
await browser.close().catch(() => {});
