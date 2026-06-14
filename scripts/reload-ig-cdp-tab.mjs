#!/usr/bin/env node
import { listCdpPageTargets, connectCdpTargetPage } from "../lib/cdp/cdp-target-page.js";

const tabs = await listCdpPageTargets("http://127.0.0.1:9222");
const t = tabs.find((x) => String(x.url || "").includes("instagram.com")) || tabs[0];
if (!t) {
  console.log(JSON.stringify({ error: "NO_TAB" }));
  process.exit(1);
}

const page = await connectCdpTargetPage(t);
await page.goto("https://www.instagram.com/", { waitUntil: "commit" });
await page.waitForTimeout(12000);
await page.reload({ ignoreCache: true });
await page.waitForTimeout(8000);
const href = await page.evaluate(() => location.href);
const title = await page.evaluate(() => document.title);
const body = await page.evaluate(() => (document.body?.innerText || "").slice(0, 200));
await page.dispose();
console.log(JSON.stringify({ href, title, body }, null, 2));
