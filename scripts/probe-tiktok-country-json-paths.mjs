#!/usr/bin/env node
/**
 * 对比纯 JSON 路径 vs HTML 对 locationCreated 的覆盖率
 *   node scripts/probe-tiktok-country-json-paths.mjs "AI design tool demo" 20
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
const listPages = Math.min(Number(process.env.TT_LITE_COUNTRY_ITEM_LIST_PAGES || 3), 5);
const listCount = Math.min(Number(process.env.TT_LITE_COUNTRY_ITEM_LIST_COUNT || 20), 30);
const detailTries = Math.min(Number(process.env.TT_LITE_COUNTRY_ITEM_DETAIL_TRIES || 15), 25);
const probeDelay = Number(process.env.TT_LITE_COUNTRY_PROBE_DELAY_MS || 200);

const {
  acquireTiktokApiSession,
  fetchSearchItemFullAll,
  fetchUserDetail,
  fetchPostItemList,
  fetchLocationCreatedFromItemDetailApi,
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

function pickLoc(item) {
  if (!item) return null;
  const v = item.locationCreated ?? item.location_created;
  return v != null && v !== "" ? String(v) : null;
}

async function fetchProfileItems(page, username, secUid) {
  const items = [];
  let cursor = 0;
  for (let p = 0; p < listPages; p += 1) {
    const listJson = await fetchPostItemList(page, {
      secUid,
      count: listCount,
      cursor,
      referer: `https://www.tiktok.com/@${username}`,
    });
    const batch = listJson?.itemList || listJson?.item_list || [];
    items.push(...batch);
    const next = listJson?.cursor ?? listJson?.nextCursor;
    const hasMore =
      (listJson?.hasMore === 1 ||
        listJson?.hasMore === true ||
        listJson?.has_more === 1) &&
      batch.length > 0;
    if (!hasMore || next == null || next === cursor) break;
    cursor = next;
  }
  return items;
}

async function resolveSecUid(page, username, secUid) {
  let uid = String(secUid || "").trim();
  if (uid) return uid;
  try {
    const detail = await fetchUserDetail(page, username, {});
    uid =
      detail?.userInfo?.user?.secUid ||
      detail?.userInfo?.user?.sec_uid ||
      detail?.user?.secUid ||
      "";
  } catch {
    /* ignore */
  }
  return String(uid || "").trim();
}

async function probeJsonPaths(page, rec, srcVideo, altVideoIds) {
  const username = String(rec.username || "").replace(/^@/, "");
  const primaryVid = rec.representativeVideoId || srcVideo?.videoId || "";
  const searchLoc = srcVideo?.locationCreated || null;
  const secUid = await resolveSecUid(
    page,
    username,
    rec.secUid || rec.tiktokSecUid || srcVideo?.creator?.secUid || ""
  );

  const result = {
    username,
    primaryVid,
    secUid: secUid ? "yes" : "no",
    search_api: searchLoc,
    item_detail_primary: null,
    item_list_items: 0,
    item_list_with_loc: 0,
    item_list_api: null,
    item_list_api_vid: null,
    item_detail_list: null,
    item_detail_list_vid: null,
    video_html_fetch: null,
    json_any: null,
    json_source: null,
  };

  if (primaryVid) {
    result.item_detail_primary = await fetchLocationCreatedFromItemDetailApi(
      page,
      primaryVid,
      username
    );
  }

  if (secUid) {
    try {
      const items = await fetchProfileItems(page, username, secUid);
      result.item_list_items = items.length;
      result.item_list_with_loc = items.filter((i) => pickLoc(i)).length;
      for (const item of items) {
        const loc = pickLoc(item);
        if (loc) {
          result.item_list_api = loc;
          result.item_list_api_vid = String(item.id || item.aweme_id || "");
          break;
        }
      }
      let tried = 0;
      for (const item of items) {
        const vid = String(item.id || item.aweme_id || "").trim();
        if (!vid) continue;
        if (tried >= detailTries) break;
        tried += 1;
        const loc = await fetchLocationCreatedFromItemDetailApi(page, vid, username);
        if (loc) {
          result.item_detail_list = loc;
          result.item_detail_list_vid = vid;
          break;
        }
      }
    } catch (e) {
      result.item_list_error = e.message;
    }
  }

  if (primaryVid) {
    result.video_html_fetch = await fetchLocationCreatedFromVideoHtmlRequest(
      page,
      username,
      primaryVid
    );
  }

  const jsonHits = [
    ["search_api", result.search_api],
    ["item_detail_primary", result.item_detail_primary],
    ["item_list_api", result.item_list_api],
    ["item_detail_list", result.item_detail_list],
  ];
  for (const [src, loc] of jsonHits) {
    if (loc) {
      result.json_any = loc;
      result.json_source = src;
      break;
    }
  }

  return result;
}

console.log(
  `[json-probe] keyword="${keyword}" batch=${maxCount} endpoint=${endpoint} item_list pages=${listPages} count=${listCount}`
);

const session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
const { page } = session;
const stats = {
  search_api: 0,
  item_detail_primary: 0,
  item_list_api: 0,
  item_detail_list: 0,
  json_any: 0,
  html: 0,
  json_only: 0,
  html_only: 0,
  both: 0,
  neither: 0,
  item_list_nonempty: 0,
  item_list_has_loc_field: 0,
};

