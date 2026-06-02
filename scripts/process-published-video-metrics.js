/**
 * Worker：定时刷新已发布视频的播放/点赞/评论（TikTok / Instagram / YouTube）。
 * 通过 CDP 连接 Chrome，拦截各平台 API 响应抓取 metrics。
 *
 * 环境变量：
 * - CDP_ENDPOINT_METRICS / CDP_ENDPOINT：CDP 地址，默认 http://127.0.0.1:9222
 * - PUBLISHED_METRICS_BATCH_SIZE：每 tick 最多处理条数，默认 20
 * - PUBLISHED_METRICS_REFRESH_HOURS：同一视频最短刷新间隔（小时），默认 6
 * - PUBLISHED_METRICS_DELAY_MS：每条视频之间的间隔，默认 2500
 *
 * 使用：node scripts/process-published-video-metrics.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  pickPublishedExecutionsForMetricsRefresh,
  updatePublishedExecutionMetrics,
  resolveBatchSize,
  resolveRefreshHours,
} from "../lib/db/published-video-metrics-dao.js";
import { fetchPublishedVideoMetricsViaCdp } from "../lib/execution/published-video-metrics-cdp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

function resolveCdpEndpoint() {
  return (
    process.env.CDP_ENDPOINT_METRICS ||
    process.env.CDP_ENDPOINT_ENRICH ||
    process.env.CDP_ENDPOINT ||
    "http://127.0.0.1:9222"
  );
}

function resolveDelayMs() {
  const n = Number(process.env.PUBLISHED_METRICS_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2500;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const batchSize = resolveBatchSize();
  const refreshHours = resolveRefreshHours();
  const endpoint = resolveCdpEndpoint();
  const delayMs = resolveDelayMs();

  const rows = await pickPublishedExecutionsForMetricsRefresh(batchSize);
  if (!rows.length) {
    console.log(
      `[PublishedVideoMetrics] 无待刷新记录（batch=${batchSize}, refresh=${refreshHours}h）。`
    );
    return;
  }

  console.log(
    `[PublishedVideoMetrics] 准备刷新 ${rows.length} 条（CDP=${endpoint}）。`
  );

  let browser;
  let page;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
    const context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();
    try {
      await page.bringToFront();
    } catch {
      /* ignore */
    }
  } catch (err) {
    console.error(
      "[PublishedVideoMetrics] CDP 连接失败:",
      err?.message || err
    );
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;

  for (const row of rows) {
    const influencerKey = row.tiktok_username;
    const { campaign_id: campaignId, videoLink, platform, parsedVideo } = row;

    console.log(
      `[PublishedVideoMetrics] ${campaignId}/${influencerKey} platform=${platform} url=${videoLink}`
    );

    try {
      const metrics = await fetchPublishedVideoMetricsViaCdp(page, videoLink);
      await updatePublishedExecutionMetrics(campaignId, influencerKey, {
        metrics,
        videoLink,
      });
      console.log(
        `[PublishedVideoMetrics] ✓ views=${metrics.viewsDisplay} likes=${metrics.likesDisplay} comments=${metrics.commentsDisplay} source=${metrics.source}`
      );
      ok += 1;
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(`[PublishedVideoMetrics] ✗ ${campaignId}/${influencerKey}: ${msg}`);
      await updatePublishedExecutionMetrics(campaignId, influencerKey, {
        videoLink,
        error: msg,
      });
      fail += 1;
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  try {
    await page.close();
  } catch {
    /* ignore */
  }
  try {
    await browser.close();
  } catch {
    /* ignore */
  }

  console.log(
    `[PublishedVideoMetrics] 完成：成功 ${ok}，失败 ${fail}，合计 ${rows.length}。`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[PublishedVideoMetrics] 运行出错:", err);
    process.exit(1);
  });
