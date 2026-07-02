#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const username = (process.argv[2] || "creativeshimmy").replace(/^@/, "");
const videoId = process.argv[3] || "7184839160274996522";
const endpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

const {
  acquireTiktokApiSession,
  fetchTiktokApiViaNavigation,
  parseVideoLocationFromDetailJson,
} = await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");
const { bootstrapTiktokWebSession, tiktokMakeRequest } = await import(
  "../lib/tools/influencer-functions/tiktok/tiktok-api-client.js"
);

function toQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

async function signUrl(page, urlWithQuery) {
  return page.evaluate((u) => {
    const s = window.byted_acrawler?.frontierSign?.(u);
    const x = s?.["X-Bogus"] || s?.X_Bogus;
    if (!x) return u;
    return `${u}${u.includes("?") ? "&" : "?"}X-Bogus=${x}`;
  }, urlWithQuery);
}

const session = await acquireTiktokApiSession(null, { endpointKey: endpoint });
const { page } = session;
try {
  const referer = `https://www.tiktok.com/@${username}/video/${videoId}`;
  const boot = await bootstrapTiktokWebSession(page);
  const params = { ...(boot.params || {}), itemId: videoId };
  if (boot.msToken) params.msToken = boot.msToken;
  if (boot.verifyFp) params.verifyFp = boot.verifyFp;

  console.log("[fetch] tiktokMakeRequest item_detail");
  const j1 = await tiktokMakeRequest(
    page,
    "https://www.tiktok.com/api/post/item_detail/",
    { itemId: videoId },
    { referer }
  );
  console.log("[fetch] keys=", Object.keys(j1 || {}), "loc=", parseVideoLocationFromDetailJson(j1));

  const base = `https://www.tiktok.com/api/post/item_detail/?${toQuery(params)}`;
  const signed = await signUrl(page, base);
  console.log("[nav] goto signed API len=", signed.length);
  const j2 = await fetchTiktokApiViaNavigation(page, signed);
  console.log("[nav] keys=", Object.keys(j2 || {}), "loc=", parseVideoLocationFromDetailJson(j2));
  if (j2?.itemInfo?.itemStruct) {
    console.log("[nav] itemStruct.locationCreated=", j2.itemInfo.itemStruct.locationCreated);
  }
} finally {
  await session.dispose();
}
