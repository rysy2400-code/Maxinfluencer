#!/usr/bin/env node
import { acquireInstagramCdpPage } from "../lib/cdp/cdp-target-page.js";
import {
  extractIgRelayBootstrap,
  fetchKeywordSearchPage,
  fetchWebProfileInfo,
  fetchUserClipsPage,
} from "../lib/tools/influencer-functions/instagram/instagram-direct-fetch.js";
import { extractMediaNodesFromJson } from "../lib/tools/influencer-functions/instagram/instagram-json-utils.js";

const keyword = process.argv[2] || "pool cleaner";
const username = process.argv[3] || "natgeo";

const { page, target } = await acquireInstagramCdpPage();
console.log("target:", target.url, target.id);
await page.waitForTimeout(3000);

try {
  const href = await page.evaluate(() => location.href);
  console.log("page check:", { href });
  try {
    const cookieLen = await page.evaluate(() => document.cookie.length);
    console.log("cookieLen:", cookieLen);
  } catch (e) {
    console.log("cookie blocked:", e.message);
  }
} catch (e) {
  console.log("page check failed:", e.message);
}

const boot = await extractIgRelayBootstrap(page).catch((e) => {
  console.log("bootstrap failed:", e.message);
  return null;
});
console.log("bootstrap:", JSON.stringify(boot, null, 2));

const profileJson = await fetchWebProfileInfo(page, username);
const userId = profileJson?.data?.user?.id || profileJson?.data?.user?.pk || null;

const searchJson = await fetchKeywordSearchPage(page, keyword);
const searchPosts = searchJson ? extractMediaNodesFromJson(searchJson).length : 0;

let clipsCount = 0;
if (userId) {
  const clipsJson = await fetchUserClipsPage(page, userId, { username });
  clipsCount = clipsJson ? extractMediaNodesFromJson(clipsJson).length : 0;
}

console.log(
  JSON.stringify(
    {
      profile: { ok: !!profileJson, userId, username: profileJson?.data?.user?.username },
      search: { ok: !!searchJson, posts: searchPosts },
      clips: { ok: clipsCount > 0, reels: clipsCount },
    },
    null,
    2
  )
);

await page.dispose();
