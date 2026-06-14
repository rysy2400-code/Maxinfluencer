#!/usr/bin/env node
import { chromium } from "playwright";
import { extractIgRelayBootstrap } from "../lib/tools/influencer-functions/instagram/instagram-direct-fetch.js";

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const page = browser.contexts()[0].pages().find((p) => !p.isClosed()) || (await browser.contexts()[0].newPage());
if (!page.url().includes("instagram.com")) {
  await page.goto("https://www.instagram.com/", { waitUntil: "commit", timeout: 60000 });
}
await page.waitForTimeout(3000);
const boot = await extractIgRelayBootstrap(page);
console.log(JSON.stringify(boot, null, 2));
await browser.close().catch(() => {});
