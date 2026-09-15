/**
 * Worker：定时刷新已发布视频的播放/点赞/评论（TikTok / Instagram / YouTube）。
 * - TikTok：9222 + 青果美国代理，API 直调（不打开视频页），图片/媒体/字体本地拦截，统计流量；
 * - Instagram：9223 直连（登录 profile）；YouTube：9224 直连。
 *
 * 环境变量：
 * - PUBLISHED_METRICS_PLATFORM：tiktok | instagram | youtube（也可用 --platform= 参数）
 * - PUBLISHED_METRICS_CDP_TIKTOK / _INSTAGRAM / _YOUTUBE：各平台 CDP 地址，默认 9222/9223/9224
 * - PUBLISHED_METRICS_BATCH_SIZE：每 tick 最多处理条数，默认 20
 * - PUBLISHED_METRICS_REFRESH_HOURS：同一视频最短刷新间隔（小时），默认 1
 * - PUBLISHED_METRICS_DELAY_MS：每条视频之间的间隔，默认 2500
 * - PUBLISHED_METRICS_QG_ROTATE=1：TikTok 运行前先轮换青果美国短效代理
 * - PUBLISHED_METRICS_LOCAL_PROXY_PORT：TikTok 本地代理端口，默认 7897
 *
 * 使用：node scripts/process-published-video-metrics.js
 */

import dotenv from "dotenv";
import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  pickPublishedVideoMetricTasks,
  updatePublishedVideoMetrics,
  resolveCdpEndpointForPlatform,
  resolveBatchSize,
  resolveRefreshHours,
} from "../lib/db/published-video-metrics-dao.js";
import {
  fetchPublishedVideoMetricsViaCdp,
  fetchTikTokMetrics,
} from "../lib/execution/published-video-metrics-cdp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TRAFFIC_LOG = path.join(projectRoot, "logs", "published-metrics-traffic.log");

function resolvePlatform() {
  const arg = process.argv.find((a) => a.startsWith("--platform="));
  const raw = String(
    arg ? arg.split("=")[1] : process.env.PUBLISHED_METRICS_PLATFORM || ""
  )
    .trim()
    .toLowerCase();
  if (["tiktok", "instagram", "youtube"].includes(raw)) return raw;
  return null;
}

