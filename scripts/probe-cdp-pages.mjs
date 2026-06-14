#!/usr/bin/env node
import { chromium } from "playwright";

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const listRes = await fetch(`${CDP}/json/list`);
const targets = await listRes.json();
console.log("CDP /json/list:");
for (const t of targets.filter((x) => x.type === "page")) {
  console.log(`  ${t.id} ${t.url}`);
}

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
console.log("Playwright contexts:", browser.contexts().length);
for (let ci = 0; ci < browser.contexts().length; ci++) {
  const pages = browser.contexts()[ci].pages().filter((p) => !p.isClosed());
  console.log(`context[${ci}] pages=${pages.length}`);
  for (const p of pages) console.log(`  ${p.url()}`);
}
await browser.close().catch(() => {});
