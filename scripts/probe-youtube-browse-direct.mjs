#!/usr/bin/env node
import { chromium } from "playwright";

const handle = process.argv[2] || "JacksonGalaxy";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const context = browser.contexts()[0];
const page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());
await page.goto("https://www.youtube.com", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);

async function innertube(endpoint, body) {
  return page.evaluate(
    async ({ endpoint, body }) => {
      const ytcfg = window.ytcfg?.data_ || {};
      const apiKey =
        ytcfg.INNERTUBE_API_KEY ||
        (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_API_KEY") : null);
      const ctx =
        ytcfg.INNERTUBE_CONTEXT ||
        (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_CONTEXT") : null);
      if (!apiKey || !ctx) return { error: "missing_ytcfg" };
      const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...body, context: ctx }),
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, bytes: text.length, text };
    },
    { endpoint, body }
  );
}

const resolve = await innertube("navigation/resolve_url", {
  url: `https://www.youtube.com/@${handle.replace(/^@/, "")}`,
  parse: true,
});
let browseId = null;
if (resolve.text) {
  const m = resolve.text.match(/"browseId"\s*:\s*"(UC[^"]+)"/);
  browseId = m?.[1] || null;
}

const browseAt = await innertube("browse", {
  browseId: `@${handle.replace(/^@/, "")}`,
  params: "EgZ2aWRlb3M%3D",
});

const browseUc = browseId
  ? await innertube("browse", {
      browseId,
      params: "EgZ2aWRlb3M%3D",
    })
  : { skipped: true };

console.log(
  JSON.stringify(
    {
      resolve: { ok: resolve.ok, status: resolve.status, browseId },
      browseAtHandle: {
        ok: browseAt.ok,
        status: browseAt.status,
        hasVideo: browseAt.text?.includes("videoId"),
      },
      browseUc: {
        ok: browseUc.ok,
        status: browseUc.status,
        hasVideo: browseUc.text?.includes("videoId"),
        bytes: browseUc.bytes,
      },
    },
    null,
    2
  )
);

await browser.close().catch(() => {});
