#!/usr/bin/env node
/**
 * X Lite 全流程冒烟测试（搜索 → 保存 → enrich → 邮箱/国家门禁 → LLM 分析）。
 *
 * 用法（X 专属机 9222 已登录 x.com，香港 IP 直连）:
 *   SCRAPER_MODE=lite node scripts/test-x-lite-pipeline.mjs "pool cleaner" 3
 *
 * 环境变量:
 *   X_LITE_SEARCH_MAX_PAGES=8
 *   LITE_X_ENRICH_CONCURRENCY=1
 *   X_LITE_REQUIRE_EMAIL_FOR_ANALYSIS=1
 *   ENRICH_NO_ANALYZE=1  跳过 LLM 分析加快冒烟
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
process.env.SEARCH_MAX_POOL_SIZE = process.env.SEARCH_MAX_POOL_SIZE || "40";
process.env.X_LITE_SEARCH_MAX_PAGES = process.env.X_LITE_SEARCH_MAX_PAGES || "6";
process.env.LITE_X_ENRICH_CONCURRENCY = process.env.LITE_X_ENRICH_CONCURRENCY || "1";
process.env.LITE_X_ENRICH_CONCURRENCY_MAX = process.env.LITE_X_ENRICH_CONCURRENCY_MAX || "1";
process.env.X_LITE_TAB_POOL_SIZE = process.env.X_LITE_TAB_POOL_SIZE || "1";
process.env.X_LITE_EVALUATE_CONCURRENCY = process.env.X_LITE_EVALUATE_CONCURRENCY || "1";
process.env.X_LITE_REQUIRE_EMAIL_FOR_ANALYSIS = process.env.X_LITE_REQUIRE_EMAIL_FOR_ANALYSIS || "1";

const keyword = process.argv[2] || "pool cleaner review";
const maxEnrich = Math.min(Number(process.argv[3] || 3), 10);
const enrichNoAnalyze = process.env.ENRICH_NO_ANALYZE === "1";

async function ensureCdp() {
  try {
    const r = await fetch(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222/json/version");
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await ensureCdp())) {
  console.error("[x-lite-test] CDP 9222 未就绪，请先启动 Chrome 并登录 x.com");
  process.exit(2);
}

console.log("=".repeat(72));
console.log(`[x-lite-test] SCRAPER_MODE=lite keyword="${keyword}" maxEnrich=${maxEnrich}`);
console.log("=".repeat(72));

const t0 = Date.now();

const { searchAndExtractInfluencers } = await import(
  "../lib/tools/influencer-functions/search-and-extract-influencers.js"
);

const result = await searchAndExtractInfluencers(
  {
    keywords: { search_queries: [keyword] },
    platform: "x",
    platforms: ["X"],
    campaignInfo: { platform: ["X"], countries: ["US"] },
    productInfo: { productName: "X Lite pipeline test" },
    influencerProfile: enrichNoAnalyze
      ? null
      : {
          followerRange: "10K-500K",
          contentStyle: "pool cleaning product review",
        },
  },
  {
    maxResults: maxEnrich + 5,
    maxEnrichCount: maxEnrich,
    enrichProfileData: true,
    platform: "x",
  }
);

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
const influencers = result.influencers || [];

const report = {
  mode: "lite",
  platform: "X",
  keyword,
  maxEnrich,
  elapsedSec: Number(elapsedSec),
  success: false,
  influencerCount: influencers.length,
  channels: influencers.slice(0, maxEnrich).map((inf) => ({
    username: inf.username,
    country: inf.video_publish_country ?? inf.profile_data?.country ?? null,
    countrySource: inf.profile_data?.countrySource ?? null,
    tweets: inf.profile_data?.videos?.length ?? inf.videos?.length ?? 0,
    followers: inf.profile_data?.userInfo?.followers?.display ?? inf.followers?.display,
    avgLikes: inf.profile_data?.statistics?.avgLikes ?? null,
    avgComments: inf.profile_data?.statistics?.avgComments ?? null,
    email: inf.profile_data?.userInfo?.email ?? null,
    recommended: inf.isRecommended,
    skippedReason: inf.enrich_skipped_reason ?? null,
    extractionSource: inf.profile_data?.extractionSource ?? null,
  })),
};

report.success =
  result.success &&
  influencers.length > 0 &&
  report.channels.some((c) => (c.tweets || 0) > 0);

const logsDir = path.join(root, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const outPath = path.join(
  logsDir,
  `x-lite-test-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

console.log("\n--- X Lite 实测结果 ---");
console.log(`耗时: ${elapsedSec}s`);
console.log(`成功: ${report.success}`);
console.log(`红人数: ${influencers.length}`);
for (const c of report.channels) {
  console.log(
    `  @${c.username} country=${c.country || "(空)"} src=${c.countrySource || "(空)"} tweets=${c.tweets} avgLikes=${c.avgLikes ?? "n/a"} email=${c.email || "(空)"} rec=${c.recommended} skip=${c.skippedReason || "-"}`
  );
}
console.log(`\n报告已写入: ${outPath}`);

process.exit(report.success ? 0 : 1);
