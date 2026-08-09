#!/usr/bin/env node
/** 第二轮：定位 9224/9225 失败原因（节点 or 会话）+ 9222 保留登录换设备指纹 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const LOG_PATH = path.join(root, "logs", "probe-tt-session-fix2.log");
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

function extractLoc(html) {
  if (!html || !html.includes(UNI_MARKER)) return null;
  try {
    const start = html.indexOf(UNI_MARKER) + UNI_MARKER.length;
    const end = html.indexOf("</script>", start);
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

async function pageFetchHtml(page, url = VIDEO_URL) {
  return page.evaluate(
    async ({ url }) => {
      const res = await fetch(url, {
        credentials: "include",
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: "https://www.tiktok.com/",
        },
      });
      return await res.text();
    },
    { url }
  );
}

function classify(html) {
  if (!html) return { len: 0, uni: false, loc: null };
  return { len: html.length, uni: html.includes(UNI_MARKER), loc: extractLoc(html) };
}

async function freshViaPort(port) {
  let browser = null;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      proxy: { server: `http://127.0.0.1:${port}` },
      args: ["--disable-gpu", "--no-first-run", "--no-default-browser-check"],
    });
    const page = await browser.newPage();
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    const html = await pageFetchHtml(page);
    log({ exp: `fresh-headless-via-${port}`, ...classify(html) });
  } catch (e) {
    log({ exp: `fresh-headless-via-${port}`, error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function clearCookiesAndHelper(endpoint) {
  const { fetchLocationCreatedFromVideoHtmlRequest } = await import(
    "../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js"
  );
  const browser = await chromium.connectOverCDP(endpoint);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    const before = await pageFetchHtml(page);
    const beforeCookies = await ctx.cookies("https://www.tiktok.com").catch(() => []);
    log({
      exp: `${endpoint}-before-clear`,
      ...classify(before),
      login: beforeCookies.some((c) => c.name === "sessionid"),
    });
    await ctx.clearCookies().catch(() => {});
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    const loc = await fetchLocationCreatedFromVideoHtmlRequest(
      page,
      username,
      videoId
    );
    log({ exp: `${endpoint}-after-clear-helper`, loc });
  } catch (e) {
    log({ exp: `${endpoint}-error`, error: e.message });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function exp9222KeepLoginRotateDevice() {
  const { fetchLocationCreatedFromVideoHtmlRequest } = await import(
    "../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js"
  );
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    const before = await pageFetchHtml(page);
    const cookies = await ctx.cookies("https://www.tiktok.com").catch(() => []);
    log({
      exp: "9222-before",
      ...classify(before),
      login: cookies.some((c) => c.name === "sessionid"),
      n: cookies.length,
    });

    const keep = new Set([
      "sessionid",
      "sessionid_ss",
      "sid_tt",
      "sid_guard",
      "sid_guard_ads",
      "uid_tt",
      "uid_tt_ss",
      "multi_sids",
      "passport_auth_status",
      "passport_auth_status_ss",
      "passport_csrf_token",
      "passport_csrf_token_default",
      "sso_auth_status_ss",
      "sso_auth_status_ads",
      "tt_session_tlb_tag",
      "sid_ucp_v1",
      "ssid_ucp_v1",
      "tt-target-idc-sign",
      "last_login_method",
      "passport_fe_beating_status",
      "store-idc",
      "store-country-code",
      "store-country-code-src",
      "tt-target-idc",
      "store-country-sign",
    ]);
    const remove = cookies.filter((c) => !keep.has(c.name));
    for (const c of remove) {
      await ctx
        .clearCookies({ name: c.name, domain: c.domain, path: c.path })
        .catch(() => {});
    }
    log({
      exp: "9222-removed-cookies",
      removed: remove.map((c) => c.name).join(","),
    });

    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    const afterCookies = await ctx.cookies("https://www.tiktok.com").catch(() => []);
    const loginState = await page
      .evaluate(() => {
        const txt = document.body?.innerText || "";
        return {
          hasLoginBtn: /Log in|Sign up|登录/i.test(txt),
          hasAvatar: !!document.querySelector('[data-e2e="avatar"], [data-e2e="user-icon"]'),
        };
      })
      .catch(() => ({}));
    const after = await pageFetchHtml(page);
    log({
      exp: "9222-after-rotate",
      ...classify(after),
      loginCookie: afterCookies.some((c) => c.name === "sessionid"),
      ...loginState,
    });
    if (!after?.loc) {
      const loc = await fetchLocationCreatedFromVideoHtmlRequest(
        page,
        username,
        videoId
      );
      log({ exp: "9222-after-rotate-helper", loc });
    }
  } catch (e) {
    log({ exp: "9222-error", error: e.stack || e.message });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

log(`=== session-fix2 video=${VIDEO_URL} ===`);
await freshViaPort(7899);
await freshViaPort(7900);
await clearCookiesAndHelper("http://127.0.0.1:9224");
await clearCookiesAndHelper("http://127.0.0.1:9225");
await exp9222KeepLoginRotateDevice();
log("[probe] done");
