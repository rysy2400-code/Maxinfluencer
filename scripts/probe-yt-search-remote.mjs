/** Remote probe: node scripts/probe-yt-search-remote.mjs "keyword" */
import { chromium } from "playwright";
import { extractYoutubeSearchResultsFromPageCDP } from "../lib/tools/influencer-functions/youtube/extract-youtube-search-results-cdp.js";
import { acquireVisibleCdpPage } from "../lib/tools/influencer-functions/youtube/cdp-page-utils.js";

const keyword = process.argv[2] || "AI agent no code tool demo";
console.log("[probe] keyword:", keyword);
console.log("[probe] YT_EXTRACT_MODE:", process.env.YT_EXTRACT_MODE || "(default)");

const browser = await chromium.connectOverCDP(
  process.env.CDP_ENDPOINT || "http://127.0.0.1:9222",
  { timeout: 20000 }
);
const { page, created } = await acquireVisibleCdpPage(browser.contexts()[0], {
  logPrefix: "[probe]",
});
console.log("[probe] page url before:", page.url(), "created=", created);

const r = await extractYoutubeSearchResultsFromPageCDP(page, keyword, {
  maxChannels: 20,
  scrollRounds: 12,
});

console.log(
  JSON.stringify(
    {
      success: r.success,
      channels: r.influencerRecords?.length ?? 0,
      videos: r.stats?.videoCount,
      source: r.stats?.extractionSource,
      apiBatches: r.stats?.apiBatches,
      error: r.error,
      pageUrlAfter: page.url(),
    },
    null,
    2
  )
);

if (created) await page.close().catch(() => {});
await browser.close().catch(() => {});
process.exit(r.success ? 0 : 1);
