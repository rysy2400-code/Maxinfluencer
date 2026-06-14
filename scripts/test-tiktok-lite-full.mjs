#!/usr/bin/env node
/**
 * TikTok Lite 完整测试（大搜索池 + 国家批次 + enrich，跳过 LLM）
 *
 * 用法:
 *   node scripts/test-tiktok-lite-full.mjs "pool cleaner"
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

process.env.SCRAPER_MODE = "lite";
process.env.SKIP_LLM = "1";
process.env.SKIP_LLM_ANALYSIS = "1";
process.env.LITE_DISABLE_SCREENSHOTS = "true";
process.env.SEARCH_MAX_POOL_SIZE = process.env.SEARCH_MAX_POOL_SIZE || "500";
process.env.TT_LITE_SEARCH_MAX_PAGES = process.env.TT_LITE_SEARCH_MAX_PAGES || "30";
process.env.TT_LITE_SEARCH_COUNT = process.env.TT_LITE_SEARCH_COUNT || "30";
process.env.COUNTRY_BATCH_SIZE = process.env.COUNTRY_BATCH_SIZE || "20";
process.env.COUNTRY_BATCH_STOP_ON_ZERO = "true";
process.env.ENRICH_BATCH_POLICY = process.env.ENRICH_BATCH_POLICY || "true";
process.env.ENRICH_BATCH_SIZE = process.env.ENRICH_BATCH_SIZE || "20";
process.env.ENRICH_BATCH_ZERO_STREAK = "1";
process.env.TT_LITE_SEARCH_MIN_POOL = process.env.TT_LITE_SEARCH_MIN_POOL || "80";
process.env.TT_LITE_ALLOW_NAV = process.env.TT_LITE_ALLOW_NAV || "1";
process.env.TT_LITE_COUNTRY_CDP = process.env.TT_LITE_COUNTRY_CDP || process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
process.env.CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
process.env.CDP_ENDPOINT_ENRICH = process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223";

const keyword = process.argv[2] || "pool cleaner";
const countries = (process.argv[3] || "US,GB,CA,AU").split(",").map((s) => s.trim());

async function ensureCdp(url, label) {
  try {
    return (await fetch(`${url}/json/version`)).ok;
  } catch {
    console.error(`[tt-lite-full] ${label} down: ${url}`);
    return false;
  }
}

if (!(await ensureCdp(process.env.CDP_ENDPOINT, "9222"))) process.exit(2);
if (!(await ensureCdp(process.env.CDP_ENDPOINT_ENRICH, "9223"))) process.exit(2);

console.log("=".repeat(72));
console.log(`[tt-lite-full] keyword="${keyword}" countries=${countries.join(",")}`);
console.log(`  searchPool=${process.env.SEARCH_MAX_POOL_SIZE} pages=${process.env.TT_LITE_SEARCH_MAX_PAGES}`);
console.log(`  countryBatch=${process.env.COUNTRY_BATCH_SIZE} skipLLM=1`);
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
    campaignInfo: {
      platform: ["TikTok"],
      targetCountries: countries,
      countries,
    },
    countries,
    productInfo: { productName: "TikTok Lite full test" },
    influencerProfile: { followerRange: "10K-500K", contentStyle: "review" },
  },
  {
    maxResults: Number(process.env.SEARCH_MAX_POOL_SIZE),
    enrichProfileData: true,
    platform: "tiktok",
  }
);

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
const influencers = result?.influencers || [];
const enriched = influencers.filter(
  (r) =>
    (r.profile_data?.videos?.length || r.videos?.length || 0) > 0 ||
    r.profile_data?.userInfo?.followers ||
    r.followers
);
const withCountry = influencers.filter(
  (r) => r.video_publish_country || r.profile_data?.videoPublishCountry
);
const withExplicitCountry = influencers.filter((r) => {
  const c = r.video_publish_country || r.profile_data?.videoPublishCountry;
  return c && countries.includes(String(c).toUpperCase());
});

const report = {
  success: !!result?.success,
  elapsedSec: Number(elapsedSec),
  searchPool: influencers.length,
  enrichedCount: enriched.length,
  withCountry: withCountry.length,
  explicitCountryMatch: withExplicitCountry.length,
  withVideos: enriched.filter(
    (r) => (r.profile_data?.videos?.length || r.videos?.length || 0) > 0
  ).length,
  withEmail: enriched.filter(
    (r) => r.profile_data?.userInfo?.email || r.profile_data?.email || r.email
  ).length,
  stats: result?.stats || null,
  countryFilter: result?.stats?.countryFilter || null,
  samples: enriched.slice(0, 5).map((r) => ({
    username: r.username,
    country: r.video_publish_country || r.profile_data?.videoPublishCountry || null,
    followers:
      r.profile_data?.userInfo?.followers?.display ||
      r.followers?.display ||
      r.followers ||
      null,
    videos: r.profile_data?.videos?.length || r.videos?.length || 0,
    email: r.profile_data?.userInfo?.email || r.email || null,
  })),
};

console.log("\n" + JSON.stringify(report, null, 2));

  const pass =
  report.success &&
  report.searchPool >= 15 &&
  report.enrichedCount >= 3 &&
  report.withVideos >= 3;

console.log("\n[tt-lite-full] PASS=" + pass);
process.exit(pass ? 0 : 1);
