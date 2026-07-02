#!/usr/bin/env node
/** 复测 task 56966 中 6 位 country_unknown 红人 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const KEYWORD = "AI design tool demo";
const USERS = [
  "sns4442",
  "jgoldieseo",
  "hustle.faceless",
  "shingogoirie",
  "ruqiiiiiiiiiii",
  "designsyshouse",
];
const endpoint =
  process.env.TT_LITE_COUNTRY_CDP ||
  process.env.CDP_ENDPOINT ||
  "http://127.0.0.1:9222";

const {
  acquireTiktokApiSession,
  fetchSearchItemFullAll,
  resolveVideoLocationCreatedForInfluencer,
} = await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");
const { extractVideosFromSearchAPI } = await import(
  "../lib/tools/influencer-functions/extract-search-results-cdp.js"
);

console.log(`[probe-six] endpoint=${endpoint}`);
const session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
const { page } = session;
try {
  const batches = await fetchSearchItemFullAll(page, KEYWORD, { maxPages: 2 });
  const videos = [];
  for (const b of batches) videos.push(...extractVideosFromSearchAPI(b));

  let ok = 0;
  for (const u of USERS) {
    const v = videos.find((x) => String(x.username || "").replace(/^@/, "") === u);
    const probe = await resolveVideoLocationCreatedForInfluencer(page, {
      username: u,
      videoId: v?.videoId || "",
      secUid: v?.creator?.secUid || "",
      searchLocation: v?.locationCreated || null,
    });
    if (probe.locationCreated) ok += 1;
    console.log(
      `@${u} loc=${probe.locationCreated || "NULL"} src=${probe.source || "-"} vid=${probe.representativeVideoId || v?.videoId || "-"}`
    );
  }
  console.log(`[probe-six] resolved ${ok}/${USERS.length}`);
  process.exitCode = ok === USERS.length ? 0 : 1;
} finally {
  await session.dispose();
}
