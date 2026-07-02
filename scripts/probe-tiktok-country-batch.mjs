#!/usr/bin/env node
/**
 * 诊断 Lite 国家预筛：对关键词搜索前 N 人逐条 resolve locationCreated
 * 用法: node scripts/probe-tiktok-country-batch.mjs "AI design tool demo" 20
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const keyword = process.argv[2] || "AI design tool demo";
const maxCount = Math.min(Math.max(Number(process.argv[3] || 20), 1), 40);
const endpoint =
  process.env.TT_LITE_COUNTRY_CDP ||
  process.env.CDP_ENDPOINT ||
  "http://127.0.0.1:9222";

const {
  acquireTiktokApiSession,
  fetchSearchItemFullAll,
  resolveVideoLocationCreatedForInfluencer,
} = await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");
const {
  extractVideosFromSearchAPI,
  extractInfluencersFromVideos,
} = await import("../lib/tools/influencer-functions/extract-search-results-cdp.js");
const { orderInfluencersForCountryCheck } = await import(
  "../lib/tools/influencer-functions/resolve-video-publish-country.js"
);

console.log(`[probe] endpoint=${endpoint} keyword="${keyword}" batch=${maxCount}`);

const session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
const { page } = session;
try {
  const batches = await fetchSearchItemFullAll(page, keyword, { maxPages: 3 });
  const videos = [];
  for (const b of batches) videos.push(...extractVideosFromSearchAPI(b));
  const recs = extractInfluencersFromVideos(videos);
  const queue = orderInfluencersForCountryCheck(recs, videos, maxCount);

  let ok = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const rec = queue[i];
    const u = String(rec.username || "").replace(/^@/, "");
    const src = videos.find((v) => String(v.username || "").replace(/^@/, "") === u);
    const probe = await resolveVideoLocationCreatedForInfluencer(page, {
      username: u,
      videoId: rec.representativeVideoId || src?.videoId || "",
      secUid: rec.secUid || rec.tiktokSecUid || src?.creator?.secUid || "",
      searchLocation: src?.locationCreated || null,
    });
    if (probe.locationCreated) ok += 1;
    console.log(
      `${String(i + 1).padStart(2)}. @${u.padEnd(22)} loc=${(probe.locationCreated || "NULL").padEnd(4)} src=${probe.source || "-"} vid=${probe.representativeVideoId || rec.representativeVideoId || "-"}${probe.error ? ` err=${probe.error}` : ""}`
    );
  }
  console.log(`\n[probe] locationCreated 覆盖: ${ok}/${queue.length}`);
  process.exitCode = ok === queue.length ? 0 : 1;
} finally {
  await session.dispose();
}
