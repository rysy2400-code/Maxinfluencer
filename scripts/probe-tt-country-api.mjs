#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const username = process.argv[2] || "devdoesreviews";
const keyword = process.argv[3] || "pool cleaner";
const searchEndpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const enrichEndpoint = process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223";

const {
  acquireTiktokApiSession,
  fetchUserDetail,
  fetchPostItemList,
  fetchSearchItemFull,
  resolveVideoLocationCreated,
} = await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");
const { tiktokMakeRequest } = await import(
  "../lib/tools/influencer-functions/tiktok/tiktok-api-client.js"
);
const { extractVideosFromSearchAPI } = await import(
  "../lib/tools/influencer-functions/extract-search-results-cdp.js"
);

async function withSession(endpoint, fn) {
  const session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
  try {
    return await fn(session.page);
  } finally {
    await session.dispose();
  }
}

console.log("\n=== 9223 user/detail ===");
await withSession(enrichEndpoint, async (page) => {
  const detail = await fetchUserDetail(page, username, {});
  console.log("[probe] status_code=", detail?.status_code);
  console.log("[probe] preview=", JSON.stringify(detail).slice(0, 500));
  const user = detail?.userInfo?.user || detail?.userInfo || detail?.user;
  console.log("[probe] secUid=", user?.secUid || user?.sec_uid || "none");
});

const sample = await withSession(searchEndpoint, async (page) => {
  console.log("\n=== 9222 search sample ===");
  const json = await fetchSearchItemFull(page, { keyword, cursor: 0 });
  const videos = extractVideosFromSearchAPI(json);
  console.log("[probe] search videos=", videos.length);
  const hit = videos.find((v) => v.videoId && v.creator?.secUid) || videos[0];
  if (!hit) {
    console.log("[probe] no search sample");
    return null;
  }
  console.log("[probe] sample user=", hit.username, "videoId=", hit.videoId);
  console.log("[probe] sample secUid=", hit.creator?.secUid || "none");
  console.log("[probe] sample locationCreated=", hit.locationCreated ?? "null");
  return hit;
});

if (sample) {
  console.log("\n=== 9223 country APIs ===");
  await withSession(enrichEndpoint, async (page) => {
    if (sample.videoId) {
      for (const [apiUrl, params] of [
        ["https://www.tiktok.com/api/post/item_detail/", { itemId: sample.videoId }],
        ["https://www.tiktok.com/api/item/detail/", { itemId: sample.videoId }],
      ]) {
        try {
          const j = await tiktokMakeRequest(page, apiUrl, params, {
            referer: `https://www.tiktok.com/@${sample.username}/video/${sample.videoId}`,
          });
          const item =
            j?.itemInfo?.itemStruct ||
            j?.itemStruct ||
            j?.itemInfo ||
            (Array.isArray(j?.itemList) ? j.itemList[0] : null);
          console.log(
            `[probe] ${apiUrl} status=${j?.status_code} locationCreated=${item?.locationCreated ?? "null"}`
          );
        } catch (e) {
          console.log(`[probe] ${apiUrl} err=${e.message}`);
        }
      }
    }

    if (sample.creator?.secUid) {
      try {
        const listJson = await fetchPostItemList(page, {
          secUid: sample.creator.secUid,
          count: 10,
          referer: `https://www.tiktok.com/@${sample.username}`,
        });
        const items = listJson?.itemList || listJson?.item_list || [];
        console.log("[probe] item_list count=", items.length, "status=", listJson?.status_code);
        for (const it of items.slice(0, 3)) {
          console.log("  video", it.id, "locationCreated=", it.locationCreated ?? "null");
        }
      } catch (e) {
        console.log("[probe] item_list err=", e.message);
      }
    }

    const loc = await resolveVideoLocationCreated(page, {
      username: sample.username,
      secUid: sample.creator?.secUid || "",
      videoId: sample.videoId,
      searchLocation: sample.locationCreated || null,
    });
    console.log("[probe] resolveVideoLocationCreated=", loc);

    if (sample.videoId && sample.username) {
      const videoUrl = `https://www.tiktok.com/@${sample.username}/video/${sample.videoId}`;
      const htmlLoc = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          credentials: "include",
          headers: { accept: "text/html,application/xhtml+xml" },
        });
        const html = await res.text();
        const marker = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">';
        const start = html.indexOf(marker);
        if (start < 0) return { ok: res.ok, loc: null, hasUniversal: false };
        const jsonStart = start + marker.length;
        const jsonEnd = html.indexOf("</script>", jsonStart);
        const data = JSON.parse(html.slice(jsonStart, jsonEnd));
        const item =
          data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
          data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo?.itemStruct;
        return {
          ok: res.ok,
          hasUniversal: true,
          loc: item?.locationCreated ?? null,
        };
      }, videoUrl);
      console.log("[probe] html fetch location=", htmlLoc);
    }
  });
}
