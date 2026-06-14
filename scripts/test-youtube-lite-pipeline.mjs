#!/usr/bin/env node
/**
 * YouTube Lite 全流程测试 + 与 Standard 的理论/日志基线对比（无需重跑 Standard）
 *
 * 用法（爬虫机 9222 已登录 YouTube）:
 *   SCRAPER_MODE=lite node scripts/test-youtube-lite-pipeline.mjs "cat litter box" 3
 *
 * 环境变量:
 *   SCRAPER_MODE=lite（必须）
 *   LITE_YT_ENRICH_CONCURRENCY=3
 *   ENRICH_NO_ANALYZE=1  跳过 LLM 分析加快冒烟
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

process.env.SCRAPER_MODE = "lite";
process.env.LITE_DISABLE_SCREENSHOTS = process.env.LITE_DISABLE_SCREENSHOTS || "true";
process.env.ENRICH_BATCH_POLICY = process.env.ENRICH_BATCH_POLICY || "false";
process.env.SEARCH_MAX_POOL_SIZE = process.env.SEARCH_MAX_POOL_SIZE || "40";
process.env.YT_LITE_CONTINUATION_DELAY_MS = process.env.YT_LITE_CONTINUATION_DELAY_MS || "40";
process.env.YT_LITE_SESSION_SETTLE_MS = process.env.YT_LITE_SESSION_SETTLE_MS || "1200";

const keyword = process.argv[2] || "cat litter review";
const maxEnrich = Math.min(Number(process.argv[3] || 3), 8);
const enrichNoAnalyze = process.env.ENRICH_NO_ANALYZE === "1";

/** Standard 模式单任务耗时/流量基线（来自现有实现参数推算，非本次实测） */
const STANDARD_BASELINE = {
  search: {
    gotoMs: 18_000,
    settleMs: 1_000,
    scrollRounds: 6,
    scrollWaitMs: 3_500,
    continuationDelayMs: 60,
    estimatedPageLoads: 1,
    estimatedTrafficMb: "8–25",
    estimatedSeconds: "60–120",
  },
  enrichPerChannel: {
    gotoVideosMs: 30_000,
    settleMs: 2_500,
    scrollRounds: 15,
    apiWaitMs: 12_000,
    aboutGotoMs: 18_000,
    estimatedPageLoads: 2,
    estimatedTrafficMb: "10–30",
    estimatedSeconds: "90–240",
  },
  notes:
    "Standard 基线由 goto/scroll/wait 参数推算；Lite 为本次实测值。",
};

async function ensureCdp() {
  try {
    const r = await fetch(process.env.CDP_ENDPOINT || "http://127.0.0.1:9222/json/version");
    return r.ok;
  } catch {
    return false;
  }
}

function attachTrafficMeter(page) {
  const stats = { bytes: 0, requests: 0, apiRequests: 0, apiBytes: 0 };
  const handler = async (response) => {
    try {
      const url = response.url();
      const headers = response.headers();
      const cl = Number(headers["content-length"] || 0);
      let size = cl;
      if (!size) {
        try {
          const body = await response.body();
          size = body?.length || 0;
        } catch {
          size = 0;
        }
      }
      stats.bytes += size;
      stats.requests += 1;
      if (url.includes("/youtubei/v1/")) {
        stats.apiRequests += 1;
        stats.apiBytes += size;
      }
    } catch {
      /* ignore */
    }
  };
  page.on("response", handler);
  return {
    stats,
    detach: () => page.off("response", handler),
  };
}

if (!(await ensureCdp())) {
  console.error("[yt-lite-test] CDP 9222 未就绪，请先启动 Chrome 并登录 YouTube");
  process.exit(2);
}

console.log("=".repeat(72));
console.log(`[yt-lite-test] SCRAPER_MODE=lite keyword="${keyword}" maxEnrich=${maxEnrich}`);
console.log("=".repeat(72));

const t0 = Date.now();
let traffic = { bytes: 0, requests: 0, apiRequests: 0, apiBytes: 0 };

