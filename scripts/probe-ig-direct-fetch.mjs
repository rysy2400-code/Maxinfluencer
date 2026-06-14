#!/usr/bin/env node
/**
 * 探测 Instagram 直调 API（在 instagram.com 页面上下文 fetch，无需打开搜索/主页）
 */
import { chromium } from "playwright";
import { acquireInstagramApiSession, fetchKeywordSearchPage, fetchWebProfileInfo, fetchUserClipsPage } from "../lib/tools/influencer-functions/instagram/instagram-direct-fetch.js";
import { extractMediaNodesFromJson } from "../lib/tools/influencer-functions/instagram/instagram-json-utils.js";

const keyword = process.argv[2] || "pool cleaner";
const username = process.argv[3] || "natgeo";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const context = browser.contexts()[0];

const session = await acquireInstagramApiSession(context);
const { page } = session;

const searchJson = await fetchKeywordSearchPage(page, keyword);
const searchPosts = searchJson ? extractMediaNodesFromJson(searchJson).length : 0;

const profileJson = await fetchWebProfileInfo(page, username);
const userId =
  profileJson?.data?.user?.id ||
  profileJson?.data?.user?.pk ||
  null;

let clipsCount = 0;
if (userId) {
  const clipsJson = await fetchUserClipsPage(page, userId);
  clipsCount = clipsJson ? extractMediaNodesFromJson(clipsJson).length : 0;
}

console.log(
  JSON.stringify(
    {
      pageUrl: page.url(),
      search: { ok: !!searchJson, posts: searchPosts },
      profile: { ok: !!profileJson, userId, username: profileJson?.data?.user?.username },
      clips: { ok: clipsCount > 0, reels: clipsCount },
    },
    null,
    2
  )
);

await session.dispose();
await browser.close().catch(() => {});
