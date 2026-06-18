#!/usr/bin/env node
/**
 * 测试 3 位 IG 红人 Lite enrich：播放量/点赞/评论 + 是否触发 Reels 滚动
 *
 * 用法:
 *   SCRAPER_MODE=lite node scripts/test-ig-enrich-engagement.mjs user1 user2 user3
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

process.env.SCRAPER_MODE = "lite";
process.env.LITE_DISABLE_SCREENSHOTS = "true";
process.env.IG_LITE_SKIP_REELS_SCROLL = process.env.IG_LITE_SKIP_REELS_SCROLL || "1";

const usernames = process.argv.slice(2).filter(Boolean);
if (usernames.length === 0) {
  usernames.push("natgeo", "thejunglebadger", "nasa");
}

async function ensureCdp() {
  try {
    const r = await fetch(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222/json/version");
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await ensureCdp())) {
  console.error("[ig-enrich-test] CDP 9222 未就绪");
  process.exit(2);
}

const { acquireInstagramCdpPage } = await import("../lib/cdp/cdp-target-page.js");
const { extractInstagramProfileLite } = await import(
  "../lib/tools/influencer-functions/instagram/extract-instagram-profile-lite.js"
);
const { igEngagementCoverage } = await import(
  "../lib/tools/influencer-functions/instagram/ig-video-engagement-enrich.js"
);

const report = {
  testedAt: new Date().toISOString(),
  skipReelsScroll: process.env.IG_LITE_SKIP_REELS_SCROLL === "1",
  channels: [],
};

for (const username of usernames.slice(0, 3)) {
  const t0 = Date.now();
  let page;
  try {
    ({ page } = await acquireInstagramCdpPage(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222"));
    const result = await extractInstagramProfileLite(page, username, {});
    const videos = result.videos || [];
    const withViews = videos.filter((v) => (v.views?.count || 0) > 0).length;
    const withLikes = videos.filter((v) => (v.likes?.count || 0) > 0).length;
    const withComments = videos.filter((v) => (v.comments?.count || 0) > 0).length;
    const scrollUsed = result.interceptedCounts?.scrollRoundsUsed === "fallback";

    report.channels.push({
      username,
      success: result.success,
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
      reels: videos.length,
      avgViews: result.statistics?.avgViews ?? null,
      avgLikes: result.statistics?.avgLikes ?? null,
      avgComments: result.statistics?.avgComments ?? null,
      engagementCoverage: Number(igEngagementCoverage(videos).toFixed(2)),
      withViews,
      withLikes,
      withComments,
      followers: result.userInfo?.followers?.display ?? null,
      extractionSource: result.extractionSource,
      reelsSource: scrollUsed ? "scroll_fallback" : "api_direct",
      scrollUsed,
      sampleVideo: videos[0]
        ? {
            videoId: videos[0].videoId,
            views: videos[0].views?.count ?? 0,
            likes: videos[0].likes?.count ?? 0,
            comments: videos[0].comments?.count ?? 0,
            engagementSource: videos[0].engagementSource ?? null,
          }
        : null,
    });
  } catch (e) {
    report.channels.push({
      username,
      success: false,
      error: e.message,
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    });
  } finally {
    try {
      await page?.dispose?.();
    } catch {
      /* ignore */
    }
  }
}

report.success = report.channels.every(
  (c) =>
    c.success &&
    (c.avgViews != null || c.avgLikes != null || c.avgComments != null) &&
    !c.scrollUsed
);

const logsDir = path.join(root, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const outPath = path.join(
  logsDir,
  `ig-enrich-engagement-test-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

console.log(JSON.stringify(report, null, 2));
console.log(`\n报告: ${outPath}`);
process.exit(report.success ? 0 : 1);
