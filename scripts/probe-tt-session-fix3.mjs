#!/usr/bin/env node
/** 第三轮：9222 全清 cookies（登出）验证 + 7900 节点第二支视频 + 43KB 页面内容 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const LOG_PATH = path.join(root, "logs", "probe-tt-session-fix3.log");
const BACKUP_PATH = path.join(root, "logs", "9222-cookie-backup.json");

function log(line) {
  const s = typeof line === "string" ? line : JSON.stringify(line);
  fs.appendFileSync(LOG_PATH, `${s}\n`);
  process.stdout.write(s + "\n");
}

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

async function pageFetchHtml(page, url) {
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

async function freshViaPort(port, videoUrl) {
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
    const html = await pageFetchHtml(page, videoUrl);
    const title = String(html.match(/<title>(.*?)<\/title>/i)?.[1] || "").slice(0, 80);
    log({
      exp: `fresh-headless-via-${port}`,
      len: html.length,
      uni: html.includes(UNI_MARKER),
      loc: extractLoc(html),
      title,
    });
  } catch (e) {
    log({ exp: `fresh-headless-via-${port}`, error: e.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function exp9222FullClear() {
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
    const cookies = await ctx.cookies("https://www.tiktok.com").catch(() => []);
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(cookies, null, 2));
    log({
      exp: "9222-backup-saved",
      n: cookies.length,
      hasSessionid: cookies.some((c) => c.name === "sessionid"),
    });

    await ctx.clearCookies().catch(() => {});
    await page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    const after = await pageFetchHtml(page);
    const afterCookies = await ctx.cookies("https://www.tiktok.com").catch(() => []);
    log({
      exp: "9222-after-full-clear",
      len: after.length,
      uni: after.includes(UNI_MARKER),
      loc: extractLoc(after),
      login: afterCookies.some((c) => c.name === "sessionid"),
    });
    if (!extractLoc(after)) {
      const loc = await fetchLocationCreatedFromVideoHtmlRequest(
        page,
        process.argv[2] || "melissametrano",
        process.argv[3] || "7630175471774256415"
      );
      log({ exp: "9222-after-full-clear-helper", loc });
    }

    // 恢复 cookies，保持生产状态不变
    const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, "utf8"));
    await ctx.addCookies(backup).catch((e) => log({ exp: "9222-restore-error", error: e.message }));
    const restored = await ctx.cookies("https://www.tiktok.com").catch(() => []);
    log({
      exp: "9222-restored",
      n: restored.length,
      hasSessionid: restored.some((c) => c.name === "sessionid"),
    });
  } catch (e) {
    log({ exp: "9222-full-clear-error", error: e.stack || e.message });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

log("=== session-fix3 ===");
await freshViaPort(7900, "https://www.tiktok.com/@benkaluza/video/7671403427729050902");
await exp9222FullClear();
log("[probe] done");
