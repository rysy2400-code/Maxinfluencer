#!/usr/bin/env node
/**
 * 测试 9222/9223 能否用 TikTok-Api Video.info() 思路
 * （视频页 HTML → UNIVERSAL → itemStruct.locationCreated）拿到发布地区
 *
 * 用法: node scripts/probe-tt9223-universal-country.mjs [username] [videoId]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const username = process.argv[2] || "melissametrano";
const videoId = process.argv[3] || "7630175471774256415";
const videoUrl = `https://www.tiktok.com/@${username}/video/${videoId}`;

const UNIVERSAL_MARKER =
  '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">';

function parseLocationFromHtml(html) {
  const start = html.indexOf(UNIVERSAL_MARKER);
  if (start < 0) return { hasUniversal: false, locationCreated: null };
  const jsonStart = start + UNIVERSAL_MARKER.length;
  const jsonEnd = html.indexOf("</script>", jsonStart);
  if (jsonEnd < 0) return { hasUniversal: false, locationCreated: null };
  const data = JSON.parse(html.slice(jsonStart, jsonEnd));
  const item =
    data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
    data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo?.itemStruct;
  return {
    hasUniversal: true,
    locationCreated: item?.locationCreated ?? null,
    videoIdInStruct: item?.id ?? null,
  };
}

async function probeBrowserFetch(endpoint, label) {
  const { acquireTiktokApiSession, fetchLocationCreatedFromVideoHtmlRequest } =
    await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");
  const session = await acquireTiktokApiSession(null, {
    endpointKey: endpoint,
    forceNewTab: false,
  });
  try {
    const { page } = session;
    const raw = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        credentials: "include",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": navigator.language,
          referer: "https://www.tiktok.com/",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
          "upgrade-insecure-requests": "1",
        },
      });
      const html = await res.text();
      return { ok: res.ok, status: res.status, len: html.length, html };
    }, videoUrl);

    const parsed = parseLocationFromHtml(raw.html);
    const helperLoc = await fetchLocationCreatedFromVideoHtmlRequest(
      page,
      username,
      videoId
    );

    return {
      label,
      endpoint,
      method: "page.evaluate(fetch)",
      ok: raw.ok,
      status: raw.status,
      htmlLen: raw.len,
      ...parsed,
      helperLoc,
    };
  } finally {
    await session.dispose();
  }
}

async function probeNodeFetchWithCdpCookies(endpoint, label) {
  const { acquireTiktokApiSession } = await import(
    "../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js"
  );
  const session = await acquireTiktokApiSession(null, {
    endpointKey: endpoint,
    forceNewTab: false,
  });
  try {
    const { page } = session;
    const ua = await page.evaluate(() => navigator.userAgent);
    let cookies = {};
    if (typeof page.getTiktokCookies === "function") {
      cookies = await page.getTiktokCookies();
    } else {
      cookies = await page.evaluate(() => {
        const out = {};
        for (const part of String(document.cookie || "").split(";")) {
          const idx = part.indexOf("=");
          if (idx <= 0) continue;
          out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
        }
        return out;
      });
    }
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    const res = await fetch(videoUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        referer: "https://www.tiktok.com/",
        "user-agent": ua,
        cookie: cookieHeader,
      },
      redirect: "follow",
    });
    const html = await res.text();
    const parsed = parseLocationFromHtml(html);
    return {
      label,
      endpoint,
      method: "node fetch + CDP cookies (TikTok-Api style)",
      ok: res.ok,
      status: res.status,
      htmlLen: html.length,
      cookieCount: Object.keys(cookies).length,
      hasMsToken: !!(cookies.msToken || cookies.mstoken),
      ...parsed,
    };
  } finally {
    await session.dispose();
  }
}

console.log(`\n[probe] video=${videoUrl}\n`);

const endpoints = [
  ["9223", process.env.CDP_ENDPOINT_ENRICH || "http://127.0.0.1:9223"],
  ["9222", process.env.CDP_ENDPOINT || "http://127.0.0.1:9222"],
];

const results = [];
for (const [label, endpoint] of endpoints) {
  try {
    results.push(await probeBrowserFetch(endpoint, label));
  } catch (e) {
    results.push({ label, endpoint, method: "page.evaluate(fetch)", error: e.message });
  }
  try {
    results.push(await probeNodeFetchWithCdpCookies(endpoint, label));
  } catch (e) {
    results.push({
      label,
      endpoint,
      method: "node fetch + CDP cookies",
      error: e.message,
    });
  }
}

console.log(JSON.stringify(results, null, 2));

const ok9223 = results.some(
  (r) =>
    r.endpoint?.includes("9223") &&
    r.locationCreated != null &&
    r.locationCreated !== ""
);
console.log("\n[probe] 9223 locationCreated usable:", ok9223 ? "YES" : "NO");
process.exit(ok9223 ? 0 : 1);
