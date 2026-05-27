/**
 * 探测 YouTube innertube API：搜索页 / 频道 videos 页在 goto + scroll 时触发的请求
 * node scripts/probe-youtube-innertube-api.mjs [search|channel|both]
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const logsDir = path.join(root, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const mode = process.argv[2] || "both";

function summarizeJson(json) {
  let videoRenderer = 0;
  let gridVideo = 0;
  let richItem = 0;
  let lockup = 0;
  let channelRenderer = 0;
  let continuation = 0;
  const walk = (obj, d = 0) => {
    if (d > 25 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, d + 1));
      return;
    }
    if (obj.videoRenderer) videoRenderer++;
    if (obj.gridVideoRenderer) gridVideo++;
    if (obj.richItemRenderer) richItem++;
    if (obj.lockupViewModel) lockup++;
    if (obj.channelRenderer) channelRenderer++;
    if (obj.continuationItemRenderer) continuation++;
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v) walk(v, d + 1);
    }
  };
  walk(json);
  return { videoRenderer, gridVideo, richItem, lockup, channelRenderer, continuation };
}

async function attachCollector(page, label) {
  const hits = [];
  const handler = async (response) => {
    const u = response.url();
    const method = response.request().method();
    if (!u.includes("youtube.com")) return;
    const isInnertube =
      u.includes("/youtubei/v1/") ||
      u.includes("/youtubei/v1?") ||
      (method === "POST" && u.includes("youtube.com") && u.includes("youtubei"));
    if (!isInnertube) return;
    const short = u.replace(/\?.*$/, "").replace("https://www.youtube.com", "");
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      const json = JSON.parse(text);
      const stats = summarizeJson(json);
      const useful =
        stats.videoRenderer +
          stats.gridVideo +
          stats.richItem +
          stats.lockup +
          stats.channelRenderer >
        0;
      hits.push({
        label,
        short,
        method,
        status: response.status(),
        bytes: text.length,
        useful,
        stats,
      });
      if (useful) {
        const ts = Date.now();
        fs.writeFileSync(
          path.join(logsDir, `probe-innertube-${label}-${short.replace(/\//g, "_")}-${ts}.json`),
          text.slice(0, 500000),
          "utf-8"
        );
      }
    } catch {
      hits.push({ label, short, method, status: response.status(), error: "parse_fail" });
    }
  };
  page.on("response", handler);
  return () => page.off("response", handler);
}

async function probeSearch(page) {
  console.log("\n========== SEARCH ==========");
  const url =
    "https://www.youtube.com/results?search_query=cat%20litter%20box&sp=EgIQAQ%3D%3D";
  const off = attachCollector(page, "search");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  console.log("[search] after goto");
  for (let i = 1; i <= 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(2500);
    console.log(`[search] after scroll ${i}`);
  }
  off();
  return hits => hits;
}

async function probeChannel(page) {
  console.log("\n========== CHANNEL /videos ==========");
  const url = "https://www.youtube.com/@JacksonGalaxy/videos";
  const off = attachCollector(page, "channel");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  console.log("[channel] after goto");
  for (let i = 1; i <= 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(2200);
    console.log(`[channel] after scroll ${i}`);
  }
  off();
}

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const context = browser.contexts()[0];
const page = await context.newPage();
await page.bringToFront();

const allHits = [];
const wrapCollector = (label) => {
  const handler = async (response) => {
    const u = response.url();
    const method = response.request().method();
    if (!u.includes("youtube.com")) return;
    if (!u.includes("/youtubei/v1/")) return;
    const short = u.replace(/\?.*$/, "").replace("https://www.youtube.com", "");
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      const json = JSON.parse(text);
      const stats = summarizeJson(json);
      const useful =
        stats.videoRenderer +
          stats.gridVideo +
          stats.richItem +
          stats.lockup +
          stats.channelRenderer >
        0;
      allHits.push({ phase: label, short, method, useful, stats, bytes: text.length });
      if (useful) {
        fs.writeFileSync(
          path.join(
            logsDir,
            `probe-innertube-${label}-${short.replace(/\//g, "_")}-${Date.now()}.json`
          ),
          text.slice(0, 800000),
          "utf-8"
        );
      }
    } catch {
      allHits.push({ phase: label, short, method, error: true });
    }
  };
  page.on("response", handler);
  return () => page.off("response", handler);
};

if (mode === "search" || mode === "both") {
  const off = wrapCollector("search-goto");
  await page.goto(
    "https://www.youtube.com/results?search_query=cat%20litter%20box&sp=EgIQAQ%3D%3D",
    { waitUntil: "domcontentloaded", timeout: 90000 }
  );
  await page.waitForTimeout(5000);
  off();
  const offScroll = wrapCollector("search-scroll");
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 1400));
    await page.waitForTimeout(2800);
  }
  offScroll();
}

if (mode === "channel" || mode === "both") {
  const off = wrapCollector("channel-goto");
  await page.goto("https://www.youtube.com/@JacksonGalaxy/videos", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(5000);
  off();
  const offScroll = wrapCollector("channel-scroll");
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(2500);
  }
  offScroll();
}

// dedupe summary
const byEndpoint = new Map();
for (const h of allHits) {
  const k = `${h.phase}|${h.short}`;
  if (!byEndpoint.has(k)) byEndpoint.set(k, h);
}

console.log("\n========== SUMMARY ==========");
const useful = [...byEndpoint.values()].filter((h) => h.useful);
const all = [...byEndpoint.values()];
console.log(`Total innertube responses: ${all.length}, useful (has video/channel data): ${useful.length}`);
for (const h of all.sort((a, b) => (a.short > b.short ? 1 : -1))) {
  console.log(
    `${h.phase.padEnd(14)} ${h.method || "?"} ${h.short} useful=${!!h.useful} stats=${JSON.stringify(h.stats || {})} bytes=${h.bytes || 0}`
  );
}

const outPath = path.join(logsDir, `probe-innertube-summary-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify({ allHits, useful }, null, 2));
console.log("\nWrote", outPath);

await page.close().catch(() => {});
await browser.close().catch(() => {});
