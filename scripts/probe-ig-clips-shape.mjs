#!/usr/bin/env node
import {
  acquireInstagramApiSession,
  fetchUserClipsPage,
  fetchWebProfileInfo,
} from "../lib/tools/influencer-functions/instagram/instagram-direct-fetch.js";
import { extractClipsMediaFromJson } from "../lib/tools/influencer-functions/instagram/instagram-json-utils.js";

const username = process.argv[2] || "thejunglebadger";
const browser = await import("playwright").then((m) =>
  m.chromium.connectOverCDP(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222", {
    timeout: 15_000,
  })
);
const session = await acquireInstagramApiSession(browser.contexts()[0]);
const { page } = session;
const profile = await fetchWebProfileInfo(page, username);
const userId = profile?.data?.user?.id || profile?.data?.user?.pk;
await page.goto(`https://www.instagram.com/${username}/reels/`, {
  waitUntil: "domcontentloaded",
  timeout: 90_000,
}).catch(() => {});
await page.waitForTimeout(2500);
const json = await fetchUserClipsPage(page, userId, { username, skipCapture: true });
const topKeys = json && typeof json === "object" ? Object.keys(json) : [];
const dataKeys = json?.data && typeof json.data === "object" ? Object.keys(json.data) : [];
const medias = extractClipsMediaFromJson(json || {});
const conn = json?.data?.xdt_api__v1__clips__user__connection_v2;
console.log(
  JSON.stringify(
    {
      topKeys,
      dataKeys,
      connKeys: conn && typeof conn === "object" ? Object.keys(conn) : [],
      edgesLen: Array.isArray(conn?.edges) ? conn.edges.length : null,
      firstEdgeKeys:
        conn?.edges?.[0] && typeof conn.edges[0] === "object"
          ? Object.keys(conn.edges[0])
          : null,
      firstNodeKeys:
        conn?.edges?.[0]?.node && typeof conn.edges[0].node === "object"
          ? Object.keys(conn.edges[0].node)
          : null,
      pageInfo: conn?.page_info || null,
      connType: conn === null ? "null" : Array.isArray(conn) ? "array" : typeof conn,
      connJsonLen: conn ? JSON.stringify(conn).length : 0,
      itemsLen: Array.isArray(json?.items) ? json.items.length : null,
      extracted: medias.length,
      samplePk: medias[0]?.pk || medias[0]?.id || null,
    },
    null,
    2
  )
);
await session.dispose();
await browser.close().catch(() => {});
