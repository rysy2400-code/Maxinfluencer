#!/usr/bin/env node
/**
 * TikTok Lite 搜索 API-only 探针（9222 signed /api/search/item/full，无 page.goto 搜索页）
 *   node scripts/probe-tiktok-search-api-only.mjs "AI design tool demo"
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

process.env.TT_LITE_ALLOW_NAV = "0";

const keyword = process.argv[2] || "AI design tool demo";
const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const {
  acquireTiktokApiSession,
  fetchSearchItemFullAll,
} = await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");
const {
  extractVideosFromSearchAPI,
  extractInfluencersFromVideos,
} = await import("../lib/tools/influencer-functions/extract-search-results-cdp.js");

console.log(
  `[search-api-probe] endpoint=${endpoint} keyword="${keyword}" mode=api-only`
);

let session = null;
try {
  session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
  const batches = await fetchSearchItemFullAll(session.page, keyword, { maxPages: 2 });
  const videos = [];
  for (const b of batches) videos.push(...extractVideosFromSearchAPI(b));
  const recs = extractInfluencersFromVideos(videos);
  console.log(
    `[search-api-probe] videos=${videos.length} influencers=${recs.length} batches=${batches.length}`
  );
  if (videos.length >= 5 && recs.length >= 3) {
    console.log("[search-api-probe] PASS");
    process.exit(0);
  }
  console.log("[search-api-probe] FAIL: insufficient results");
  process.exit(1);
} catch (e) {
  console.error("[search-api-probe] FAIL:", e.message);
  process.exit(1);
} finally {
  if (session) await session.dispose();
}
