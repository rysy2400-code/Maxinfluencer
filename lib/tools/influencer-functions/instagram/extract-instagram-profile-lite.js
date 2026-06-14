/**
 * Instagram Lite 主页 enrich：对齐 Standard 数据（profile + about 国家 + 近 50 Reels + 互动统计）
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractClipsMediaFromJson,
  extractUserNodesFromJson,
  mapIgUserToUserInfo,
  computeIgVideoStatistics,
  mergeIgReelIntoMap,
  sortIgVideosByPkDesc,
} from "./instagram-json-utils.js";
import {
  fetchWebProfileInfo,
  fetchUserClipsAll,
  fetchUserReelsViaScrollCapture,
} from "./instagram-direct-fetch.js";
import { extractInstagramAboutCountryFromPage } from "./extract-instagram-about-country.js";
import { isLiteScreenshotsDisabled } from "../../../scraper/resolve-scraper-mode.js";
import { reportIgScreenshot } from "./ig-cdp-screenshot.js";
import { normalizeInfluencerCountryToIso } from "../../../influencer/campaign-country-codes.js";

function reportStep(onStepUpdate, stepId, status, detail = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, null) });
  } catch {
    /* ignore */
  }
}

function resolveMaxReels() {
  return Math.min(
    Math.max(Number(process.env.IG_REELS_MAX_VIDEOS || 50) || 50, 1),
    80
  );
}

function shouldCollectAboutCountry(options) {
  if (options.collectAboutCountry === false) return false;
  if (process.env.IG_SKIP_ABOUT_COUNTRY === "1") return false;
  return true;
}

function userFromWebProfileJson(json, handle) {
  const user =
    json?.data?.user ||
    extractUserNodesFromJson(json, handle) ||
    null;
  return user;
}

/**
 * @param {object} page instagram.com 上下文（Playwright 或 CDP 适配页）
 * @param {string} username
 * @param {{ onStepUpdate?: Function, userId?: string, collectAboutCountry?: boolean }} [options]
 */
