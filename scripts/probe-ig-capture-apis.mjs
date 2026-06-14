#!/usr/bin/env node
/** 捕获 IG 搜索/enrich 实际 API 路径 */
import { chromium } from "playwright";

const keyword = process.argv[2] || "pool cleaner";
const username = process.argv[3] || "natgeo";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const context = browser.contexts()[0];
const page =
  context.pages().find((p) => !p.isClosed() && p.url().includes("instagram.com")) ||
  (await context.newPage());

const hits = [];
page.on("request", (req) => {
  const url = req.url();
  if (!url.includes("instagram.com")) return;
  if (!url.includes("/api/") && !url.includes("/graphql")) return;
  hits.push({ method: req.method(), url: url.split("?")[0].replace(/^https?:\/\/[^/]+/, "") + (url.includes("?") ? "?" + url.split("?")[1].slice(0, 80) : "") });
});

if (!page.url().includes("instagram.com")) {
  await page.goto("https://www.instagram.com/", { waitUntil: "commit", timeout: 60000 });
}
await page.waitForTimeout(2000);

const searchUrl = `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`;
await page.goto(searchUrl, { waitUntil: "commit", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.evaluate(() => window.scrollBy(0, 600));
await page.waitForTimeout(2000);

const searchHits = [...hits];
hits.length = 0;

await page.goto(`https://www.instagram.com/${username}/reels/`, { waitUntil: "commit", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);
await page.evaluate(() => window.scrollBy(0, 800));
await page.waitForTimeout(2000);

console.log(JSON.stringify({ searchHits: searchHits.slice(0, 25), reelsHits: hits.slice(0, 25) }, null, 2));
await browser.close().catch(() => {});
