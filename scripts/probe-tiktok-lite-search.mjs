#!/usr/bin/env node
/** 诊断 TikTok Lite 搜索：msToken + search API 请求捕获 */
import { acquireTiktokCdpPage } from "../lib/cdp/cdp-target-page.js";

const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const keyword = process.argv[2] || "pool cleaner";

const { page } = await acquireTiktokCdpPage(endpoint);
const cookies = await page.evaluate(() => document.cookie || "");
const ms = cookies.match(/msToken=([^;]+)/)?.[1] || null;
console.log("[probe] endpoint", endpoint);
console.log("[probe] pageUrl", page.url());
console.log("[probe] cookieLen", cookies.length, "msToken", ms ? `${ms.slice(0, 24)}...` : "MISSING");

const reqs = [];
page.on("request", (req) => {
  const u = req.url();
  if (u.includes("/api/search/")) reqs.push(u);
});

const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}`;
console.log("[probe] goto", searchUrl);
await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) =>
  console.warn("[probe] goto warn:", e.message)
);
await page.waitForTimeout(18_000);
console.log("[probe] searchApiRequests", reqs.length);
for (const u of reqs.slice(0, 5)) console.log(" ", u.slice(0, 160));
await page.dispose();
