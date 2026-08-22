#!/usr/bin/env node
/**
 * 把 9222 重置为全新匿名设备：
 * - 清空 9222 Chrome 实例全部 cookie（含 ttwid 设备标识）
 * - 清空 tiktok.com 的 localStorage / IndexedDB / CacheStorage
 * - 重载首页让 TikTok 重新下发全新 ttwid/msToken
 * 只影响 9222 端口对应的 Chrome 实例，不影响 9223/9224/9225。
 */
import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 20000 });
try {
  const ctx = b.contexts()[0];
  if (!ctx) {
    console.log("NO_CONTEXT");
    process.exit(1);
  }

  // 1) 清空该浏览器实例全部 cookie（含 ttwid / passport_csrf_token 等设备标识）
  try {
    await ctx.clearCookies();
    console.log("cookies cleared (all domains on 9222 instance)");
  } catch (e) {
    console.log("cookie clear err:", e.message);
  }

  // 2) 在 tiktok.com 页面清 localStorage / IndexedDB / CacheStorage
  let page = ctx.pages().find((p) => String(p.url() || "").includes("tiktok.com"));
  let created = false;
  if (!page) {
    page = await ctx.newPage();
    created = true;
  }
  try {
    await page.goto("https://www.tiktok.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(2500);
  } catch (e) {
    console.log("nav warn:", e.message);
  }
  try {
    const res = await page.evaluate(async () => {
      try { localStorage.clear(); } catch { /* ignore */ }
      try { sessionStorage.clear(); } catch { /* ignore */ }
      try {
        const dbs = await indexedDB.databases();
        for (const db of dbs) indexedDB.deleteDatabase(db.name);
      } catch { /* ignore */ }
      try {
        const names = await caches.keys();
        for (const n of names) await caches.delete(n);
      } catch { /* ignore */ }
      return true;
    });
    console.log("storage cleared:", res);
  } catch (e) {
    console.log("storage clear err:", e.message);
  }
  if (created) await page.close().catch(() => {});
  console.log("RESET_DONE");
} finally {
  await b.close().catch(() => {});
}
process.exit(0);
