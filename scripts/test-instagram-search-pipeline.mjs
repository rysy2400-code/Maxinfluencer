/**
 * Instagram 搜索 + 单红人 enrich 冒烟测试
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/test-instagram-search-pipeline.mjs "pool cleaner" 3
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const keyword = process.argv[2] || "newyork instagram";
const maxEnrich = Math.min(Number(process.argv[3] || 2), 5);
/** 仅搜索阶段，跳过 enrich+LLM：SEARCH_ONLY=1 */
const searchOnly = process.env.SEARCH_ONLY === "1";
/** 做 enrich 但不做 LLM 画像分析：ENRICH_NO_ANALYZE=1 */
const enrichNoAnalyze = process.env.ENRICH_NO_ANALYZE === "1";
process.env.IG_SEARCH_SCROLL_ROUNDS = process.env.IG_SEARCH_SCROLL_ROUNDS || "4";

const { searchAndExtractInfluencers } = await import(
  "../lib/tools/influencer-functions/search-and-extract-influencers.js"
);

console.log(
  `[test-ig] keyword=${keyword} maxEnrich=${maxEnrich} searchOnly=${searchOnly}`
);

if (searchOnly) {
  const { searchInstagramByKeyword } = await import(
    "../lib/tools/influencer-functions/instagram/search-instagram-by-keyword.js"
  );
  const r = await searchInstagramByKeyword(
    { keywords: { search_queries: [keyword] } },
    { searchOptions: { maxInfluencers: maxEnrich + 3 } }
  );
  console.log("[test-ig] search-only 红人:", r.influencerRecords.length);
  process.exit(r.influencerRecords.length > 0 ? 0 : 1);
}

const result = await searchAndExtractInfluencers(
  {
    keywords: { search_queries: [keyword] },
    platform: "instagram",
    platforms: ["Instagram"],
    campaignInfo: { platform: ["Instagram"], countries: ["US"] },
    productInfo: {},
    influencerProfile: enrichNoAnalyze
      ? null
      : {
          followerRange: "10K-500K",
          contentStyle: "lifestyle",
        },
  },
  {
    maxResults: maxEnrich + 3,
    maxEnrichCount: maxEnrich,
    enrichProfileData: true,
    platform: "instagram",
  }
);

console.log("[test-ig] success:", result.success);
console.log("[test-ig] influencers:", result.influencers?.length ?? 0);
if (result.error) console.error("[test-ig] error:", result.error);
for (const inf of (result.influencers || []).slice(0, maxEnrich)) {
  console.log(
    `  @${inf.username} platform=${inf.platform} country=${inf.video_publish_country ?? "-"} recommended=${inf.isRecommended}`
  );
}

process.exit(result.success ? 0 : 1);
