#!/usr/bin/env node
import { chromium } from "playwright";
import {
  acquireInstagramApiSession,
  fetchWebProfileInfo,
  fetchUserClipsPage,
  igApiFetch,
} from "../lib/tools/influencer-functions/instagram/instagram-direct-fetch.js";
import { extractClipsMediaFromJson } from "../lib/tools/influencer-functions/instagram/instagram-json-utils.js";

const username = process.argv[2] || "natgeo";
const CDP = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
const session = await acquireInstagramApiSession(browser.contexts()[0]);
const { page } = session;

const profile = await fetchWebProfileInfo(page, username);
const userId = profile?.data?.user?.id || profile?.data?.user?.pk;

const gql = await fetchUserClipsPage(page, userId, { username, skipCapture: true });
const gqlConn = gql?.data?.xdt_api__v1__clips__user__connection_v2;
const rest = await igApiFetch(
  page,
  `/api/v1/clips/user/?target_user_id=${userId}&page_size=12`
);

console.log(
  JSON.stringify(
    {
      username,
      userId,
      gql: {
        connNull: gqlConn == null,
        edgesLen: gqlConn?.edges?.length ?? null,
        extracted: gql ? extractClipsMediaFromJson(gql).length : 0,
      },
      rest: {
        itemsLen: rest?.items?.length ?? null,
        extracted: rest ? extractClipsMediaFromJson(rest).length : 0,
        samplePlay: rest?.items?.[0]?.play_count ?? null,
        sampleLike: rest?.items?.[0]?.like_count ?? null,
      },
    },
    null,
    2
  )
);

await session.dispose();
await browser.close().catch(() => {});
