/**
 * YouTube 搜索 + enrich + 可选 LLM 冒烟
 * 用法:
 *   bash scripts/launch-chrome-remote-debug.sh   # 9222 + 登录 YouTube
 *   node scripts/test-youtube-search-pipeline.mjs "cat litter box" 2
 *   SEARCH_ONLY=1 node scripts/test-youtube-search-pipeline.mjs "pet influencer"
 *   ENRICH_NO_ANALYZE=1 node scripts/test-youtube-search-pipeline.mjs "pet care" 1
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const keyword = process.argv[2] || "cat litter review";
const maxEnrich = Math.min(Number(process.argv[3] || 2), 5);
const searchOnly = process.env.SEARCH_ONLY === "1";
const enrichNoAnalyze = process.env.ENRICH_NO_ANALYZE === "1";

process.env.YT_CHANNEL_MAX_VIDEOS = process.env.YT_CHANNEL_MAX_VIDEOS || "50";
process.env.YT_SEARCH_SCROLL_ROUNDS = process.env.YT_SEARCH_SCROLL_ROUNDS || "6";
process.env.YT_CHANNEL_SCROLL_ROUNDS = process.env.YT_CHANNEL_SCROLL_ROUNDS || "10";

async function ensureCdp() {
  try {
    const r = await fetch("http://127.0.0.1:9222/json/version");
    if (r.ok) return true;
  } catch {
    /* ignore */
  }
  return false;
}

if (!(await ensureCdp())) {
  console.error(
    "[test-yt] CDP 9222 未就绪。请先运行: bash scripts/launch-chrome-remote-debug.sh 并在 Chrome 登录 YouTube"
  );
  process.exit(2);
}

console.log(
  `[test-yt] keyword=${keyword} maxEnrich=${maxEnrich} searchOnly=${searchOnly} enrichNoAnalyze=${enrichNoAnalyze}`
);

if (searchOnly) {
  const { searchYoutubeByKeyword } = await import(
    "../lib/tools/influencer-functions/youtube/search-youtube-by-keyword.js"
  );
  const r = await searchYoutubeByKeyword(
    { keywords: { search_queries: [keyword] } },
    { searchOptions: { maxInfluencers: maxEnrich + 5 } }
  );
  console.log("[test-yt] channels:", r.influencerRecords?.length ?? 0);
  for (const c of (r.influencerRecords || []).slice(0, 5)) {
    console.log(`  @${c.username} UC=${c.userId || c.channelId} ${c.profileUrl}`);
  }
  process.exit(r.influencerRecords?.length > 0 ? 0 : 1);
}

const { searchAndExtractInfluencers } = await import(
  "../lib/tools/influencer-functions/search-and-extract-influencers.js"
);

const result = await searchAndExtractInfluencers(
  {
    keywords: { search_queries: [keyword] },
    platform: "youtube",
    platforms: ["YouTube"],
    campaignInfo: { platform: ["YouTube"] },
    productInfo: { productName: "AutoScooper test" },
    influencerProfile: enrichNoAnalyze
      ? null
      : {
          followerRange: "10K-500K",
          contentStyle: "pet lifestyle review",
        },
  },
  {
    maxResults: maxEnrich + 5,
    maxEnrichCount: maxEnrich,
    enrichProfileData: true,
    platform: "youtube",
  }
);

console.log("[test-yt] success:", result.success);
console.log("[test-yt] influencers:", result.influencers?.length ?? 0);
if (result.error) console.error("[test-yt] error:", result.error);

for (const inf of (result.influencers || []).slice(0, maxEnrich)) {
  const email =
    inf.email ||
    inf.profile_data?.userInfo?.email ||
    "(无邮箱字段)";
  console.log(
    `  @${inf.username} country=${inf.video_publish_country ?? ""} email=${email} recommended=${inf.isRecommended} score=${inf.score ?? "-"}`
  );
  if (inf.analysis) {
    console.log(`    analysis: ${String(inf.analysis).slice(0, 120)}…`);
  }
}

process.exit(result.success ? 0 : 1);