export async function extractInstagramProfileLite(page, username, options = {}) {
  const { onStepUpdate = null } = options;
  const handle = String(username || "").replace(/^@/, "").trim();
  const userIdOpt = options.userId ? String(options.userId) : null;
  const maxReels = resolveMaxReels();

  if (!handle && !userIdOpt) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `Instagram Lite enrich @${handle || userIdOpt}（目标 ${maxReels} Reels）`
  );

  const profileUrl = `https://www.instagram.com/${handle}/`;

  const profileJson = await fetchWebProfileInfo(page, handle);
  const rawUser = profileJson ? userFromWebProfileJson(profileJson, handle) : null;
  let userInfo = mapIgUserToUserInfo(rawUser);
  const userId =
    userIdOpt ||
    userInfo?.userId ||
    rawUser?.id ||
    rawUser?.pk ||
    null;

  let aboutCountryResult = null;
  if (shouldCollectAboutCountry(options) && handle && typeof page.goto === "function") {
    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      STEP_STATUS.RUNNING,
      `Lite 读取 @${handle} 账户所在地`
    );
    try {
      const onProfile = String(typeof page.url === "function" ? page.url() : "").includes(
        `instagram.com/${handle}`
      );
      if (!onProfile) {
        await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await page.waitForTimeout(2000);
      }
      aboutCountryResult = await extractInstagramAboutCountryFromPage(page, handle, {
        skipInitialGoto: true,
        waitAfterAboutMs: Number(process.env.IG_ABOUT_WAIT_MS) || 10_000,
      });
      await page.evaluate(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })
        );
      }).catch(() => {});
      await page.waitForTimeout(800);
    } catch (e) {
      console.warn(`[extractInstagramProfileLite] @${handle} about country: ${e.message}`);
      aboutCountryResult = { success: false, error: e.message };
    }
  }

  const videoMap = new Map();
  let clipsBatchCount = 0;
  let reelsSource = "graphql_pagination";

  if (userId && handle && typeof page.goto === "function") {
    await page.goto(`${profileUrl}reels/`, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const clipBatches = await fetchUserClipsAll(page, userId, {
      maxPages: Math.min(
        Math.max(Number(process.env.IG_LITE_CLIPS_MAX_PAGES || 8), 3),
        25
      ),
      pageSize: 24,
      username: handle,
    });
    for (const json of clipBatches) {
      clipsBatchCount += 1;
      const medias = extractClipsMediaFromJson(json);
      for (const m of medias) {
        mergeIgReelIntoMap(videoMap, m, handle);
        if (videoMap.size >= maxReels) break;
      }
      if (videoMap.size >= maxReels) break;
    }
    if (videoMap.size >= Math.min(maxReels, 40)) {
      reelsSource = clipsBatchCount > 1 ? "graphql_pagination" : "graphql";
    }
  }

  if (videoMap.size < Math.min(maxReels, 40) && handle) {
    reelsSource = videoMap.size > 0 ? "graphql_plus_scroll" : "scroll_capture";
    const scrollVideos = await fetchUserReelsViaScrollCapture(page, handle, {
      maxReels,
      skipGoto: true,
    });
    for (const v of scrollVideos) {
      const key = v.videoId || v.videoUrl;
      if (key && !videoMap.has(key)) videoMap.set(key, v);
      if (videoMap.size >= maxReels) break;
    }
  }

  if (!userInfo) {
    userInfo = {
      username: handle,
      displayName: handle,
      avatarUrl: "",
      bio: "",
      email: null,
      userId: userId ? String(userId) : null,
      verified: false,
      followers: { count: 0, display: "0" },
      following: { count: 0, display: "0" },
      postsCount: { count: 0, display: "0" },
      profileUrl,
    };
  } else {
    userInfo.profileUrl = profileUrl;
  }

  const countryRaw =
    aboutCountryResult?.accountCountryRaw ||
    aboutCountryResult?.accountCountry ||
    rawUser?.country_code ||
    rawUser?.account_country ||
    profileJson?.data?.user?.country_code ||
    null;
  const videoPublishCountry =
    aboutCountryResult?.videoPublishCountry ||
    normalizeInfluencerCountryToIso(countryRaw);

  const videos = sortIgVideosByPkDesc(Array.from(videoMap.values())).slice(
    0,
    maxReels
  );
  const statistics = computeIgVideoStatistics(videos);
  const success = videos.length > 0 || !!rawUser || !!userId;

  if (success && !isLiteScreenshotsDisabled()) {
    await reportIgScreenshot(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      `Lite enrich @${handle}（${videos.length} 条 Reels）`,
      page
    );
  }

  console.log(
    `[extractInstagramProfileLite] @${handle} reels=${videos.length}/${maxReels} ` +
      `country=${videoPublishCountry || "(空)"} source=${reelsSource} ` +
      `avgViews=${statistics.avgViews ?? "n/a"} clipsBatches=${clipsBatchCount}`
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success
      ? `Lite @${handle} ${videos.length} 条 Reels`
      : `Lite 未获取到 @${handle} 数据`
  );

  return {
    success,
    error: success ? null : "instagram_reels_not_found",
    userInfo,
    videos,
    statistics,
    profileUrl,
    reelsUrl: `${profileUrl}reels/`,
    videoPublishCountry,
    accountCountryRaw: countryRaw,
    accountCountrySource: aboutCountryResult?.source || (countryRaw ? "web_profile_info" : null),
    aboutCountry: aboutCountryResult,
    extractionSource: "instagram_api_direct",
    extractMode: "lite",
    interceptedCounts: {
      profileApi: profileJson ? 1 : 0,
      clipsBatches: clipsBatchCount,
      reelsKept: videos.length,
      scrollRoundsUsed: reelsSource === "scroll_capture_fallback" ? "fallback" : 0,
    },
  };
}
