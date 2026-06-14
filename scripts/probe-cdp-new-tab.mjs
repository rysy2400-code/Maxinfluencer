#!/usr/bin/env node
import { chromium } from "playwright";

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const newTab = await fetch(`${CDP}/json/new?${encodeURIComponent("https://www.instagram.com/")}`, {
  method: "PUT",
});
const target = await newTab.json();
console.log("created:", target.url, target.id);

for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const t = list.find((x) => x.id === target.id);
  console.log("poll", i, t?.url);
  if (t?.url?.includes("instagram.com") && !t.url.startsWith("chrome-error")) break;
}

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const pages = browser.contexts()[0].pages().filter((p) => !p.isClosed());
console.log("playwright pages:", pages.map((p) => p.url()));

for (const p of pages) {
  try {
    const href = await p.evaluate(() => location.href);
    const csrf = await p.evaluate(() => (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || null);
    console.log({ pw: p.url(), href, csrf: csrf ? "yes" : "no" });
  } catch (e) {
    console.log({ pw: p.url(), err: e.message });
  }
}

await browser.close().catch(() => {});
