#!/usr/bin/env node
/** 单独验证生产 fetchLocationCreatedFromVideoHtmlRequest 在“清 cookies 后的 9223”上是否可用 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const username = (process.argv[2] || "melissametrano").replace(/^@/, "");
const videoId = process.argv[3] || "7630175471774256415";
const endpoint = process.argv[4] || "http://127.0.0.1:9223";

for (const ep of ["http://127.0.0.1:9223", "http://127.0.0.1:9224", "http://127.0.0.1:9225"]) {
  const browser = await chromium.connectOverCDP(ep);
  const ctx = browser.contexts()[0];
  const cookies = await ctx.cookies("https://www.tiktok.com").catch(() => []);
  const hasLogin = cookies.some((c) => c.name === "sessionid");
  const hasSvid = cookies.some((c) => c.name === "s_v_web_id");
  console.log(
    `[cookies] ${ep} login=${hasLogin} s_v_web_id=${hasSvid} n=${cookies.length}`
  );
  await browser.close().catch(() => {});
}

const browser = await chromium.connectOverCDP(endpoint);
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
try {
  await page
    .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
    .catch(() => {});
  await page.waitForTimeout(2000);
  const mod = await import(
    "../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js"
  );
  const loc = await mod.fetchLocationCreatedFromVideoHtmlRequest(
    page,
    username,
    videoId
  );
  console.log(`[helper] endpoint=${endpoint} loc=${loc || "NULL"}`);
} catch (e) {
  console.log(`[helper] ERROR endpoint=${endpoint} ${e.stack || e.message}`);
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
