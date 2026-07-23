#!/usr/bin/env node
/**
 * 单用户 locationCreated video_html_fetch 诊断
 * node scripts/probe-tiktok-country-one.mjs designsyshouse 7621980887088942349
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const username = (process.argv[2] || "designsyshouse").replace(/^@/, "");
const videoId = process.argv[3] || "";
const secUidArg = process.argv[4] || "";
const endpoint =
  process.env.TT_LITE_COUNTRY_CDP ||
  process.env.CDP_ENDPOINT ||
  "http://127.0.0.1:9222";

const {
  acquireTiktokApiSession,
  fetchUserDetail,
  fetchPostItemList,
  fetchSearchItemFullAll,
  fetchLocationCreatedFromVideoHtmlRequest,
  fetchLocationCreatedFromVideoHtmlViaNode,
  resolveVideoLocationCreatedForInfluencer,
} = await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");
const { extractVideosFromSearchAPI } = await import(
  "../lib/tools/influencer-functions/extract-search-results-cdp.js"
);

function countLoc(items) {
  let n = 0;
  for (const item of items || []) {
    if (item?.locationCreated) n += 1;
  }
  return n;
}

const session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
const { page } = session;
try {
  console.log(`[one] user=@${username} vid=${videoId || "-"} endpoint=${endpoint}`);

  let secUid = String(secUidArg || "").trim();
  if (!secUid) {
    try {
      const batches = await fetchSearchItemFullAll(page, "AI design tool demo", {
        maxPages: 1,
      });
      for (const b of batches) {
        const hit = extractVideosFromSearchAPI(b).find(
          (v) => String(v.username || "").replace(/^@/, "") === username
        );
        if (hit?.creator?.secUid) {
          secUid = hit.creator.secUid;
          break;
        }
      }
      console.log(`[one] secUid from search=${secUid ? "yes" : "NO"}`);
    } catch (e) {
      console.log(`[one] search secUid ERROR: ${e.message}`);
    }
  } else {
    console.log(`[one] secUid from argv=yes`);
  }
  if (!secUid) {
    try {
      const detail = await fetchUserDetail(page, username, {});
      secUid =
        detail?.userInfo?.user?.secUid ||
        detail?.userInfo?.user?.sec_uid ||
        detail?.user?.secUid ||
        "";
      console.log(
        `[one] user/detail secUid=${secUid ? "yes" : "NO"} status=${detail?.statusCode ?? detail?.status_code ?? "-"}`
      );
    } catch (e) {
      console.log(`[one] user/detail ERROR: ${e.message}`);
    }
  }

  if (secUid) {
    try {
      const list = await fetchPostItemList(page, {
        secUid,
        count: 20,
        cursor: 0,
        referer: `https://www.tiktok.com/@${username}`,
      });
      const items = list?.itemList || list?.item_list || [];
      console.log(
        `[one] post/item_list items=${items.length} withLocation=${countLoc(items)} hasMore=${list?.hasMore ?? list?.has_more ?? "-"}`
      );
      if (items[0]) {
        console.log(
          `[one] first item keys sample: id=${items[0].id} locationCreated=${items[0].locationCreated ?? "null"}`
        );
      }
    } catch (e) {
      console.log(`[one] post/item_list ERROR: ${e.message}`);
    }
  }

  const vid = videoId || "";
  if (vid) {
    try {
      const videoUrl = `https://www.tiktok.com/@${username}/video/${vid}`;
      const meta = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          credentials: "include",
          headers: {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            referer: "https://www.tiktok.com/",
          },
        });
        const text = await res.text();
        return {
          status: res.status,
          len: text.length,
          universal: text.includes("__UNIVERSAL_DATA_FOR_REHYDRATION__"),
          sigi: text.includes("SIGI_STATE"),
          preview: text.slice(0, 120),
        };
      }, videoUrl);
      console.log(
        `[one] video_html status=${meta.status} len=${meta.len} universal=${meta.universal} sigi=${meta.sigi} preview=${JSON.stringify(meta.preview)}`
      );
      const htmlLoc = await fetchLocationCreatedFromVideoHtmlRequest(page, username, vid);
      console.log(`[one] video_html_fetch loc=${htmlLoc || "NULL"}`);
    } catch (e) {
      console.log(`[one] video_html_fetch ERROR: ${e.message}`);
    }

    try {
      const nodeLoc = await fetchLocationCreatedFromVideoHtmlViaNode(page, username, vid);
      console.log(`[one] video_html_node loc=${nodeLoc || "NULL"}`);
    } catch (e) {
      console.log(`[one] video_html_node ERROR: ${e.message}`);
    }
  }

  const full = await resolveVideoLocationCreatedForInfluencer(page, {
    username,
    videoId: vid,
    secUid,
  });
  console.log(
    `[one] resolveForInfluencer loc=${full.locationCreated || "NULL"} src=${full.source || "-"} err=${full.error || "-"}`
  );
} finally {
  await session.dispose();
}
