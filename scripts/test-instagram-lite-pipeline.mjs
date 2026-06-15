#!/usr/bin/env node
/**
 * Instagram Lite 全流程测试 + Standard 基线对比（无需重跑 Standard）
 *
 * 用法:
 *   SCRAPER_MODE=lite node scripts/test-instagram-lite-pipeline.mjs "pool cleaner" 3
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
process.env.LITE_DISABLE_SCREENSHOTS = process.env.LITE_DISABLE_SCREENSHOTS || "true";
process.env.ENRICH_BATCH_POLICY = process.env.ENRICH_BATCH_POLICY || "false";
process.env.SEARCH_MAX_POOL_SIZE = process.env.SEARCH_MAX_POOL_SIZE || "80";
process.env.IG_LITE_SEARCH_MAX_PAGES = process.env.IG_LITE_SEARCH_MAX_PAGES || "12";
process.env.IG_LITE_SEARCH_DELAY_MS = process.env.IG_LITE_SEARCH_DELAY_MS || "120";
process.env.LITE_IG_ENRICH_CONCURRENCY = process.env.LITE_IG_ENRICH_CONCURRENCY || "1";

const keyword = process.argv[2] || "pool cleaner";
const maxEnrich = Math.min(Number(process.argv[3] || 3), 8);
const enrichNoAnalyze = process.env.ENRICH_NO_ANALYZE === "1";

const STANDARD_BASELINE = {
  search: {
    gotoMs: 18_000,
    settleMs: 3_000,
    scrollRounds: 8,
    scrollWaitMs: 2_000,
    estimatedPageLoads: 1,
    estimatedTrafficMb: "6–20",
    estimatedSeconds: "45–90",
  },
  enrichPerProfile: {
    gotoProfileMs: 30_000,
    gotoReelsMs: 30_000,
    aboutMenuMs: 12_000,
    scrollRounds: 15,
    maxReels: 50,
    estimatedPageLoads: 3,
    estimatedTrafficMb: "8–25",
    estimatedSeconds: "120–300",
  },
  liteDesign: {
    search: "1 次搜索导航 + GraphQL 翻页（无滚动）",
    enrich: "profile API + About 账户 + GraphQL 翻页/滚动兜底至 50 Reels",
    maxReels: 50,
    blockResources: "image/media/font",
  },
  notes: "Standard 基线由 goto/scroll/about 参数推算；Lite 为本次实测。",
};

async function ensureCdp() {
  try {
    const r = await fetch(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222/json/version");
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await ensureCdp())) {
  console.error("[ig-lite-test] CDP 9222 未就绪");
  process.exit(2);
}

console.log("=".repeat(72));
console.log(`[ig-lite-test] SCRAPER_MODE=lite keyword="${keyword}" maxEnrich=${maxEnrich}`);
console.log("=".repeat(72));

const t0 = Date.now();

const { searchAndExtractInfluencers } = await import(
  "../lib/tools/influencer-functions/search-and-extract-influencers.js"
);

const result = await searchAndExtractInfluencers(
  {
    keywords: { search_queries: [keyword] },
    platform: "instagram",
    platforms: ["Instagram"],
    campaignInfo: { platform: ["Instagram"], countries: ["US"] },
    productInfo: { productName: "Lite pipeline test" },
    influencerProfile: enrichNoAnalyze
      ? null
      : { followerRange: "10K-500K", contentStyle: "lifestyle review" },
  },
  {
    maxResults: maxEnrich + 5,
    maxEnrichCount: maxEnrich,
    enrichProfileData: true,
    platform: "instagram",
  }
);

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
const influencers = result.influencers || [];

const liteReport = {
  mode: "lite",
  platform: "instagram",
  keyword,
  maxEnrich,
  elapsedSec: Number(elapsedSec),
  success: false,
  influencerCount: influencers.length,
  channels: influencers.slice(0, maxEnrich).map((inf) => ({
    username: inf.username,
    country: inf.video_publish_country ?? inf.profile_data?.videoPublishCountry ?? null,
    videos: inf.profile_data?.videos?.length ?? 0,
    avgViews: inf.profile_data?.statistics?.avgViews ?? null,
    avgLikes: inf.profile_data?.statistics?.avgLikes ?? null,
    avgComments: inf.profile_data?.statistics?.avgComments ?? null,
    followers: inf.profile_data?.userInfo?.followers?.display ?? inf.followers,
    extractionSource: inf.profile_data?.extractionSource ?? null,
    reelsSource: inf.profile_data?.interceptedCounts?.scrollRoundsUsed === "fallback"
      ? "scroll_fallback"
      : "graphql",
  })),
  standardBaselineComparison: {
    standardEstimatedTotalSec: `${45 + maxEnrich * 120}–${90 + maxEnrich * 300}`,
    liteMeasuredSec: elapsedSec,
    speedupEstimate: `约 ${(120 / Math.max(Number(elapsedSec), 1)).toFixed(1)}–${(240 / Math.max(Number(elapsedSec), 1)).toFixed(1)}×（相对 Standard 推算）`,
    standardTrafficPerTaskMb: `${6 + maxEnrich * 8}–${20 + maxEnrich * 25}`,
    liteTrafficEstimateMb: "约 1–6（instagram.com 引导 + REST/GraphQL JSON）",
    trafficSavingEstimate: "约 85–95%",
    baseline: STANDARD_BASELINE,
  },
};

const TARGET_REELS = Math.min(
  Math.max(Number(process.env.IG_REELS_MAX_VIDEOS || 50) || 50, 1),
  80
);
const MIN_REELS_OK = Math.min(TARGET_REELS, Math.max(35, TARGET_REELS - 10));

liteReport.success =
  result.success &&
  influencers.length > 0 &&
  liteReport.channels.length >= Math.min(maxEnrich, 1) &&
  liteReport.channels.every((c) => {
    const reels = c.videos || 0;
    if (reels >= MIN_REELS_OK) return true;
    // 国家不符被预筛跳过时允许 0 条 Reels
    if (reels === 0 && c.country && c.country !== "US") return true;
    return false;
  });
const ok = liteReport.success;

const logsDir = path.join(root, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const outPath = path.join(
  logsDir,
  `instagram-lite-test-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);
fs.writeFileSync(outPath, JSON.stringify(liteReport, null, 2), "utf-8");

console.log("\n--- Lite 实测结果 ---");
console.log(`耗时: ${elapsedSec}s`);
console.log(`成功: ${ok}`);
console.log(`红人数: ${influencers.length}`);
for (const c of liteReport.channels) {
  console.log(
    `  @${c.username} country=${c.country || "(空)"} reels=${c.videos}/${TARGET_REELS} ` +
      `avgViews=${c.avgViews ?? "n/a"} followers=${c.followers || "?"} source=${c.extractionSource || "?"}`
  );
}

console.log("\n--- vs Standard 基线（无需重跑原版）---");
console.log(`Standard 推算耗时: ${liteReport.standardBaselineComparison.standardEstimatedTotalSec}s`);
console.log(`Lite 实测耗时:     ${elapsedSec}s`);
console.log(`提速估算:        ${liteReport.standardBaselineComparison.speedupEstimate}`);
console.log(`Standard 推算流量: ${liteReport.standardBaselineComparison.standardTrafficPerTaskMb} MB/任务`);
console.log(`Lite 估算流量:     ${liteReport.standardBaselineComparison.liteTrafficEstimateMb}`);
console.log(`省流估算:        ${liteReport.standardBaselineComparison.trafficSavingEstimate}`);
console.log(`\n报告已写入: ${outPath}`);

process.exit(ok ? 0 : 1);
