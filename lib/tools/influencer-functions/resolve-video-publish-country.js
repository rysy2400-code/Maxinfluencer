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
  bumpSearchTaskEnrichedProgress,
} from "../../db/campaign-candidates-dao.js";
import { guardedGoto } from "../../cdp/cdp-tab-utils.js";

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

      const tid = Number(taskId || 0);
      if (tid) {
        try {
          await bumpSearchTaskCountryProgress(tid, {
            checkedDelta: 1,
            passedDelta: pass && locationCreated ? 1 : 0,
          });
          await appendSearchTaskCountryOutcome(tid, outcome, allowedIso);
          await touchSearchTaskLastProgressAt(tid);
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
