#!/usr/bin/env node
/**
 * TikTok Lite 全流程测试（9222 搜索登录 + 9223 enrich 不登录）
 *
 * 用法:
 *   SCRAPER_MODE=lite node scripts/test-tiktok-lite-pipeline.mjs "pool cleaner" 3
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

process.env.SCRAPER_MODE = "lite";
process.env.LITE_DISABLE_SCREENSHOTS = process.env.LITE_DISABLE_SCREENSHOTS || "true";
process.env.ENRICH_BATCH_POLICY = process.env.ENRICH_BATCH_POLICY || "false";
process.env.SEARCH_MAX_POOL_SIZE = process.env.SEARCH_MAX_POOL_SIZE || "40";
process.env.TT_LITE_SEARCH_DELAY_MS = process.env.TT_LITE_SEARCH_DELAY_MS || "180";
process.env.LITE_TT_ENRICH_CONCURRENCY = process.env.LITE_TT_ENRICH_CONCURRENCY || "1";
process.env.CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
process.env.CDP_ENDPOINT_ENRICH = process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223";

const keyword = process.argv[2] || "pool cleaner";
const maxEnrich = Math.min(Number(process.argv[3] || 3), 8);

const STANDARD_BASELINE = {
  search: {
    gotoMs: 60_000,
    scrollUntilStuck: true,
    estimatedPageLoads: 1,
    estimatedTrafficMb: "8–25",
    estimatedSeconds: "60–180",
  },
  enrichPerProfile: {
    gotoProfileMs: 30_000,
    scrollRounds: 15,
    maxVideos: 50,
    estimatedPageLoads: 1,
    estimatedTrafficMb: "5–20",
    estimatedSeconds: "90–240",
  },
  liteDesign: {
    search: "9222 登录态 bootstrap + /api/search/item/full 翻页（无滚动）",
    enrich: "9223 无登录 + user/detail + post/item_list API（无 @profile goto）",
    maxVideos: 50,
    blockResources: "image/media/font",
  },
};

async function ensureCdp(url, label) {
  try {
    const r = await fetch(`${url}/json/version`);
    return r.ok;
  } catch {
    console.error(`[tt-lite-test] ${label} 未就绪: ${url}`);
    return false;
  }
}

const ok9222 = await ensureCdp(process.env.CDP_ENDPOINT, "CDP 9222");
const ok9223 = await ensureCdp(process.env.CDP_ENDPOINT_ENRICH, "CDP 9223");
if (!ok9222 || !ok9223) {
  console.error("[tt-lite-test] 请先启动 guard-chrome-9222.ps1 与 guard-chrome-9223.ps1");
  process.exit(2);
}

console.log("=".repeat(72));
console.log(
  `[tt-lite-test] SCRAPER_MODE=lite keyword="${keyword}" maxEnrich=${maxEnrich}`
);
console.log(`  search CDP: ${process.env.CDP_ENDPOINT}（登录）`);
console.log(`  enrich CDP: ${process.env.CDP_ENDPOINT_ENRICH}（不登录）`);
console.log("=".repeat(72));

const t0 = Date.now();

const { searchAndExtractInfluencers } = await import(
  "../lib/tools/influencer-functions/search-and-extract-influencers.js"
);

const result = await searchAndExtractInfluencers(
  {
    keywords: { search_queries: [keyword] },
    platform: "tiktok",
    platforms: ["TikTok"],
    campaignInfo: { platform: ["TikTok"] },
    productInfo: { productName: "TikTok Lite pipeline test" },
    influencerProfile: { followerRange: "10K-500K", contentStyle: "lifestyle review" },
  },
  {
    maxResults: maxEnrich + 10,
    maxEnrichCount: maxEnrich,
    enrichProfileData: true,
    platform: "tiktok",
  }
);

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
const influencers = result?.influencers || [];
const enriched = influencers.filter((r) => r.videos?.length || r.profileData?.videos?.length);

console.log("\n" + "=".repeat(72));
console.log("[tt-lite-test] 结果");
console.log("=".repeat(72));
console.log({
  success: result?.success,
  elapsedSec,
  searchInfluencers: influencers.length,
  enrichedWithVideos: enriched.length,
  searchStats: result?.stats?.search || result?.searchStats || null,
});

if (enriched.length) {
  const sample = enriched[0];
  console.log("\n样本红人:", {
    username: sample.username,
    followers: sample.followers?.display || sample.followers?.count,
    videoCount: sample.videos?.length || sample.profileData?.videos?.length || 0,
    userId: sample.tiktokUserId || sample.userId || sample.profileData?.userInfo?.userId,
  });
}

console.log("\n--- Lite vs Standard（设计对比）---");
console.log(JSON.stringify({ standardBaseline: STANDARD_BASELINE, liteMeasuredSec: elapsedSec }, null, 2));

process.exit(result?.success ? 0 : 1);
