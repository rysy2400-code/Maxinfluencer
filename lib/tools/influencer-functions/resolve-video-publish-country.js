/**
 * 在 9222 CDP 上为每位红人打开 1 条代表视频详情页，解析 locationCreated 写入 DB。
 */

import {
  countryMatchesPublishLocation,
  normalizeAllowedCountries,
} from "../../influencer/campaign-country-codes.js";
import { BROWSER_STEP_IDS } from "../../utils/browser-steps.js";
import {
  saveVideoPublishCountry,
} from "../../db/tiktok-influencer-dao.js";
import {
  touchSearchTaskLastProgressAt,
  bumpSearchTaskCountryProgress,
  appendSearchTaskCountryOutcome,
} from "../../db/campaign-candidates-dao.js";
import {
  touchImportTaskLastProgressAt,
  bumpImportTaskCountryProgress,
} from "../../db/influencer-import-task-dao.js";
import { guardedGoto } from "../../cdp/cdp-tab-utils.js";
import { isLiteScraperMode } from "../../scraper/resolve-scraper-mode.js";

function normalizeUsername(username) {
  return String(username || "").replace(/^@/, "").trim();
}

function resolveDelayBetweenVideos(override) {
  const envMin = Number(process.env.COUNTRY_VIDEO_DELAY_MIN);
  const envMax = Number(process.env.COUNTRY_VIDEO_DELAY_MAX);
  if (Number.isFinite(envMin) && Number.isFinite(envMax) && envMin > 0 && envMax > 0) {
    return { min: envMin, max: envMax };
  }
  return override || { min: 5000, max: 10000 };
}

