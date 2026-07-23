#!/usr/bin/env node
/**
 * TikTok Lite 国家诊断：search_api 仅统计原始 locationCreated，不作为国家来源；
 * 实际国家只走 video_html_fetch（fetch 视频 HTML，解析 UNIVERSAL/SIGI）。
 *
 *   node scripts/probe-tiktok-country-json-paths.mjs "AI design tool demo" 20
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const keyword = process.argv[2] || "AI design tool demo";
const maxCount = Math.min(Math.max(Number(process.argv[3] || 20), 1), 80);
const endpoint =
  process.env.TT_LITE_COUNTRY_CDP ||
  process.env.CDP_ENDPOINT ||
  "http://127.0.0.1:9222";
const probeDelay = Number(process.env.TT_LITE_COUNTRY_PROBE_DELAY_MS || 200);

const {
  acquireTiktokApiSession,
  fetchSearchItemFullAll,
  fetchLocationCreatedFromVideoHtmlRequest,
  resolveVideoLocationCreatedForInfluencer,
} = await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");
const {
  extractVideosFromSearchAPI,
  extractInfluencersFromVideos,
} = await import("../lib/tools/influencer-functions/extract-search-results-cdp.js");
const { orderInfluencersForCountryCheck } = await import(
  "../lib/tools/influencer-functions/resolve-video-publish-country.js"
);

function iso2(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : null;
}

function rawSearchLocation(video) {
  return video?.locationCreated ?? video?.location_created ?? null;
}

console.log(
  `[html-probe] keyword="${keyword}" batch=${maxCount} endpoint=${endpoint} source=video_html_fetch`
);

const session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
const { page } = session;

try {
  const batches = await fetchSearchItemFullAll(page, keyword, { maxPages: 3 });
  const videos = batches.flatMap((b) => extractVideosFromSearchAPI(b));
  const recs = extractInfluencersFromVideos(videos);
  const queue = orderInfluencersForCountryCheck(recs, videos, maxCount);
  const videoByUser = new Map();
  for (const v of videos) {
    const u = String(v.username || "").replace(/^@/, "");
    if (u && !videoByUser.has(u)) videoByUser.set(u, v);
  }

  const searchRaw = videos
    .map(rawSearchLocation)
    .filter((v) => v != null && v !== "");
  const searchIso = searchRaw.filter(iso2);
  const searchRejected = searchRaw.filter((v) => !iso2(v));

  let htmlOk = 0;
  let resolveOk = 0;
  const sourceStats = {};
  for (let i = 0; i < queue.length; i += 1) {
    const rec = queue[i];
    const u = String(rec.username || "").replace(/^@/, "");
    const src = videoByUser.get(u);
    const vid = rec.representativeVideoId || src?.videoId || "";
    const searchLoc = rawSearchLocation(src);
    const acceptedSearch = iso2(searchLoc);

    const htmlLoc = vid
      ? await fetchLocationCreatedFromVideoHtmlRequest(page, u, vid)
      : null;
    if (htmlLoc) htmlOk += 1;

    const probe = await resolveVideoLocationCreatedForInfluencer(page, {
      username: u,
      videoId: vid,
      altVideoIds: videos
        .filter((v) => String(v.username || "").replace(/^@/, "") === u)
        .map((v) => String(v.videoId || "").trim())
        .filter(Boolean),
      secUid: rec.secUid || rec.tiktokSecUid || src?.creator?.secUid || "",
    });
    if (probe.locationCreated) resolveOk += 1;
    const key = probe.source || "null";
    sourceStats[key] = (sourceStats[key] || 0) + 1;

    console.log(
      `${String(i + 1).padStart(2)}. @${u.padEnd(22)} ` +
        `search=${acceptedSearch || (searchLoc ? `REJECT:${searchLoc}` : "-")} ` +
        `html=${htmlLoc || "-"} resolve=${probe.locationCreated || "-"} ` +
        `src=${probe.source || "-"} vid=${probe.representativeVideoId || vid || "-"}`
    );

    if (probeDelay > 0 && i < queue.length - 1) {
      await page.waitForTimeout(probeDelay);
    }
  }

  console.log("\n[html-probe] === 汇总 ===");
  console.log(`  搜索视频数:               ${videos.length}`);
  console.log(`  search 原始 location:     ${searchRaw.length}/${videos.length}`);
  console.log(`  search ISO-2 可接受:      ${searchIso.length}/${videos.length}`);
  console.log(`  search 非 ISO 已拒绝:     ${searchRejected.length}/${videos.length}`);
  console.log(`  video_html_fetch 覆盖:    ${htmlOk}/${queue.length}`);
  console.log(`  resolve 主链路覆盖:       ${resolveOk}/${queue.length}`);
  console.log(`  resolve 来源分布:         ${JSON.stringify(sourceStats)}`);
  process.exitCode = resolveOk === queue.length ? 0 : 1;
} finally {
  await session.dispose();
}
