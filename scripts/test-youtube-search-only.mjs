/**
 * YouTube 关键词搜索冒烟（需 9222 CDP + 已登录 YouTube）
 * 用法: node scripts/test-youtube-search-only.mjs [keyword]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { searchYoutubeByKeyword } from "../lib/tools/influencer-functions/youtube/search-youtube-by-keyword.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const keyword = process.argv[2] || "ai tool";

const t0 = Date.now();
const result = await searchYoutubeByKeyword(
  { keywords: { search_queries: [keyword] } },
  { searchOptions: { maxChannels: 5, scrollRounds: 6 } }
);
console.log(
  JSON.stringify(
    {
      elapsedMs: Date.now() - t0,
      channels: result.influencerRecords?.length,
      videos: result.videos?.length,
      sample: (result.influencerRecords || []).slice(0, 3).map((r) => ({
        username: r.username,
        channelId: r.userId,
        profileUrl: r.profileUrl,
        platform: r.platform,
      })),
    },
    null,
    2
  )
);