try {
  const batches = await fetchSearchItemFullAll(page, keyword, { maxPages: 3 });
  const videos = [];
  for (const b of batches) videos.push(...extractVideosFromSearchAPI(b));
  const recs = extractInfluencersFromVideos(videos);
  const queue = orderInfluencersForCountryCheck(recs, videos, maxCount);

  const rows = [];
  for (let i = 0; i < queue.length; i += 1) {
    const rec = queue[i];
    const u = String(rec.username || "").replace(/^@/, "");
    const src = videos.find((v) => String(v.username || "").replace(/^@/, "") === u);
    const row = await probeJsonPaths(page, rec, src, []);
    rows.push(row);

    if (row.search_api) stats.search_api += 1;
    if (row.item_detail_primary) stats.item_detail_primary += 1;
    if (row.item_list_api) stats.item_list_api += 1;
    if (row.item_detail_list) stats.item_detail_list += 1;
    if (row.json_any) stats.json_any += 1;
    if (row.video_html_fetch) stats.html += 1;
    if (row.item_list_items > 0) stats.item_list_nonempty += 1;
    if (row.item_list_with_loc > 0) stats.item_list_has_loc_field += 1;

    const hasJson = !!row.json_any;
    const hasHtml = !!row.video_html_fetch;
    if (hasJson && hasHtml) stats.both += 1;
    else if (hasJson && !hasHtml) stats.json_only += 1;
    else if (!hasJson && hasHtml) stats.html_only += 1;
    else stats.neither += 1;

    console.log(
      `${String(i + 1).padStart(2)}. @${u.padEnd(22)} ` +
        `search=${row.search_api || "-"} ` +
        `detail1=${row.item_detail_primary || "-"} ` +
        `list=${row.item_list_with_loc}/${row.item_list_items}${row.item_list_api ? `→${row.item_list_api}` : ""} ` +
        `detailN=${row.item_detail_list || "-"} ` +
        `html=${row.video_html_fetch || "-"} ` +
        `json=${row.json_source || "-"}`
    );

    if (probeDelay > 0 && i < queue.length - 1) {
      await page.waitForTimeout(probeDelay);
    }
  }

  console.log("\n[json-probe] === 路径覆盖汇总 ===");
  console.log(`  search_api:           ${stats.search_api}/${queue.length}`);
  console.log(`  item_detail (代表视频): ${stats.item_detail_primary}/${queue.length}`);
  console.log(`  item_list (字段直取):  ${stats.item_list_api}/${queue.length}`);
  console.log(`  item_detail (列表视频): ${stats.item_detail_list}/${queue.length}`);
  console.log(`  任一 JSON 路径:        ${stats.json_any}/${queue.length}`);
  console.log(`  video_html_fetch:     ${stats.html}/${queue.length}`);
  console.log(`  item_list 有数据:      ${stats.item_list_nonempty}/${queue.length}`);
  console.log(`  item_list 含 location: ${stats.item_list_has_loc_field}/${queue.length} (总 item 字段命中)`);
  console.log("\n[json-probe] === JSON vs HTML ===");
  console.log(`  仅 JSON:  ${stats.json_only}/${queue.length}`);
  console.log(`  仅 HTML:  ${stats.html_only}/${queue.length}`);
  console.log(`  两者都有: ${stats.both}/${queue.length}`);
  console.log(`  都没有:   ${stats.neither}/${queue.length}`);

  // resolve 链路（可选，--with-resolve 时跑 VIDEO_INFO=0 item_list 优先）
  if (process.argv.includes("--with-resolve")) {
    process.env.TT_LITE_COUNTRY_VIDEO_INFO = "0";
    process.env.TT_LITE_COUNTRY_DISABLE_NAV = "1";
    let resolveItemListFirst = 0;
    const resolveSources = {};
    console.log("\n[json-probe] === resolveForInfluencer (VIDEO_INFO=0, item_list 优先) ===");
    for (let i = 0; i < queue.length; i += 1) {
      const rec = queue[i];
      const u = String(rec.username || "").replace(/^@/, "");
      const src = videos.find((v) => String(v.username || "").replace(/^@/, "") === u);
      const probe = await resolveVideoLocationCreatedForInfluencer(page, {
        username: u,
        videoId: rec.representativeVideoId || src?.videoId || "",
        secUid: rec.secUid || rec.tiktokSecUid || src?.creator?.secUid || "",
        searchLocation: src?.locationCreated || null,
        altVideoIds: videos
          .filter((v) => String(v.username || "").replace(/^@/, "") === u)
          .map((v) => String(v.videoId || "").trim())
          .filter(Boolean),
      });
      if (probe.locationCreated) resolveItemListFirst += 1;
      const srcKey = probe.source || "null";
      resolveSources[srcKey] = (resolveSources[srcKey] || 0) + 1;
      if (probeDelay > 0 && i < queue.length - 1) {
        await page.waitForTimeout(probeDelay);
      }
    }
    console.log(`  覆盖: ${resolveItemListFirst}/${queue.length}`);
    console.log(`  来源分布: ${JSON.stringify(resolveSources)}`);
  }

  process.exitCode = stats.html === queue.length ? 0 : 1;
} finally {
  await session.dispose();
}
