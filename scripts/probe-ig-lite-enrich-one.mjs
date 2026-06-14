#!/usr/bin/env node
/**
 * 单账号 Lite enrich 探测（Reels 条数 + 国家 + 互动）
 */
import { acquireInstagramCdpPage } from "../lib/cdp/cdp-target-page.js";
import { extractInstagramProfileLite } from "../lib/tools/influencer-functions/instagram/extract-instagram-profile-lite.js";

const username = process.argv[2] || "thejunglebadger";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

async function waitForHealthyIgTab(endpoint, maxAttempts = 8) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { page } = await acquireInstagramCdpPage(endpoint, { forceNew: i > 0 });
      return page;
    } catch (e) {
      console.warn(`[probe] CDP IG 未就绪 (${i + 1}/${maxAttempts}): ${e.message}`);
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 8000));
      } else {
        throw e;
      }
    }
  }
  throw new Error("CDP IG tab unavailable");
}

console.log("[probe] acquiring CDP page...");
const page = await waitForHealthyIgTab(CDP);
console.log("[probe] page ok, enriching @" + username);

const result = await extractInstagramProfileLite(page, username, {});
console.log(
  JSON.stringify(
    {
      success: result.success,
      username,
      reels: result.videos?.length ?? 0,
      country: result.videoPublishCountry,
      avgViews: result.statistics?.avgViews,
      avgLikes: result.statistics?.avgLikes,
      avgComments: result.statistics?.avgComments,
      followers: result.userInfo?.followers?.display,
      email: result.userInfo?.email,
      source: result.interceptedCounts,
    },
    null,
    2
  )
);

await page.dispose();
