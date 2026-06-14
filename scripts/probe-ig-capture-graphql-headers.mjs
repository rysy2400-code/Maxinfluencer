#!/usr/bin/env node
import { chromium } from "playwright";

const keyword = process.argv[2] || "pool cleaner";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const page = browser.contexts()[0].pages().find((p) => !p.isClosed()) || (await browser.contexts()[0].newPage());

const hits = [];
page.on("request", (req) => {
  const url = req.url();
  if (!url.includes("/api/graphql")) return;
  const post = req.postData() || "";
  if (!post.includes("PolarisKeywordSearchExplorePageRelayQuery") && !post.includes("27261995973455813")) return;
  hits.push({
    url: url.split("?")[0],
    headers: req.headers(),
    postPreview: post.slice(0, 500),
  });
});

await page.goto(
  `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`,
  { waitUntil: "commit", timeout: 60000 }
).catch(() => {});
await page.waitForTimeout(6000);

const lsd = await page.evaluate(() => {
  const input = document.querySelector('input[name="lsd"]')?.value;
  const scripts = [...document.querySelectorAll("script")].map((s) => s.textContent || "");
  let fromScript = null;
  for (const t of scripts) {
    const m = t.match(/"LSD",\[\],\{"token":"([^"]+)"/);
    if (m) { fromScript = m[1]; break; }
    const m2 = t.match(/"lsd":"([^"]+)"/);
    if (m2) { fromScript = m2[1]; break; }
  }
  return { input, fromScript, cookie: document.cookie.match(/lsd=([^;]+)/)?.[1] || null };
});

console.log(JSON.stringify({ lsd, hits }, null, 2));
await browser.close().catch(() => {});
