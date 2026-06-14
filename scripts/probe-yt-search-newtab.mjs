/** Probe with NEW tab (avoid /about tab reuse bug) */
import { chromium } from "playwright";
import { extractYoutubeSearchResultsFromPageCDP } from "../lib/tools/influencer-functions/youtube/extract-youtube-search-results-cdp.js";

const keyword = process.argv[2] || "AI agent no code tool demo";
const browser = await chromium.connectOverCDP(
  process.env.CDP_ENDPOINT || "http://127.0.0.1:9222",
  { timeout: 20000 }
);
const page = await browser.contexts()[0].newPage();
console.log("[probe-newtab] keyword:", keyword);
const r = await extractYoutubeSearchResultsFromPageCDP(page, keyword, {
  maxChannels: 20,
  scrollRounds: 12,
});
console.log(
  JSON.stringify(
    {
      success: r.success,
      channels: r.influencerRecords?.length ?? 0,
      source: r.stats?.extractionSource,
      apiBatches: r.stats?.apiBatches,
      error: r.error,
    },
    null,
    2
  )
);
await page.close().catch(() => {});
await browser.close().catch(() => {});
process.exit(r.success ? 0 : 1);
