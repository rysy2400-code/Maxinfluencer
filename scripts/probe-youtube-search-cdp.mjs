/**
 * Probe：拦截 YouTube 搜索视频 Tab 的 innertube JSON，存到 logs/ 供分析
 * node scripts/probe-youtube-search-cdp.mjs [keyword]
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const keyword = process.argv[2] || "cat litter box";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const logsDir = path.join(root, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const SEARCH_FILTER_VIDEOS_SP = "EgIQAQ%3D%3D";
const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=${SEARCH_FILTER_VIDEOS_SP}`;

console.log("[probe] CDP:", CDP);
console.log("[probe] keyword:", keyword);
console.log("[probe] url:", searchUrl);

const browser = await chromium.connectOverCDP(CDP, { timeout: 10000 });
const context = browser.contexts()[0];
const pages = context.pages().filter((p) => !p.isClosed());
let page = pages.find((p) => { try { return p.url().includes("youtube.com"); } catch { return false; }});
if (!page) page = await context.newPage();
await page.bringToFront();

const batches = [];
const urls = [];
const handler = async (resp) => {
  const u = resp.url();
  const isYT = u.includes("youtube.com") &&
    (u.includes("/youtubei/") || u.includes("/search?") || u.includes("/browse?") || u.includes("/next?"));
  if (!isYT) return;
  try {
    const text = await resp.text();
    if (!text || (text[0] !== "{" && text[0] !== "[")) return;
    const json = JSON.parse(text);
    urls.push(u.split("?")[0]);
    batches.push({ url: u, json });
  } catch { /* ignore */ }
};

page.on("response", handler);
await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);

// try clicking Videos tab
try {
  const btn = page.locator('button:has-text("Videos"), ytd-search-filter-renderer a:has-text("Videos"), tp-yt-paper-button:has-text("Videos")').first();
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(3000);
    console.log("[probe] clicked Videos tab");
  } else {
    console.log("[probe] Videos tab not visible, skipping");
  }
} catch (e) {
  console.log("[probe] tab click err:", e.message);
}
await page.waitForTimeout(2000);
page.off("response", handler);

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(logsDir, `probe-youtube-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify({ keyword, searchUrl, urls, batches }, null, 2), "utf-8");
console.log(`[probe] intercepted ${batches.length} batches → ${outPath}`);
console.log("[probe] intercepted URLs:", urls.slice(0, 10));

// quick top-level key scan of first batch
if (batches[0]) {
  const topKeys = (obj, depth = 0) => {
    if (depth > 3 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { if (obj[0]) topKeys(obj[0], depth + 1); return; }
    for (const [k, v] of Object.entries(obj)) {
      if (["videoRenderer","channelRenderer","richItemRenderer","contents","items","onResponseReceivedCommands","onResponseReceivedActions"].includes(k)) {
        console.log("  ".repeat(depth) + k, "->", JSON.stringify(v).slice(0, 120));
      }
      if (depth < 3 && typeof v === "object" && v) topKeys(v, depth + 1);
    }
  };
  console.log("\n[probe] key scan first batch:");
  topKeys(batches[0].json);
}

await browser.disconnect();
