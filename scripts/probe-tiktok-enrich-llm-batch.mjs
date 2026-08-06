#!/usr/bin/env node
/**
 * TikTok Lite enrich + LLM 并发测试：9223 post/item_list 拉 50 视频 + analyzeInfluencerMatch
 *   node scripts/probe-tiktok-enrich-llm-batch.mjs "AI design tool demo" 10
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

process.env.SCRAPER_MODE = "lite";
process.env.TT_LITE_MAX_VIDEOS = process.env.TT_LITE_MAX_VIDEOS || "50";
process.env.TT_LITE_ALLOW_NAV = "0";

const keyword = process.argv[2] || "AI design tool demo";
const maxCount = Math.min(Math.max(Number(process.argv[3] || 10), 1), 300);
const concurrency = Math.max(
  1,
  Math.min(Number(process.env.LITE_TT_ENRICH_CONCURRENCY || 10), 150)
);
const searchEndpoint =
  process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const enrichEndpoint =
  process.env.TT_LITE_ENRICH_CDP ||
  process.env.CDP_ENDPOINT_ENRICH ||
  "http://127.0.0.1:9223";
const targetVideos = Number(process.env.TT_LITE_MAX_VIDEOS || 50);

const influencerProfile = {
  followerRange: "10K-500K",
  contentStyle: "AI design tool review, tutorial, demo",
  targetAudience: "creators, designers, beginners",
};
const productInfo = {
  productName: "AI design tool",
  productCategory: "SaaS / design",
  keyFeatures: ["AI-assisted design", "beginner friendly", "templates"],
};
const campaignInfo = {
  platform: ["TikTok"],
  targetCountry: "US",
};

const {
  acquireTiktokApiSession,
  fetchSearchItemFullAll,
} = await import("../lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js");
const { extractTiktokProfileLite } = await import(
  "../lib/tools/influencer-functions/tiktok/extract-tiktok-profile-lite.js"
);
const {
  extractVideosFromSearchAPI,
  extractInfluencersFromVideos,
} = await import("../lib/tools/influencer-functions/extract-search-results-cdp.js");
const { orderInfluencersForCountryCheck } = await import(
  "../lib/tools/influencer-functions/resolve-video-publish-country.js"
);
const { analyzeInfluencerMatch } = await import(
  "../lib/tools/influencer-functions/analyze-influencer-match.js"
);

console.log(
  `[enrich-llm-probe] keyword="${keyword}" batch=${maxCount} concurrency=${concurrency} targetVideos=${targetVideos}`
);
console.log(`  search=${searchEndpoint} enrich=${enrichEndpoint}`);

const t0 = Date.now();
/** @type {Array<{ page: object, dispose: Function }>} */
const pool = [];
let searchSession = null;

try {
  searchSession = await acquireTiktokApiSession(null, { endpointKey: searchEndpoint });
  const batches = await fetchSearchItemFullAll(searchSession.page, keyword, { maxPages: 3 });
  const videos = [];
  for (const b of batches) videos.push(...extractVideosFromSearchAPI(b));
  const recs = extractInfluencersFromVideos(videos);
  const queue = orderInfluencersForCountryCheck(recs, videos, maxCount);
  console.log(`[enrich-llm-probe] search done: ${videos.length} videos, ${queue.length} influencers`);

  pool.push(
    await acquireTiktokApiSession(null, { endpointKey: enrichEndpoint })
  );
  const { resolveLiteCdpTabPoolSize } = await import("../lib/scraper/resolve-scraper-mode.js");
  const tabPoolSize = resolveLiteCdpTabPoolSize();
  for (let i = 1; i < tabPoolSize; i += 1) {
    pool.push(
      await acquireTiktokApiSession(null, {
        endpointKey: enrichEndpoint,
        forceNewTab: false,
      })
    );
  }
  console.log(`[enrich-llm-probe] enrich CDP pool: ${pool.length} tab(s) (concurrency=${concurrency})`);

  async function enrichAndAnalyze(rec, idx) {
    const u = String(rec.username || "").replace(/^@/, "");
    const src = videos.find((v) => String(v.username || "").replace(/^@/, "") === u);
    const page = pool[idx % pool.length].page;
    const row = {
      username: u,
      videos: 0,
      avgViews: null,
      enrichOk: false,
      llmOk: false,
      recommended: null,
      score: null,
      error: null,
    };
    try {
      const profile = await extractTiktokProfileLite(page, u, {
        secUid: rec.secUid || rec.tiktokSecUid || src?.creator?.secUid || "",
        userId: src?.creator?.id || "",
      });
      row.videos = profile.videos?.length || 0;
      row.avgViews = profile.statistics?.avgViews ?? null;
      row.enrichOk = profile.success && row.videos > 0;

      if (!row.enrichOk) {
        row.error = profile.error || "enrich_empty";
        return row;
      }

      const merged = {
        username: u,
        displayName: profile.userInfo?.displayName || u,
        profileUrl: profile.userInfo?.profileUrl || `https://www.tiktok.com/@${u}`,
        followers: profile.userInfo?.followers,
        bio: profile.userInfo?.bio || "",
        verified: profile.userInfo?.verified || false,
        videos: profile.videos,
        profile_data: profile,
        statistics: profile.statistics,
        platform: "TikTok",
      };

      const analysis = await analyzeInfluencerMatch(
        merged,
        influencerProfile,
        productInfo,
        campaignInfo
      );
      row.llmOk = !!analysis && analysis.success !== false;
      row.recommended = analysis?.isRecommended ?? null;
      row.score = analysis?.score ?? null;
      if (!row.llmOk) row.error = analysis?.reason || "llm_failed";
    } catch (e) {
      row.error = e.message;
    }
    return row;
  }

  const results = [];
  for (let start = 0; start < queue.length; start += concurrency) {
    const sub = queue.slice(start, start + concurrency);
    const rows = await Promise.all(
      sub.map((rec, j) => enrichAndAnalyze(rec, start + j))
    );
    results.push(...rows);
    for (const row of rows) {
      const flag = row.enrichOk && row.llmOk ? "✅" : "❌";
      console.log(
        `${flag} @${row.username.padEnd(22)} videos=${String(row.videos).padStart(2)}/${targetVideos} avgViews=${row.avgViews ?? "-"} llm=${row.recommended === true ? "Y" : row.recommended === false ? "N" : "-"} score=${row.score ?? "-"}${row.error ? ` err=${row.error}` : ""}`
      );
    }
  }

  const enrichOk = results.filter((r) => r.enrichOk).length;
  const videos50 = results.filter((r) => r.videos >= targetVideos).length;
  const llmOk = results.filter((r) => r.llmOk).length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("\n[enrich-llm-probe] === 汇总 ===");
  console.log(`  enrich 成功:     ${enrichOk}/${results.length}`);
  console.log(`  ≥${targetVideos} 视频:    ${videos50}/${results.length}`);
  console.log(`  LLM 分析成功:    ${llmOk}/${results.length}`);
  console.log(`  耗时:            ${elapsed}s (concurrency=${concurrency})`);

  process.exitCode =
    enrichOk === results.length && llmOk === results.length ? 0 : 1;
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
