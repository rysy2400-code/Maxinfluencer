#!/usr/bin/env node
/**
 * headless 对照测试：判断“视频页 HTML 风控（slardar stub / 无 locationCreated）”
 * 是否由 headless 浏览器引起。
 *
 * 组别（同一视频、同代理）：
 *  A. prod-headed-9222  生产 visible Chrome（已登录，proxy 7897）
 *  B. prod-headed-9223  生产 visible Chrome（未登录，proxy 7898）
 *  C. fresh-headed      Playwright 新起 visible Chrome（proxy 7897）
 *  D. fresh-headless    Playwright 新起 headless Chrome（proxy 7897）
 *
 * 每组两个取数路径：
 *  - fetch: 生产当前 api-only 方式 page.evaluate(fetch(videoUrl))
 *  - nav:   page.goto 视频页后读 UNIVERSAL JSON 的 locationCreated
 *
 * 用法: node scripts/probe-tt-headless-compare.mjs [username] [videoId] [videoId2]
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const LOG_PATH = path.join(root, "logs", "probe-tt-headless-compare.log");

function log(line) {
  const s = typeof line === "string" ? line : JSON.stringify(line);
  fs.appendFileSync(LOG_PATH, `${s}\n`);
  process.stdout.write(s + "\n");
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const UNI_MARKER =
  '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">';
const SLARDAR = "slardar-config";
const SIGI = 'id="SIGI_STATE"';
const FRESH_PROXY = process.env.TT_PROBE_FRESH_PROXY || "http://127.0.0.1:7897";
const SKIP_CDP = process.env.TT_PROBE_SKIP_CDP === "1";

function classify(html) {
  if (!html) return { len: 0, slardar: false, uni: false, sigi: false, loc: null };
  return {
    len: html.length,
    slardar: html.includes(SLARDAR),
    uni: html.includes(UNI_MARKER),
    sigi: html.includes(SIGI),
    loc: extractLoc(html),
  };
}

function extractLoc(html) {
  if (!html || !html.includes(UNI_MARKER)) return null;
  try {
    const start = html.indexOf(UNI_MARKER) + UNI_MARKER.length;
    const end = html.indexOf("</script>", start);
    if (end < 0) return null;
    const data = JSON.parse(html.slice(start, end));
    const item =
      data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
      data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo?.itemStruct;
    return item?.locationCreated ? String(item.locationCreated) : null;
  } catch {
    return null;
  }
}

async function pageFetchHtml(page, url, timeoutMs = 15000) {
  return page.evaluate(
    async ({ url, timeoutMs }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          credentials: "include",
          signal: ctrl.signal,
          headers: {
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            referer: "https://www.tiktok.com/",
          },
        });
        const html = await res.text();
        return { status: res.status, ok: res.ok, html };
      } finally {
        clearTimeout(timer);
      }
    },
    { url, timeoutMs }
  );
}

async function navLoc(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
  } catch {
    /* keep going; try DOM read anyway */
  }
  const afterUrl = page.url();
  const title = await page.title().catch(() => "");
  const dom = await page.evaluate(() => {
    const el = document.querySelector(
      'script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]'
    );
    if (!el?.textContent) return { hasUniversal: false, loc: null };
    try {
      const data = JSON.parse(el.textContent);
      const item =
        data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
        data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo
          ?.itemStruct;
      return {
        hasUniversal: true,
        loc: item?.locationCreated ? String(item.locationCreated) : null,
        id: item?.id ? String(item.id) : null,
      };
    } catch {
      return { hasUniversal: true, loc: null, id: null };
    }
  });
  return { ...dom, afterUrl: String(afterUrl || "").slice(0, 120), title };
}

async function collectFingerprint(page) {
  return page.evaluate(() => ({
    ua: navigator.userAgent,
    webdriver: navigator.webdriver === true,
    plugins: navigator.plugins?.length ?? -1,
    languages: JSON.stringify(navigator.languages),
    platform: navigator.platform,
  }));
}

async function egressIp(page) {
  try {
    return await page.evaluate(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch("https://api.ipify.org?format=json", {
          signal: ctrl.signal,
        });
        const data = await res.json();
        return data.ip;
      } finally {
        clearTimeout(timer);
      }
    });
  } catch {
    return "n/a";
  }
}

async function runPageSuite(page, label, videoUrl) {
  const fp = await collectFingerprint(page).catch(() => ({}));
  const ip = await egressIp(page).catch(() => "n/a");
  const fetchRes = await pageFetchHtml(page, videoUrl).catch((e) => ({
    error: e.message,
  }));
  const nav = await navLoc(page, videoUrl).catch((e) => ({ error: e.message }));
  log(
    JSON.stringify({
      group: label,
      video: videoUrl,
      webdriver: fp.webdriver,
      plugins: fp.plugins,
      ip,
      uaTail: String(fp.ua || "").slice(0, 70),
      fetch: fetchRes.error ? { error: fetchRes.error } : classify(fetchRes.html),
      nav,
    })
  );
}

async function probeCdp(label, endpoint, videoUrl) {
  const browser = await chromium.connectOverCDP(endpoint);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(2000);
    await runPageSuite(page, label, videoUrl);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function probeFresh(label, headless, proxy, videoUrl) {
  let browser = null;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless,
      proxy: { server: proxy },
      args: ["--disable-gpu", "--no-first-run", "--no-default-browser-check"],
    });
    const ctx = await browser.newContext({ locale: "en-US" });
    const page = await ctx.newPage();
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    await runPageSuite(page, label, videoUrl);
  } catch (e) {
    log(JSON.stringify({ group: label, launchError: e.message }));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const args = process.argv.slice(2);
const samples = [];
if (args.length >= 2) {
  samples.push({
    username: args[0].replace(/^@/, ""),
    videoId: args[1],
  });
  if (args[2]) samples.push({ username: args[0], videoId: args[2] });
} else {
  samples.push({ username: "benkaluza", videoId: "7671403427729050902" });
  samples.push({ username: "melissametrano", videoId: "7630175471774256415" });
}

for (const s of samples) {
  const videoUrl = `https://www.tiktok.com/@${s.username}/video/${s.videoId}`;
  log(`=== ${videoUrl} ===`);
  if (!SKIP_CDP) {
    await withTimeout(
      probeCdp("prod-headed-9222(logged-in)", "http://127.0.0.1:9222", videoUrl),
      150000,
      "prod-9222"
    ).catch((e) => log({ group: "prod-9222", error: e.message }));
    await withTimeout(
      probeCdp("prod-headed-9223(anon)", "http://127.0.0.1:9223", videoUrl),
      150000,
      "prod-9223"
    ).catch((e) => log({ group: "prod-9223", error: e.message }));
  }
  await withTimeout(
    probeFresh("fresh-headed", false, FRESH_PROXY, videoUrl),
    150000,
    "fresh-headed"
  ).catch((e) => log({ group: "fresh-headed", error: e.message }));
  await withTimeout(
    probeFresh("fresh-headless", true, FRESH_PROXY, videoUrl),
    150000,
    "fresh-headless"
  ).catch((e) => log({ group: "fresh-headless", error: e.message }));
}

log("[probe] done");
