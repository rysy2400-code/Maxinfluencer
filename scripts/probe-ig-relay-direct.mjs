#!/usr/bin/env node
/**
 * 探测 GraphQL 直调成功率（模板 / bootstrap / 是否触发 navigate 捕获）
 */
import {
  acquireInstagramApiSession,
  fetchKeywordSearchPage,
  fetchUserClipsPage,
  fetchWebProfileInfo,
  getIgRelayTemplate,
} from "../lib/tools/influencer-functions/instagram/instagram-direct-fetch.js";

process.env.IG_LITE_DEBUG_RELAY = "1";

const keyword = process.argv[2] || "pool cleaner";
const username = process.argv[3] || "thejunglebadger";

const browser = await import("playwright").then((m) =>
  m.chromium.connectOverCDP(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222", {
    timeout: 15_000,
  })
);
const context = browser.contexts()[0];

const session = await acquireInstagramApiSession(context);
const { page } = session;

const profile = await fetchWebProfileInfo(page, username);
const userId =
  profile?.data?.user?.id ||
  profile?.data?.user?.pk ||
  profile?.user?.pk ||
  null;

const searchJson = await fetchKeywordSearchPage(page, keyword, { skipCapture: true });
const reelsJson = userId
  ? await fetchUserClipsPage(page, userId, { username, skipCapture: true })
  : null;

console.log(
  JSON.stringify(
    {
      hasRelayTemplate: !!getIgRelayTemplate(page),
      sessionHasRelayTemplate: session.hasRelayTemplate,
      profileOk: !!profile?.data?.user || !!profile?.user,
      searchGraphqlOk: !!(searchJson?.data || searchJson?.media_grid),
      reelsGraphqlOk: !!(reelsJson?.data || reelsJson?.items || reelsJson?.paging_info),
      userId,
    },
    null,
    2
  )
);

await session.dispose();
await browser.close().catch(() => {});
