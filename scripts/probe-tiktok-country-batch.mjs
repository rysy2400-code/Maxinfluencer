#!/usr/bin/env node
/**
 * 诊断 Lite 国家预筛：对关键词搜索前 N 人逐条 resolve locationCreated
 * 用法:
 *   node scripts/probe-tiktok-country-batch.mjs "AI design tool demo" 20
 *   TT_LITE_COUNTRY_DISABLE_NAV=1 node scripts/probe-tiktok-country-batch.mjs "AI design tool demo" 20
 *   node scripts/probe-tiktok-country-batch.mjs --api-only "AI design tool demo" 20
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

const argv = process.argv.slice(2);
const apiOnlyFlag = argv[0] === "--api-only";
if (apiOnlyFlag) argv.shift();

let concurrencyArg = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--concurrency" && argv[i + 1]) {
    concurrencyArg = Number(argv[i + 1]);
    argv.splice(i, 2);
    break;
  }
  if (argv[i]?.startsWith("--concurrency=")) {
    concurrencyArg = Number(argv[i].slice("--concurrency=".length));
    argv.splice(i, 1);
    break;
  }
}

if (apiOnlyFlag || process.env.TT_LITE_COUNTRY_API_ONLY === "1") {
  process.env.TT_LITE_ALLOW_NAV = "0";
  process.env.TT_LITE_COUNTRY_DISABLE_NAV = "1";
  process.env.TT_LITE_COUNTRY_VIDEO_INFO = "0";
  process.env.TT_LITE_COUNTRY_STUB_DOCUMENT = "0";
  process.env.TT_LITE_COUNTRY_HTML_FIRST = "0";
  process.env.TT_LITE_COUNTRY_API_ONLY = "1";
}

const keyword = argv[0] || "AI design tool demo";
const maxCount = Math.min(Math.max(Number(argv[1] || 20), 1), 40);
const endpoint =
  process.env.TT_LITE_COUNTRY_CDP ||
  process.env.CDP_ENDPOINT ||
  "http://127.0.0.1:9222";
const probeDelay = Number(process.env.TT_LITE_COUNTRY_PROBE_DELAY_MS || 400);
const concurrency = Math.max(
  1,
  Math.min(
    Number.isFinite(concurrencyArg) && concurrencyArg > 0
      ? concurrencyArg
      : Number(process.env.TT_LITE_COUNTRY_CONCURRENCY || 3),
    10
  )
);
const apiOnly =
  process.env.TT_LITE_COUNTRY_DISABLE_NAV === "1" ||
  process.env.TT_LITE_ALLOW_NAV === "0";

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

console.log(
  `[probe] mode=${apiOnly ? "api-only (signed item_detail + item_list, no page nav)" : "lite+nav"} endpoint=${endpoint} keyword="${keyword}" batch=${maxCount} concurrency=${concurrency}`
);

/** @type {Array<{ page: object, dispose: Function }>} */
const pool = [];
let searchSession = null;
try {
  searchSession = await acquireTiktokApiSession(null, { endpointKey: endpoint });
  const batches = await fetchSearchItemFullAll(searchSession.page, keyword, {
    maxPages: 3,
  });
  const videos = [];
  for (const b of batches) videos.push(...extractVideosFromSearchAPI(b));
  const recs = extractInfluencersFromVideos(videos);
  const queue = orderInfluencersForCountryCheck(recs, videos, maxCount);
  console.log(
    `[probe] search done: ${videos.length} videos, ${queue.length} influencers to check`
  );

  pool.push(searchSession);
  searchSession = null;
  const { resolveLiteCdpTabPoolSize } = await import("../lib/scraper/resolve-scraper-mode.js");
  const tabPoolSize = resolveLiteCdpTabPoolSize();
  for (let i = 1; i < tabPoolSize; i += 1) {
    const session = await acquireTiktokApiSession(null, {
      endpointKey: endpoint,
      forceNewTab: false,
    });
    pool.push(session);
  }
  console.log(`[probe] CDP pool ready: ${pool.length} tab(s) (concurrency=${concurrency})`);

  const videoByUser = new Map();
  const altVideosByUser = new Map();
  for (const v of videos) {
    const u = String(v.username || "").replace(/^@/, "");
    if (!u) continue;
    if (!videoByUser.has(u)) videoByUser.set(u, v);
    const vid = String(v.videoId || "").trim();
    if (!vid) continue;
    if (!altVideosByUser.has(u)) altVideosByUser.set(u, []);
    const list = altVideosByUser.get(u);
    if (!list.includes(vid)) list.push(vid);
  }

  async function probeOne(rec, sessionIdx) {
    const stagger = Number(process.env.TT_LITE_COUNTRY_PROBE_STAGGER_MS || 80);
    if (stagger > 0 && sessionIdx > 0) {
      await new Promise((r) => setTimeout(r, (sessionIdx % concurrency) * stagger));
    }
    const u = String(rec.username || "").replace(/^@/, "");
    const src = videoByUser.get(u);
    const primaryVid = rec.representativeVideoId || src?.videoId || "";
    const altVideoIds = (altVideosByUser.get(u) || []).filter(
      (id) => id && id !== primaryVid
    );
    const page = pool[sessionIdx % pool.length].page;
    try {
      return await resolveVideoLocationCreatedForInfluencer(page, {
        username: u,
        videoId: primaryVid,
        altVideoIds,
        secUid: rec.secUid || rec.tiktokSecUid || src?.creator?.secUid || "",
        searchLocation: src?.locationCreated || null,
      });
    } catch (e) {
      return {
        locationCreated: null,
        source: null,
        error: e.message,
        representativeVideoId: primaryVid || null,
      };
    }
  }

  let ok = 0;
  const failures = [];
  const results = new Array(queue.length);

  for (let start = 0; start < queue.length; start += concurrency) {
    const subBatch = queue.slice(start, start + concurrency);
    const probes = await Promise.all(
      subBatch.map((rec, j) => probeOne(rec, start + j))
    );
    for (let j = 0; j < subBatch.length; j += 1) {
      const rec = subBatch[j];
      const u = String(rec.username || "").replace(/^@/, "");
      const probe = probes[j];
      const idx = start + j;
      results[idx] = { u, probe, rec };
      if (probe.locationCreated) ok += 1;
      else failures.push({ username: u, error: probe.error, vid: probe.representativeVideoId });
    }
    if (probeDelay > 0 && start + concurrency < queue.length) {
      await pool[0].page.waitForTimeout(probeDelay);
    }
  }

  for (let i = 0; i < results.length; i += 1) {
    const { u, probe, rec } = results[i];
    console.log(
      `${String(i + 1).padStart(2)}. @${u.padEnd(22)} loc=${(probe.locationCreated || "NULL").padEnd(4)} src=${probe.source || "-"} vid=${probe.representativeVideoId || rec.representativeVideoId || "-"}${probe.error ? ` err=${probe.error}` : ""}`
    );
  }
  console.log(`\n[probe] locationCreated 覆盖: ${ok}/${queue.length}`);
  if (failures.length) {
    console.log(
      `[probe] 未命中: ${failures.map((f) => `@${f.username}`).join(", ")}`
    );
  }
  if (process.env.TT_LITE_COUNTRY_VIDEO_INFO_CHAIN === "1" && pool[0]?.page) {
    await pool[0].page
      .goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 45_000 })
      .catch(() => {});
  }
  process.exitCode = ok === queue.length ? 0 : 1;
} finally {
  for (const session of pool) {
    try {
      await session.dispose();
    } catch {
      /* ignore */
    }
  }
  if (searchSession) {
    try {
      await searchSession.dispose();
    } catch {
      /* ignore */
    }
  }
}