function randomDelayMs(range) {
  const min = Number(range?.min ?? 5000);
  const max = Number(range?.max ?? 10000);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractVideoId(url) {
  const m = String(url || "").match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * 按搜索视频出现顺序取前 maxCount 个不重复红人，并绑定代表视频 URL。
 */
export function orderInfluencersForCountryCheck(influencerRecords, videos, maxCount = 20) {
  const byUsername = new Map();
  for (const rec of influencerRecords || []) {
    const u = normalizeUsername(rec.username);
    if (u) byUsername.set(u, rec);
  }

  const ordered = [];
  const seen = new Set();

  for (const video of videos || []) {
    const u = normalizeUsername(video.username);
    if (!u || seen.has(u)) continue;
    const rec = byUsername.get(u);
    if (!rec) continue;

    seen.add(u);
    const videoUrl =
      video.videoUrl ||
      (video.videoId
        ? `https://www.tiktok.com/@${u}/video/${video.videoId}`
        : null);

    ordered.push({
      ...rec,
      username: rec.username || u,
      representativeVideoUrl: videoUrl,
      representativeVideoId: video.videoId || extractVideoId(videoUrl),
    });

    if (ordered.length >= maxCount) break;
  }

  return ordered;
}

export function passesCampaignCountry(videoPublishCountry, allowedCountries) {
  return countryMatchesPublishLocation(
    videoPublishCountry,
    allowedCountries
  );
}

async function reportCountryScreenshot(onStepUpdate, page, username, progress) {
  if (!onStepUpdate || !page || page.isClosed()) return;
  try {
    const screenshot = await Promise.race([
      page.screenshot({ type: "jpeg", quality: 70, fullPage: false }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("截图超时（35秒）")), 35000)
      ),
    ]);
    const dataUrl = `data:image/jpeg;base64,${screenshot.toString("base64")}`;
    onStepUpdate({
      type: "screenshot",
      stepId: BROWSER_STEP_IDS.COUNTRY_CHECK,
      label: `视频发布地 @${username} (${progress})`,
      image: dataUrl,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(
      `[resolveVideoPublishCountry] 截图跳过 @${username}:`,
      e?.message || e
    );
  }
}

function readLocationCreatedFromPage(page, videoId) {
  return page.evaluate((vid) => {
    const uni = document.querySelector(
      'script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]'
    );
    if (!uni?.textContent) return { locationCreated: null, source: null };
    try {
      const data = JSON.parse(uni.textContent);
      const item =
        data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo
          ?.itemStruct ||
        data?.__DEFAULT_SCOPE__?.["webapp.reflow.video.detail"]?.itemInfo
          ?.itemStruct;
      if (item && (!vid || String(item.id) === String(vid))) {
        const loc = item.locationCreated;
        if (loc != null && loc !== "") {
          return { locationCreated: String(loc), source: "UNIVERSAL" };
        }
      }
    } catch {
      /* ignore */
    }
    return { locationCreated: null, source: null };
  }, videoId);
}

async function probeVideoLocationCreated(page, videoUrl) {
  const videoId = extractVideoId(videoUrl);
  if (!videoUrl) {
    return { locationCreated: null, source: null, error: "missing_video_url" };
  }

  try {
    page = await guardedGoto(page, videoUrl, {
      label: "tt_video_country_probe",
      budgetMs: 25_000,
      waitUntil: "domcontentloaded",
      retries: 1,
      createRetryPage: async () => page.context().newPage(),
    });
    await page.waitForTimeout(4000);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      /* ok */
    }
    const dom = await readLocationCreatedFromPage(page, videoId);
    if (dom.locationCreated) return dom;
    return { locationCreated: null, source: dom.source || null };
  } catch (e) {
    return { locationCreated: null, source: null, error: e.message };
  }
}

/**
 * @returns {Promise<{
 *   checked: Array,
 *   passed: Array,
 *   outcomes: Array,
 *   stats: { checked: number, passed: number, unknown: number, mismatch: number }
 * }>}
 */
export async function resolveVideoPublishCountryForInfluencers({
  influencerRecords = [],
  videos = [],
  maxCount = 20,
  allowedCountries = [],
  taskId = null,
  importTaskId = null,
  onStepUpdate = null,
  delayBetweenVideos = { min: 5000, max: 10000 },
} = {}) {
  const allowedIso = normalizeAllowedCountries(allowedCountries);
  const videoDelay = resolveDelayBetweenVideos(delayBetweenVideos);
  const sendStep = (step, message) => {
    try {
      onStepUpdate?.({ step, message });
    } catch {
      /* ignore */
    }
  };

  const queue = orderInfluencersForCountryCheck(
    influencerRecords,
    videos,
    maxCount
  );

  if (!queue.length) {
    return {
      checked: [],
      passed: [],
      outcomes: [],
      stats: { checked: 0, passed: 0, unknown: 0, mismatch: 0 },
    };
  }

  // Lite：9223 signed API 读取 locationCreated（不打开视频页）；每 20 人一批，0 符合国家则停止
  if (isLiteScraperMode()) {
    const { acquireTiktokApiSession, resolveVideoLocationCreated } = await import(
      "./tiktok/tiktok-direct-fetch.js"
    );
    const countryEndpoint =
      process.env.TT_LITE_COUNTRY_CDP ||
      process.env.CDP_ENDPOINT ||
      "http://127.0.0.1:9222";
    const concurrency = Math.max(
      1,
      Number(process.env.TT_LITE_COUNTRY_CONCURRENCY || 4)
    );
    const countryBatchSize = Math.max(
      1,
      Number(process.env.COUNTRY_BATCH_SIZE || 20)
    );
    const stopOnZeroBatchMatch = process.env.COUNTRY_BATCH_STOP_ON_ZERO !== "false";

    sendStep(
      "采集视频发布地",
      `Lite：9222 HTML fetch 读取发布地（每批 ${countryBatchSize} 人，0 符合国家则停，无视频页导航）...`
    );

    const checked = [];
    const passed = [];
    const outcomes = [];
    let unknown = 0;
    let mismatch = 0;
    let explicitMatches = 0;
    let stoppedEarly = false;

    /** @type {Array<{ page: object, dispose: Function }>} */
    const pool = [];
    for (let i = 0; i < concurrency; i += 1) {
      try {
        const session = await acquireTiktokApiSession(null, {
          endpointKey: countryEndpoint,
          forceNewTab: i > 0,
        });
        pool.push(session);
      } catch (e) {
        console.warn(
          `[resolveVideoPublishCountry] 9223 session ${i + 1} failed: ${e.message}`
        );
      }
    }
    if (!pool.length) {
      throw new Error("TikTok Lite 国家检测：9222 会话不可用");
    }

    const videoByUser = new Map();
    for (const v of videos || []) {
      const u = normalizeUsername(v.username);
      if (!u || videoByUser.has(u)) continue;
      videoByUser.set(u, v);
    }

    async function probeLocation(record, sessionIdx) {
      const username = normalizeUsername(record.username);
      const videoId =
        record.representativeVideoId || extractVideoId(record.representativeVideoUrl);
      const srcVideo = videoByUser.get(username);
      const page = pool[sessionIdx % pool.length].page;
      try {
        return await resolveVideoLocationCreated(page, {
          videoId: videoId || srcVideo?.videoId || "",
          username,
          secUid: record.secUid || record.tiktokSecUid || srcVideo?.creator?.secUid || "",
          searchLocation: srcVideo?.locationCreated || null,
        });
      } catch (e) {
        return {
          locationCreated: srcVideo?.locationCreated
            ? String(srcVideo.locationCreated)
            : null,
          source: srcVideo?.locationCreated ? "search_api" : null,
          error: e.message,
        };
      }
    }

    async function processOneRecord(record, globalIndex, probe) {
      const username = normalizeUsername(record.username);
      const progress = `${globalIndex + 1}/${queue.length}`;
      const locationCreated = probe.locationCreated || null;
      const pass = countryMatchesPublishLocation(locationCreated, allowedIso);
      const explicitMatch = !!(locationCreated && pass);

      let enrichSkippedReason = null;
      if (!locationCreated) {
        enrichSkippedReason = "country_unknown";
        unknown += 1;
      } else if (!pass) {
        enrichSkippedReason = "country_mismatch";
        mismatch += 1;
      } else {
        explicitMatches += 1;
      }

      await saveVideoPublishCountry({
        username,
        videoPublishCountry: locationCreated,
        representativeVideoId: record.representativeVideoId || null,
        locationSource: probe.source || "lite_api",
      });

      const enrichedRecord = {
        ...record,
        video_publish_country: locationCreated,
        enrich_skipped_reason: enrichSkippedReason,
      };
      checked.push(enrichedRecord);

      if (!locationCreated || pass) {
        passed.push(enrichedRecord);
      }

      const outcome = {
        username,
        video_publish_country: locationCreated,
        representative_video_id: record.representativeVideoId || null,
        enrich_skipped_reason: enrichSkippedReason,
        country_passed: explicitMatch,
      };
      outcomes.push(outcome);

      const importTid = Number(importTaskId || 0);
      const tid = Number(taskId || 0);
      if (importTid || tid) {
        try {
          if (importTid) {
            await bumpImportTaskCountryProgress(importTid, {
              checkedDelta: 1,
              passedDelta: explicitMatch ? 1 : 0,
            });
            await touchImportTaskLastProgressAt(importTid);
          } else {
            await bumpSearchTaskCountryProgress(tid, {
              checkedDelta: 1,
              passedDelta: explicitMatch ? 1 : 0,
            });
            await appendSearchTaskCountryOutcome(tid, outcome, allowedIso);
            await touchSearchTaskLastProgressAt(tid);
          }
        } catch (e) {
          console.warn(
            `[resolveVideoPublishCountry] 任务进度更新失败 @${username}:`,
            e.message
          );
        }
      }

      const flag = locationCreated ? (pass ? "✅" : "⛔") : "❓";
      console.log(
        `[resolveVideoPublishCountry] [${progress}] ${flag} @${username} locationCreated=${locationCreated ?? "null"} (${probe.source || "lite_api"})${enrichSkippedReason ? ` (${enrichSkippedReason})` : ""}${probe.error ? ` err=${probe.error}` : ""}`
      );

      return explicitMatch;
    }

    for (let batchStart = 0; batchStart < queue.length; batchStart += countryBatchSize) {
      const countryBatch = queue.slice(batchStart, batchStart + countryBatchSize);
      let batchExplicitMatches = 0;

      for (let subStart = 0; subStart < countryBatch.length; subStart += concurrency) {
        const subBatch = countryBatch.slice(subStart, subStart + concurrency);
        const probes = await Promise.all(
          subBatch.map((record, j) =>
            probeLocation(record, batchStart + subStart + j)
          )
        );
        for (let j = 0; j < subBatch.length; j += 1) {
          const matched = await processOneRecord(
            subBatch[j],
            batchStart + subStart + j,
            probes[j]
          );
          if (matched) batchExplicitMatches += 1;
        }
      }

      const batchNum = Math.floor(batchStart / countryBatchSize) + 1;
      console.log(
        `[resolveVideoPublishCountry] 国家批次 ${batchNum} 完成：检查 ${countryBatch.length} 人，明确符合国家 ${batchExplicitMatches} 人`
      );

      if (stopOnZeroBatchMatch && batchExplicitMatches === 0) {
        stoppedEarly = true;
        sendStep(
          "批次停止",
          `第 ${batchNum} 批 ${countryBatch.length} 人 0 位明确符合国家，停止后续国家检测`
        );
        break;
      }
    }

    for (const session of pool) {
      try {
        await session.dispose();
      } catch {
        /* ignore */
      }
    }

    sendStep(
      "采集视频发布地",
      `Lite 9222 发布地完成：检查 ${checked.length} 人，进入 enrich ${passed.length} 人，明确符合国家 ${explicitMatches} 人${stoppedEarly ? "（提前停止）" : ""}`
    );

    return {
      checked,
      passed,
      outcomes,
      stats: {
        checked: checked.length,
        passed: passed.length,
        unknown,
        mismatch,
        explicitMatches,
        stoppedEarly,
      },
    };
  }

  sendStep(
    "采集视频发布地",
    `正在通过视频详情页采集 ${queue.length} 位红人的发布地（9222）...`
  );

  const { withCdp9222PreparedSession } = await import("../../cdp/connect-cdp-9222.js");
  const { openCdpTaskPage, closeCdpTaskPage } = await import("../../cdp/cdp-tab-utils.js");

  return await withCdp9222PreparedSession(
    { platform: "tiktok", phase: "video_publish_country" },
    async ({ context }) => {
  const checked = [];
  const passed = [];
  const outcomes = [];
  let unknown = 0;
  let mismatch = 0;

    for (let i = 0; i < queue.length; i++) {
      const record = queue[i];
      const username = normalizeUsername(record.username);
      const progress = `${i + 1}/${queue.length}`;

      if (i > 0) {
        await sleep(randomDelayMs(videoDelay));
      }

      let page = null;
      try {
        page = await openCdpTaskPage(context);
        const probe = await probeVideoLocationCreated(
          page,
          record.representativeVideoUrl
        );
      const locationCreated = probe.locationCreated || null;
      const pass = countryMatchesPublishLocation(locationCreated, allowedIso);

      await reportCountryScreenshot(onStepUpdate, page, username, progress);

      let enrichSkippedReason = null;
      if (!locationCreated) {
        enrichSkippedReason = "country_unknown";
        unknown += 1;
      } else if (!pass) {
        enrichSkippedReason = "country_mismatch";
        mismatch += 1;
      }

      await saveVideoPublishCountry({
        username,
        videoPublishCountry: locationCreated,
        representativeVideoId: record.representativeVideoId || null,
        locationSource: probe.source || null,
      });

      const enrichedRecord = {
        ...record,
        video_publish_country: locationCreated,
        enrich_skipped_reason: enrichSkippedReason,
      };
      checked.push(enrichedRecord);

      const outcome = {
        username,
        video_publish_country: locationCreated,
        representative_video_id: record.representativeVideoId || null,
        enrich_skipped_reason: enrichSkippedReason,
        country_passed: pass && !!locationCreated,
      };
      outcomes.push(outcome);

      const importTid = Number(importTaskId || 0);
      const tid = Number(taskId || 0);
      if (importTid || tid) {
        try {
          if (importTid) {
            await bumpImportTaskCountryProgress(importTid, {
              checkedDelta: 1,
              passedDelta: pass && locationCreated ? 1 : 0,
            });
            await touchImportTaskLastProgressAt(importTid);
          } else {
            await bumpSearchTaskCountryProgress(tid, {
              checkedDelta: 1,
              passedDelta: pass && locationCreated ? 1 : 0,
            });
            await appendSearchTaskCountryOutcome(tid, outcome, allowedIso);
            await touchSearchTaskLastProgressAt(tid);
          }
        } catch (e) {
          console.warn(
            `[resolveVideoPublishCountry] 任务进度更新失败 @${username}:`,
            e.message
          );
        }
      }

      if (pass && locationCreated) {
        passed.push(enrichedRecord);
      }

      const flag = locationCreated
        ? pass
          ? "✅"
          : "⛔"
        : "❓";
      console.log(
        `[resolveVideoPublishCountry] [${progress}] ${flag} @${username} locationCreated=${locationCreated ?? "null"}${enrichSkippedReason ? ` (${enrichSkippedReason})` : ""}`
      );
      } finally {
        await closeCdpTaskPage(page);
      }
    }

  sendStep(
    "采集视频发布地",
    `发布地采集完成：检查 ${checked.length} 人，符合 campaign 国家 ${passed.length} 人`
  );

  return {
    checked,
    passed,
    outcomes,
    stats: {
      checked: checked.length,
      passed: passed.length,
      unknown,
      mismatch,
    },
  };
    }
  );
}
