/**
 * Instagram 完整链路：搜索 + Reels enrich + LLM，输出分析正文
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 node scripts/test-instagram-llm-full.mjs "newyork instagram" 2
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const keyword = process.argv[2] || "newyork instagram";
const maxEnrich = Math.min(Number(process.argv[3] || 2), 5);
process.env.IG_SEARCH_SCROLL_ROUNDS = process.env.IG_SEARCH_SCROLL_ROUNDS || "4";
process.env.IG_REELS_SCROLL_ROUNDS = process.env.IG_REELS_SCROLL_ROUNDS || "8";

const { searchAndExtractInfluencers } = await import(
  "../lib/tools/influencer-functions/search-and-extract-influencers.js"
);

console.log(`[test-ig-llm] keyword=${keyword} maxEnrich=${maxEnrich}`);
const t0 = Date.now();

const result = await searchAndExtractInfluencers(
  {
    keywords: { search_queries: [keyword] },
    platform: "instagram",
    platforms: ["Instagram"],
    campaignInfo: {
      platform: ["Instagram"],
      countries: ["US"],
    },
    productInfo: {
      brandName: "DemoBrand",
      productName: "Pool Robot",
      productType: "Consumer Electronics",
    },
    influencerProfile: {
      followerRange: "10K-500K",
      viewRange: "5K+",
      accountType: "lifestyle / home / tech",
    },
  },
  {
    maxResults: 20,
    maxEnrichCount: maxEnrich,
    enrichProfileData: true,
    platform: "instagram",
  }
);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const report = {
  success: result.success,
  elapsedSec: Number(elapsed),
  keyword,
  maxEnrich,
  error: result.error || null,
  influencers: (result.influencers || []).map((inf) => ({
    username: inf.username,
    platform: inf.platform,
    followers: inf.followers,
    views: inf.views,
    isRecommended: inf.isRecommended,
    score: inf.score,
    reason: inf.reason,
    analysis: inf.analysis || inf.recommendationAnalysis || null,
    video_publish_country: inf.video_publish_country ?? null,
    profileVideoCount: inf.profile_data?.videos?.length ?? null,
    statistics: inf.profile_data?.statistics ?? null,
  })),
};

const logsDir = path.join(root, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const outPath = path.join(
  logsDir,
  `instagram-llm-full-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

console.log(`\n[test-ig-llm] 完成 ${elapsed}s success=${result.success}`);
console.log(`[test-ig-llm] 报告: ${outPath}\n`);

for (const inf of report.influencers) {
  console.log(`${"=".repeat(72)}`);
  console.log(`@${inf.username} | 推荐=${inf.isRecommended} | 分数=${inf.score}`);
  console.log(`粉丝=${inf.followers} | 均播=${inf.views}`);
  if (inf.statistics) {
    console.log(
      `Reels统计: 条数=${inf.statistics.videoCount} 有播放量=${inf.statistics.videosWithPlayCount} avgViews=${inf.statistics.avgViews} avgLikes=${inf.statistics.avgLikes}`
    );
  }
  console.log(`\n【推荐理由】\n${inf.reason || "(无)"}\n`);
  console.log(`【LLM 分析正文】\n${inf.analysis || "(无分析)"}\n`);
}

process.exit(result.success ? 0 : 1);
