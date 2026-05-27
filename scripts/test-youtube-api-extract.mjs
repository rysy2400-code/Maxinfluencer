/**
 * 测试 YouTube API 拦截 vs 纯 API
 * YT_EXTRACT_MODE=api_first|initial_only 可覆盖默认 api_only
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const mode = process.env.YT_EXTRACT_MODE || "api_only";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

console.log(`[test-yt-api] YT_EXTRACT_MODE=${mode}`);

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const page = await browser.contexts()[0].newPage();

const { extractYoutubeSearchResultsFromPageCDP } = await import(
  "../lib/tools/influencer-functions/youtube/extract-youtube-search-results-cdp.js"
);
const { extractYoutubeChannelFromPageCDP } = await import(
  "../lib/tools/influencer-functions/youtube/extract-youtube-channel-cdp.js"
);

const search = await extractYoutubeSearchResultsFromPageCDP(page, "cat litter box", {
  maxChannels: 20,
  scrollRounds: 10,
});
console.log("\n[SEARCH]", {
  channels: search.influencerRecords?.length,
  source: search.stats?.extractionSource,
  apiBatches: search.stats?.apiBatches,
});

const channel = await extractYoutubeChannelFromPageCDP(page, "JacksonGalaxy", {
  channelId: "UCheL-cUqfzUB8dfM_rFOfDQ",
});
console.log("\n[CHANNEL]", {
  videos: channel.videos?.length,
  source: channel.extractionSource,
  browseBatches: channel.interceptedCounts?.browseBatches,
  avgViews: channel.statistics?.avgViews,
  country: channel.userInfo?.country,
});

await page.close().catch(() => {});
await browser.close().catch(() => {});

process.exit(search.success && channel.success ? 0 : 1);
