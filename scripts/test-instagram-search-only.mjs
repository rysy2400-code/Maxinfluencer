/**
 * 仅 Instagram 关键词搜索（无 enrich/LLM），验证 9222 浏览器是否有可见导航
 * 用法: CDP_ENDPOINT=http://127.0.0.1:9222 IG_SEARCH_SCROLL_ROUNDS=3 node scripts/test-instagram-search-only.mjs "newyork instagram"
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const keyword = process.argv[2] || "newyork instagram";
process.env.IG_SEARCH_SCROLL_ROUNDS = process.env.IG_SEARCH_SCROLL_ROUNDS || "3";

const { searchInstagramByKeyword } = await import(
  "../lib/tools/influencer-functions/instagram/search-instagram-by-keyword.js"
);

console.log(`[test-ig-search-only] keyword=${keyword}`);
const t0 = Date.now();
const result = await searchInstagramByKeyword(
  { keywords: { search_queries: [keyword] } },
  { searchOptions: { maxInfluencers: 8, scrollRounds: 3 } }
);
console.log(
  `[test-ig-search-only] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s — 红人 ${result.influencerRecords.length}, 帖子 ${result.videos.length}`
);
for (const r of result.influencerRecords.slice(0, 5)) {
  console.log(`  @${r.username} posts=${r.search_video_data?.length ?? 0}`);
}
process.exit(result.influencerRecords.length > 0 ? 0 : 1);
