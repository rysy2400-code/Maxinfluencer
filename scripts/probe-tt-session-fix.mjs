#!/usr/bin/env node
/**
 * 验证两个方向能否救回被风控的 9222/9223 会话（全程 api-only，无 goto 回退）：
 *
 * A. 换 VPN 节点：切换 base TikTokProxy 组节点后，用 9222 同一登录会话重试页内 fetch
 * B. 刷新匿名会话：清空 9223 cookies 重建设备指纹后重试，并连续 10 次确认稳定性
 *
 * 用法: node scripts/probe-tt-session-fix.mjs [username] [videoId]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = path.join(root, "logs", "probe-tt-session-fix.log");

function log(line) {
  const s = typeof line === "string" ? line : JSON.stringify(line);
  fs.appendFileSync(LOG_PATH, `${s}\n`);
  process.stdout.write(s + "\n");
}

const username = (process.argv[2] || "melissametrano").replace(/^@/, "");
const videoId = process.argv[3] || "7630175471774256415";
const VIDEO_URL = `https://www.tiktok.com/@${username}/video/${videoId}`;

const UNI_MARKER =
  '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">';
const SIGI = 'id="SIGI_STATE"';

function extractLoc(html) {
  if (!html || !html.includes(UNI_MARKER)) return null;
  try {
    const start = html.indexOf(UNI_MARKER) + UNI_MARKER.length;
    const end = html.indexOf("</script>", start);
    if (end < 0) return null;
    const data = JSON.parse(html.slice(start, end));
    const item =
      data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
      data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo
        ?.itemStruct;
    return item?.locationCreated ? String(item.locationCreated) : null;
  } catch {
    return null;
  }
}

function classify(html) {
  if (!html) return { len: 0, uni: false, sigi: false, loc: null };
  return {
    len: html.length,
    uni: html.includes(UNI_MARKER),
    sigi: html.includes(SIGI),
    loc: extractLoc(html),
  };
}

async function pageFetchHtml(page, url = VIDEO_URL, timeoutMs = 15000) {
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
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    },
    { url, timeoutMs }
  );
}

async function baseGroupState() {
  const res = await fetch("http://127.0.0.1:9090/proxies");
  const json = await res.json();
  const group = json?.proxies?.TikTokProxy;
  const allowed = /^(US|JP|GB|ID|MM|TH)0?1$/;
  const alive = Array.isArray(group?.all)
    ? group.all.filter((n) => allowed.test(n) && json.proxies[n]?.alive === true)
    : [];
  return { now: group?.now || group?.fixed || null, alive };
}

async function switchBaseNode(name) {
  const res = await fetch(
    "http://127.0.0.1:9090/proxies/" + encodeURIComponent("TikTokProxy"),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }
  );
  return res.ok;
}

async function expNodeSwitch9222() {
  const st = await baseGroupState();
  log({ exp: "node-state-before", ...st });
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    const before = await pageFetchHtml(page);
    log({ exp: "9222-before-switch", node: st.now, ...classify(before) });

    const candidates = st.alive.filter((n) => n !== st.now);
    for (const node of candidates) {
      const ok = await switchBaseNode(node);
      await new Promise((r) => setTimeout(r, 3000));
      const after = await pageFetchHtml(page);
      log({ exp: "9222-after-switch", node, switchOk: ok, ...classify(after) });
      if (after?.loc) break;
    }
  } finally {
    await switchBaseNode(st.now || "US01").catch(() => {});
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function expRefresh9223() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    const before = await pageFetchHtml(page);
    const ckBefore = await ctx.cookies("https://www.tiktok.com").catch(() => []);
    log({
      exp: "9223-before-clear",
      ...classify(before),
      cookies: ckBefore.map((c) => c.name).join(","),
    });

    await ctx.clearCookies().catch(() => {});
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(3000);
    const after = await pageFetchHtml(page);
    const ckAfter = await ctx.cookies("https://www.tiktok.com").catch(() => []);
    log({
      exp: "9223-after-clear",
      ...classify(after),
      cookies: ckAfter.map((c) => c.name).join(","),
    });

    for (let i = 1; i <= 10; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await pageFetchHtml(page);
      log({ exp: "9223-stability", i, ...classify(r) });
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function expProdHelperAfterRefresh() {
  const { fetchLocationCreatedFromVideoHtmlRequest } = await import(
    "../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js"
  );
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(2000);
    const loc = await fetchLocationCreatedFromVideoHtmlRequest(
      page,
      username,
      videoId
    );
    log({ exp: "9223-prod-helper-after-refresh", loc });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

log(`=== session-fix probe video=${VIDEO_URL} ===`);
await expNodeSwitch9222();
await expRefresh9223();
await expProdHelperAfterRefresh();
log("[probe] done");