const { searchAndExtractInfluencers } = await import(
  "../lib/tools/influencer-functions/search-and-extract-influencers.js"
);

const result = await searchAndExtractInfluencers(
  {
    keywords: { search_queries: [keyword] },
    platform: "youtube",
    platforms: ["YouTube"],
    campaignInfo: { platform: ["YouTube"] },
    productInfo: { productName: "Lite pipeline test" },
    influencerProfile: enrichNoAnalyze
      ? null
      : {
          followerRange: "10K-500K",
          contentStyle: "pet product review",
        },
  },
  {
    maxResults: maxEnrich + 10,
    maxEnrichCount: maxEnrich,
    enrichProfileData: true,
    platform: "youtube",
  }
);

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
const influencers = result.influencers || [];

const liteReport = {
  mode: "lite",
  keyword,
  maxEnrich,
  elapsedSec: Number(elapsedSec),
  success: false,
  influencerCount: influencers.length,
  channels: influencers.slice(0, maxEnrich).map((inf) => ({
    username: inf.username,
    country: inf.video_publish_country ?? inf.profile_data?.userInfo?.country ?? null,
    videos: inf.profile_data?.videos?.length ?? inf.videos?.length ?? 0,
    followers: inf.profile_data?.userInfo?.followers?.display ?? inf.followers?.display,
    recommended: inf.isRecommended,
    extractionSource: inf.profile_data?.extractionSource ?? null,
  })),
  traffic: {
    note: "流量统计需在 innertube 会话页挂载；此处记录任务总耗时与输出质量",
    measuredInScript: traffic,
  },
  standardBaselineComparison: {
    standardEstimatedTotalSec: `${60 + maxEnrich * 90}–${120 + maxEnrich * 240}`,
    liteMeasuredSec: elapsedSec,
    speedupEstimate: `约 ${(90 / Math.max(Number(elapsedSec), 1)).toFixed(1)}–${(180 / Math.max(Number(elapsedSec), 1)).toFixed(1)}×（相对 Standard 推算）`,
    standardTrafficPerTaskMb: `${8 + maxEnrich * 10}–${25 + maxEnrich * 30}`,
    liteTrafficEstimateMb: "约 2–8（仅 youtube.com 引导 + innertube JSON）",
    trafficSavingEstimate: "约 85–95%",
    baseline: STANDARD_BASELINE,
  },
};

liteReport.success =
  result.success &&
  influencers.length > 0 &&
  liteReport.channels.some((c) => (c.videos || 0) > 0);
const ok = liteReport.success;

const logsDir = path.join(root, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const outPath = path.join(
  logsDir,
  `youtube-lite-test-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);
fs.writeFileSync(outPath, JSON.stringify(liteReport, null, 2), "utf-8");

console.log("\n--- Lite 实测结果 ---");
console.log(`耗时: ${elapsedSec}s`);
console.log(`成功: ${ok}`);
console.log(`红人数: ${influencers.length}`);
for (const c of liteReport.channels) {
  console.log(
    `  @${c.username} country=${c.country || "(空)"} videos=${c.videos} followers=${c.followers || "?"} source=${c.extractionSource || "?"}`
  );
}

console.log("\n--- vs Standard 基线（无需重跑原版）---");
console.log(`Standard 推算耗时: ${liteReport.standardBaselineComparison.standardEstimatedTotalSec}s`);
console.log(`Lite 实测耗时:     ${elapsedSec}s`);
console.log(`提速估算:        ${liteReport.standardBaselineComparison.speedupEstimate}`);
console.log(`Standard 推算流量: ${liteReport.standardBaselineComparison.standardTrafficPerTaskMb} MB/任务`);
console.log(`Lite 估算流量:     ${liteReport.standardBaselineComparison.liteTrafficEstimateMb}`);
console.log(`省流估算:        ${liteReport.standardBaselineComparison.trafficSavingEstimate}`);
console.log(`\n报告已写入: ${outPath}`);

process.exit(ok ? 0 : 1);
