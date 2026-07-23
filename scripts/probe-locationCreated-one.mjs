#!/usr/bin/env node
/** 单用户逐步诊断 video_html_fetch locationCreated 链路 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const username = (process.argv[2] || "creativeshimmy").replace(/^@/, "");
const videoId = process.argv[3] || "7184839160274996522";
const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

process.env.TT_LITE_ALLOW_NAV = process.env.TT_LITE_ALLOW_NAV || "0";
process.env.TT_LITE_COUNTRY_DISABLE_NAV = "1";

const {
  acquireTiktokApiSession,
  fetchUserDetail,
  fetchPostItemList,
  fetchLocationCreatedFromVideoHtmlRequest,
  fetchLocationCreatedFromVideoHtmlViaNode,
} = await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");

function itemLoc(item) {
  if (!item) return null;
  if (item.locationCreated != null && item.locationCreated !== "") {
    return String(item.locationCreated);
  }
  return null;
}

function log(step, data) {
  console.log(`[${step}]`, typeof data === "string" ? data : JSON.stringify(data, null, 0));
}

const session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
const { page } = session;
try {
  let detail;
  try {
    detail = await fetchUserDetail(page, username, {});
    const secUid =
      detail?.userInfo?.user?.secUid ||
      detail?.userInfo?.user?.sec_uid ||
      detail?.user?.secUid ||
      "";
    log("user/detail", { secUid: secUid || null, keys: Object.keys(detail || {}) });
  } catch (e) {
    log("user/detail", `FAIL ${e.message}`);
  }

  const secUid =
    detail?.userInfo?.user?.secUid ||
    detail?.userInfo?.user?.sec_uid ||
    detail?.user?.secUid ||
    "";

  if (secUid) {
    try {
      const listJson = await fetchPostItemList(page, {
        secUid,
        count: 10,
        cursor: 0,
        referer: `https://www.tiktok.com/@${username}`,
      });
      const items = listJson?.itemList || listJson?.item_list || [];
      const withLoc = items.filter((i) => itemLoc(i));
      log("item_list", {
        count: items.length,
        withLocation: withLoc.length,
        sample: items.slice(0, 2).map((i) => ({
          id: i.id,
          locationCreated: i.locationCreated ?? null,
        })),
      });
    } catch (e) {
      log("item_list", `FAIL ${e.message}`);
    }
  }

  const htmlBrowser = await fetchLocationCreatedFromVideoHtmlRequest(page, username, videoId);
  log("html_browser", htmlBrowser);

  const htmlLen = await page.evaluate(async (args) => {
    const url = `https://www.tiktok.com/@${args.u}/video/${args.v}`;
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();
    return {
      status: res.status,
      len: html.length,
      hasUniversal: html.includes("__UNIVERSAL_DATA_FOR_REHYDRATION__"),
      hasSigi: html.includes("SIGI_STATE"),
    };
  }, { u: username, v: videoId });
  log("html_browser_meta", htmlLen);

  const htmlNode = await fetchLocationCreatedFromVideoHtmlViaNode(page, username, videoId);
  log("html_node", htmlNode);

  if (typeof page.getTiktokCookies === "function") {
    const cookies = await page.getTiktokCookies();
    log("cookies", { count: Object.keys(cookies).length, hasMsToken: !!cookies.msToken });
  }
} finally {
  await session.dispose();
}