function logTraffic(line) {
  try {
    fs.mkdirSync(path.dirname(TRAFFIC_LOG), { recursive: true });
    fs.appendFileSync(
      TRAFFIC_LOG,
      `${new Date().toISOString()} ${line}\n`,
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

function resolveDelayMs() {
  const n = Number(process.env.PUBLISHED_METRICS_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2500;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const platformFilter = resolvePlatform();
  const batchSize = resolveBatchSize();
  const refreshHours = resolveRefreshHours();
  const delayMs = resolveDelayMs();

  const tasks = await pickPublishedVideoMetricTasks(batchSize, platformFilter);
  if (!tasks.length) {
    console.log(
      `[PublishedVideoMetrics] 无待刷新记录（platform=${platformFilter || "all"}, batch=${batchSize}, refresh=${refreshHours}h）。`
    );
    return;
  }

  // 按平台分组：CDP 端点 / 代理轮换 / 浏览器连接按平台各做一次
  const groups = new Map();
  for (const task of tasks) {
    if (!groups.has(task.platform)) groups.set(task.platform, []);
    groups.get(task.platform).push(task);
  }

  console.log(
    `[PublishedVideoMetrics] 准备刷新 ${tasks.length} 条视频（platform=${platformFilter || "all"}, 分组=${[...groups.entries()]
      .map(([p, l]) => `${p}:${l.length}`)
      .join(",")}, refresh=${refreshHours}h）。`
  );

  let ok = 0;
  let fail = 0;
  let totalBytes = 0;

  for (const [platform, list] of groups) {
    const endpoint = resolveCdpEndpointForPlatform(platform);

    // TikTok：运行前轮换青果美国短效代理（写 mihomo 配置 -> 重启 -> 校验 US 出口）
    if (platform === "tiktok" && isQqRotateEnabled()) {
      try {
        const { rotateQgShortProxy } = await import("../lib/ops/tiktok-session-manager.js");
        const proxyPort = Number(process.env.PUBLISHED_METRICS_LOCAL_PROXY_PORT || 7897);
        const r = await rotateQgShortProxy(proxyPort);
        console.log(
          `[PublishedVideoMetrics] qg rotate: ok=${r.ok} skipped=${r.skipped} ip=${r.ip || "-"} proxyPort=${r.proxyPort}${r.error ? " err=" + r.error : ""}`
        );
        if (!r.ok && !r.skipped) {
          console.warn(`[PublishedVideoMetrics] 青果代理轮换失败，继续尝试刷新（可能拿到旧出口）: ${r.error}`);
        }
      } catch (e) {
        console.warn(`[PublishedVideoMetrics] 青果代理轮换异常，继续: ${e?.message || e}`);
      }
    }

    let browser = null;
    let page = null;
    const needBrowser = platform !== "tiktok";
    if (needBrowser) {
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
          `[PublishedVideoMetrics] ${platform} CDP 连接失败，跳过该平台 ${list.length} 条:`,
          err?.message || err
        );
        if (!platformFilter) continue;
        process.exit(1);
      }
    }

    for (const task of list) {
      const { campaignId, influencerKey, videoLink, parsedVideo } = task;

      console.log(
        `[PublishedVideoMetrics] ${campaignId}/${influencerKey} platform=${platform} url=${videoLink}`
      );

      try {
        const metrics =
          platform === "tiktok"
            ? await fetchTikTokMetrics(parsedVideo, {
                endpoint,
                proxyPort: Number(process.env.PUBLISHED_METRICS_LOCAL_PROXY_PORT || 7897),
              })
            : await fetchPublishedVideoMetricsViaCdp(page, videoLink, {
                endpoint,
              });
        await updatePublishedVideoMetrics(campaignId, influencerKey, {
          metrics,
          videoLink,
          platform,
        });
        const bytes = Number(metrics?.trafficBytes) || 0;
        totalBytes += bytes;
        console.log(
          `[PublishedVideoMetrics] ✓ views=${metrics.viewsDisplay} likes=${metrics.likesDisplay} comments=${metrics.commentsDisplay} source=${metrics.source} bytes=${bytes}`
        );
        logTraffic(
          `platform=${platform} campaign=${campaignId} user=${influencerKey} source=${metrics.source} bytes=${bytes}`
        );
        ok += 1;
      } catch (err) {
        const msg = err?.message || String(err);
        console.warn(
          `[PublishedVideoMetrics] ✗ ${campaignId}/${influencerKey} platform=${platform}: ${msg}`
        );
        logTraffic(`platform=${platform} campaign=${campaignId} user=${influencerKey} error=${String(msg).slice(0, 300)}`);
        await updatePublishedVideoMetrics(campaignId, influencerKey, {
          videoLink,
          platform,
          error: msg,
        });
        fail += 1;
      }

      if (delayMs > 0) await sleep(delayMs);
    }

    if (needBrowser && page) {
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
    }
    await cleanupTiktokTabs(endpoint, platform);
  }

  const avgBytes = tasks.length ? Math.round(totalBytes / tasks.length) : 0;
  console.log(
    `[PublishedVideoMetrics] 完成：成功 ${ok}，失败 ${fail}，合计 ${tasks.length}，本次流量约 ${totalBytes} 字节（${avgBytes} 字节/条）。`
  );
  logTraffic(
    `run platform=${platformFilter || "all"} ok=${ok} fail=${fail} total=${tasks.length} bytes=${totalBytes} avg=${avgBytes}`
  );
}

/** TikTok 刷新结束后收敛多余 tab（只保留 tiktok.com 首页/第一个） */
async function cleanupTiktokTabs(endpoint, platform) {
  if (platform !== "tiktok") return;
  try {
    const { listCdpPageTargets, closeCdpTarget } = await import(
      "../lib/cdp/cdp-target-page.js"
    );
    const targets = await listCdpPageTargets(endpoint);
    const pages = (targets || []).filter((t) => t?.type === "page");
    if (pages.length <= 1) return;
    const keep =
      pages.find((t) => /^https:\/\/(www\.)?tiktok\.com\/?$/.test(String(t.url || ""))) ||
      pages[0];
    let closed = 0;
    for (const t of pages) {
      if (t.id === keep.id) continue;
      try {
        await closeCdpTarget(endpoint, t.id);
        closed += 1;
      } catch {
        /* ignore */
      }
    }
    if (closed > 0) {
      console.log(
        `[PublishedVideoMetrics] tiktok tab cleanup: closed ${closed}（保留 ${keep.id}）`
      );
    }
  } catch {
    /* ignore */
  }
}

function isQqRotateEnabled() {
  const raw = String(process.env.PUBLISHED_METRICS_QG_ROTATE || "1")
    .trim()
    .toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[PublishedVideoMetrics] 运行出错:", err);
    process.exit(1);
  });
