#!/usr/bin/env node
/**
 * 单平台 Lite 冒烟：搜索 20 人 + enrich/分析 10 人
 * 用法: node scripts/run-lite-platform-smoke.mjs tiktok "pool cleaner"
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const platform = String(process.argv[2] || "tiktok").toLowerCase();
const keyword = process.argv[3] || (platform === "youtube" ? "cat litter review" : "pool cleaner");
const searchPool = Math.min(Number(process.argv[4] || 20), 40);
const maxEnrich = Math.min(Number(process.argv[5] || 10), 20);

process.env.SCRAPER_MODE = "lite";
process.env.LITE_DISABLE_SCREENSHOTS = "true";
process.env.ENRICH_BATCH_POLICY = "false";
process.env.SEARCH_MAX_POOL_SIZE = String(searchPool);
process.env.CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
process.env.CDP_ENDPOINT_ENRICH = process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223";

const PLATFORM_CFG = {
  tiktok: {
    slug: "tiktok",
    platforms: ["TikTok"],
    countries: ["US", "GB", "CA"],
    need9223: true,
  },
  instagram: {
    slug: "instagram",
    platforms: ["Instagram"],
    countries: ["US", "GB"],
    need9223: false,
  },
  youtube: {
    slug: "youtube",
    platforms: ["YouTube"],
    countries: ["US", "GB"],
    need9223: false,
  },
};

const cfg = PLATFORM_CFG[platform];
if (!cfg) {
  console.error(`unknown platform: ${platform}`);
  process.exit(2);
}

async function cdpOk(url) {
  try {
    const r = await fetch(`${url}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

const navLog = [];
function trackNavigation(label, url) {
  const u = String(url || "");
  if (!u || u === "about:blank") return;
  const isApiOnly =
    u.includes("/api/") ||
    u.includes("/youtubei/v1/") ||
    u.includes("graphql") ||
    u.includes("/i/api/");
  const entry = { label, url: u.slice(0, 200), apiOnly: isApiOnly };
  navLog.push(entry);
  if (!isApiOnly && !u.includes("tiktok.com/favicon")) {
    console.warn(`[nav] ${label}: ${u.slice(0, 120)}`);
  }
}

if (!(await cdpOk(process.env.CDP_ENDPOINT))) {
  console.error(`CDP 9222 down: ${process.env.CDP_ENDPOINT}`);
  process.exit(2);
}
if (cfg.need9223 && !(await cdpOk(process.env.CDP_ENDPOINT_ENRICH))) {
  console.error(`CDP 9223 down: ${process.env.CDP_ENDPOINT_ENRICH}`);
  process.exit(2);
}

console.log("=".repeat(72));
console.log(`[lite-smoke] platform=${platform} keyword="${keyword}" pool=${searchPool} enrich=${maxEnrich}`);
console.log(`  SCRAPER_MODE=${process.env.SCRAPER_MODE}`);
console.log(`  search CDP: ${process.env.CDP_ENDPOINT}`);
if (cfg.need9223) console.log(`  enrich CDP: ${process.env.CDP_ENDPOINT_ENRICH}`);
console.log("=".repeat(72));

const t0 = Date.now();
const { searchAndExtractInfluencers } = await import(
  "../lib/tools/influencer-functions/search-and-extract-influencers.js"
);

const result = await searchAndExtractInfluencers(
  {
    keywords: { search_queries: [keyword] },
    platform: cfg.slug,
    platforms: cfg.platforms,
    countries: cfg.countries,
    campaignInfo: { platform: cfg.platforms, targetCountries: cfg.countries },
    productInfo: { productName: `Lite smoke ${platform}` },
    influencerProfile: { followerRange: "10K-500K", contentStyle: "product review" },
  },
  {
    maxResults: searchPool,
    maxEnrichCount: maxEnrich,
    enrichProfileData: true,
    platform: cfg.slug,
  }
);

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
const influencers = result?.influencers || [];

const report = {
  platform,
  keyword,
  searchPool,
  maxEnrich,
  elapsedSec: Number(elapsedSec),
  success: false,
  searchCount: influencers.length,
  channels: influencers.slice(0, maxEnrich).map((inf) => ({
    username: inf.username,
    country: inf.video_publish_country ?? inf.profile_data?.videoPublishCountry ?? inf.profile_data?.userInfo?.country ?? null,
    followers: inf.profile_data?.userInfo?.followers?.display ?? inf.followers?.display ?? null,
    email: inf.profile_data?.userInfo?.email ?? inf.email ?? null,
    bio: inf.profile_data?.userInfo?.bio ? String(inf.profile_data.userInfo.bio).slice(0, 80) : null,
    videos: inf.profile_data?.videos?.length ?? inf.videos?.length ?? 0,
    avgViews: inf.profile_data?.statistics?.avgViews ?? null,
    recommended: inf.isRecommended ?? null,
    matchScore: inf.matchScore ?? inf.analysisScore ?? null,
    extractionSource: inf.profile_data?.extractionSource ?? inf.profile_data?.extractMode ?? null,
    secUid: inf.tiktokSecUid || inf.secUid || null,
    enrichError: inf.profile_data?.error ?? inf.enrich_error ?? null,
  })),
  navigationWarnings: navLog.filter((n) => !n.apiOnly).length,
};

const enrichedOk = report.channels.filter(
  (c) => (c.videos || 0) > 0 && !c.enrichError
).length;
const withCountry = report.channels.filter((c) => c.country).length;
const withEmail = report.channels.filter((c) => c.email).length;
const withAnalysis = report.channels.filter((c) => c.recommended != null || c.matchScore != null).length;

report.success =
  result?.success &&
  report.searchCount >= Math.min(5, searchPool) &&
  enrichedOk >= Math.min(3, maxEnrich);

const logsDir = path.join(root, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const outPath = path.join(
  logsDir,
  `lite-smoke-${platform}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

console.log("\n--- 结果摘要 ---");
console.log(`平台: ${platform}`);
console.log(`关键词: ${keyword}`);
console.log(`搜索红人数: ${report.searchCount}`);
console.log(`enrich 成功(有视频): ${enrichedOk}/${maxEnrich}`);
console.log(`有国家: ${withCountry}/${report.channels.length}`);
console.log(`有邮箱: ${withEmail}/${report.channels.length}`);
console.log(`有画像分析: ${withAnalysis}/${report.channels.length}`);
console.log(`耗时: ${elapsedSec}s`);
console.log(`成功: ${report.success}`);

for (const c of report.channels) {
  console.log(
    `  @${c.username} country=${c.country || "-"} videos=${c.videos} email=${c.email || "-"} ` +
      `recommended=${c.recommended} source=${c.extractionSource || "-"} err=${c.enrichError || "-"}`
  );
}
console.log(`\n报告: ${outPath}`);

process.exit(report.success ? 0 : 1);
