#!/usr/bin/env node
/**
 * Lite 全流程冒烟：关键词搜索 + 国家 + enrich + 画像分析
 *
 * 用法:
 *   node scripts/run-lite-platform-smoke.mjs tiktok "pool cleaner" 20 10
 *   node scripts/run-lite-platform-smoke.mjs instagram "home decor" 20 10
 *   node scripts/run-lite-platform-smoke.mjs youtube "cat litter review" 20 10
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

const platform = String(process.argv[2] || "tiktok").toLowerCase();
const keyword = process.argv[3] || "pool cleaner";
const searchMax = Math.min(Math.max(Number(process.argv[4] || 20), 5), 50);
const enrichMax = Math.min(Math.max(Number(process.argv[5] || 10), 1), 20);

process.env.SEARCH_MAX_POOL_SIZE = String(searchMax);
process.env.CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
if (platform === "tiktok") {
  process.env.CDP_ENDPOINT_ENRICH = process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223";
}

const PLATFORM_META = {
  tiktok: {
    slug: "tiktok",
    label: "TikTok",
    platforms: ["TikTok"],
    searchCdp: "9222（登录，API 搜索）",
    enrichCdp: "9223（不登录，API enrich）",
  },
  instagram: {
    slug: "instagram",
    label: "Instagram",
    platforms: ["Instagram"],
    searchCdp: "9222（登录，GraphQL）",
    enrichCdp: "9222（Lite API）",
  },
  youtube: {
    slug: "youtube",
    label: "YouTube",
    platforms: ["YouTube"],
    searchCdp: "9222（登录，InnerTube）",
    enrichCdp: "9222（Lite API）",
  },
};

const meta = PLATFORM_META[platform];
if (!meta) {
  console.error(`Unknown platform: ${platform}`);
  process.exit(2);
}

async function ensureCdp(url, label) {
  try {
    const r = await fetch(`${url}/json/version`);
    return r.ok;
  } catch {
    console.error(`[lite-smoke] ${label} down: ${url}`);
    return false;
  }
}

const ok9222 = await ensureCdp(process.env.CDP_ENDPOINT, "CDP 9222");
let ok9223 = true;
if (platform === "tiktok") {
  ok9223 = await ensureCdp(process.env.CDP_ENDPOINT_ENRICH, "CDP 9223");
}
if (!ok9222 || !ok9223) process.exit(2);

console.log("=".repeat(72));
console.log(
  `[lite-smoke] platform=${meta.label} keyword="${keyword}" searchMax=${searchMax} enrichMax=${enrichMax}`
);
console.log(`  SCRAPER_MODE=${process.env.SCRAPER_MODE}`);
console.log(`  search: ${meta.searchCdp}`);
console.log(`  enrich: ${meta.enrichCdp}`);
console.log("=".repeat(72));

const t0 = Date.now();
const { searchAndExtractInfluencers } = await import(
  "../lib/tools/influencer-functions/search-and-extract-influencers.js"
);

const result = await searchAndExtractInfluencers(
  {
    keywords: { search_queries: [keyword] },
    platform: meta.slug,
    platforms: meta.platforms,
    campaignInfo: {
      platform: meta.platforms,
      targetCountries: ["US", "GB", "CA", "AU"],
    },
    countries: ["US", "GB", "CA", "AU"],
    productInfo: { productName: `${meta.label} Lite smoke test` },
    influencerProfile: {
      followerRange: "10K-500K",
      contentStyle: "product review lifestyle",
    },
  },
  {
    maxResults: searchMax,
    maxEnrichCount: enrichMax,
    enrichProfileData: true,
    platform: meta.slug,
  }
);

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
const influencers = result?.influencers || [];
const enriched = influencers.filter(
  (r) =>
    r.profile_data?.videos?.length ||
    r.videos?.length ||
    r.profile_data?.userInfo?.followers ||
    r.matchAnalysis ||
    r.recommended != null
);

function pickCountry(r) {
  return (
    r.video_publish_country ??
    r.profile_data?.videoPublishCountry ??
    r.profile_data?.userInfo?.country ??
    r.profile_data?.aboutCountry ??
    null
  );
}

function pickEmail(r) {
  return (
    r.profile_data?.userInfo?.email ??
    r.profile_data?.email ??
    r.email ??
    null
  );
}

const report = {
  platform: meta.slug,
  keyword,
  elapsedSec: Number(elapsedSec),
  success: !!result?.success,
  searchPool: influencers.length,
  enrichedCount: enriched.length,
  withCountry: enriched.filter((r) => pickCountry(r)).length,
  withVideos: enriched.filter(
    (r) => (r.profile_data?.videos?.length || r.videos?.length || 0) > 0
  ).length,
  withEmail: enriched.filter((r) => pickEmail(r)).length,
  withMatchAnalysis: enriched.filter((r) => r.matchAnalysis || r.recommended != null).length,
  samples: enriched.slice(0, 5).map((r) => ({
    username: r.username,
    country: pickCountry(r),
    followers:
      r.profile_data?.userInfo?.followers?.display ??
      r.followers?.display ??
      r.followers ??
      null,
    videos: r.profile_data?.videos?.length ?? r.videos?.length ?? 0,
    email: pickEmail(r),
    recommended: r.recommended ?? r.matchAnalysis?.recommended ?? null,
    score: r.matchScore ?? r.matchAnalysis?.score ?? null,
    extractMode: r.profile_data?.extractMode ?? r.extractMode ?? null,
    error: r.profile_data?.error ?? r.enrichError ?? null,
  })),
  stats: result?.stats ?? null,
};

console.log("\n" + JSON.stringify(report, null, 2));

const pass =
  report.success &&
  report.searchPool >= Math.min(5, searchMax) &&
  report.enrichedCount >= Math.min(3, enrichMax) &&
  report.withCountry >= 1 &&
  report.withVideos >= 1;

console.log("\n[lite-smoke] PASS=" + pass);
process.exit(pass ? 0 : 1);
