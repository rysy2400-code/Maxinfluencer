#!/usr/bin/env node
import { chromium } from "playwright";

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const ctx = browser.contexts()[0];
const pages = ctx.pages().filter((p) => !p.isClosed());

for (let i = 0; i < pages.length; i++) {
  const p = pages[i];
  let href = null;
  let title = null;
  let cookieLen = null;
  try {
    href = await p.evaluate(() => location.href);
    title = await p.title();
    cookieLen = await p.evaluate(() => document.cookie.length);
  } catch (e) {
    href = `eval_err:${e.message}`;
  }
  console.log(JSON.stringify({ i, playwrightUrl: p.url(), href, title, cookieLen }));
}

await browser.close().catch(() => {});
