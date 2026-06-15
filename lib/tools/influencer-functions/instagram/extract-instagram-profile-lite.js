/**
 * Instagram Lite 主页 enrich：国家轻量预筛 → 符合 campaign 再拉 Reels
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
  extractIgCountryFromUserDeep,
  inferIgCountryFromBio,
} from "./instagram-json-utils.js";
import {
  fetchWebProfileInfo,
  fetchUserClipsAll,
  fetchUserReelsViaScrollCapture,
} from "./instagram-direct-fetch.js";
import { extractInstagramAboutCountryFromPage } from "./extract-instagram-about-country.js";
import { isLiteEnrichScreenshotsEnabled } from "../../../scraper/resolve-scraper-mode.js";
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

function shouldAllowAboutFallback(options) {
  if (options.collectAboutCountry === false) return false;
  if (process.env.IG_SKIP_ABOUT_COUNTRY === "1") return false;
  if (process.env.IG_ALLOW_ABOUT_FALLBACK === "0") return false;
  return true;
}

function userFromWebProfileJson(json, handle) {
  const user =
    json?.data?.user ||
    extractUserNodesFromJson(json, handle) ||
    null;
  return user;
}

function shallowCountryFromProfile(rawUser, profileJson) {
  const countryRaw =
    rawUser?.country_code ||
    rawUser?.account_country ||
    profileJson?.data?.user?.country_code ||
    profileJson?.data?.user?.account_country ||
    null;
  const videoPublishCountry = normalizeInfluencerCountryToIso(countryRaw);
  return { countryRaw, videoPublishCountry, source: videoPublishCountry ? "web_profile_info" : null };
}

/**
 * 轻量国家解析：API 浅层 → 深度扫描 → 简介推断 → About 弹窗（最后兜底）
 * @param {object} page
 * @param {string} username
 * @param {{ userId?: string, profileJson?: object, rawUser?: object, allowAbout?: boolean }} [options]
 */
export async function resolveInstagramLiteCountry(page, username, options = {}) {
  const handle = String(username || "").replace(/^@/, "").trim();
  if (!handle) {
    return {
      success: false,
      videoPublishCountry: null,
      countryRaw: null,
      countrySource: null,
      profileJson: null,
      rawUser: null,
      userInfo: null,
      userId: options.userId ? String(options.userId) : null,
      aboutCountry: null,
    };
  }

  const profileJson =
    options.profileJson || (await fetchWebProfileInfo(page, handle));
  const rawUser = options.rawUser || userFromWebProfileJson(profileJson, handle);
  const userInfo = mapIgUserToUserInfo(rawUser);
  const userId =
    options.userId ||
    userInfo?.userId ||
    rawUser?.id ||
    rawUser?.pk ||
    null;

  let countryRaw = null;
  let videoPublishCountry = null;
  let countrySource = null;

  const shallow = shallowCountryFromProfile(rawUser, profileJson);
  if (shallow.videoPublishCountry) {
    ({ countryRaw, videoPublishCountry, source: countrySource } = shallow);
  }

  if (!videoPublishCountry && profileJson) {
    const deep = extractIgCountryFromUserDeep(profileJson, handle);
    if (deep?.videoPublishCountry) {
      countryRaw = deep.countryRaw;
      videoPublishCountry = deep.videoPublishCountry;
      countrySource = deep.source;
    }
  }

  if (!videoPublishCountry && rawUser?.biography) {
    const bioHit = inferIgCountryFromBio(rawUser.biography);
    if (bioHit?.videoPublishCountry) {
      countryRaw = bioHit.countryRaw;
      videoPublishCountry = bioHit.videoPublishCountry;
      countrySource = bioHit.source;
    }
  }

  let aboutCountryResult = null;
  const allowAbout = options.allowAbout !== false && shouldAllowAboutFallback(options);
  if (!videoPublishCountry && allowAbout && typeof page.goto === "function") {
    const profileUrl = `https://www.instagram.com/${handle}/`;
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
      await page
        .evaluate(() => {
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })
          );
        })
        .catch(() => {});
      await page.waitForTimeout(800);
      if (aboutCountryResult?.videoPublishCountry) {
        countryRaw =
          aboutCountryResult.accountCountryRaw ||
          aboutCountryResult.accountCountry ||
          countryRaw;
        videoPublishCountry = aboutCountryResult.videoPublishCountry;
        countrySource = aboutCountryResult.source || "wbloks";
      }
    } catch (e) {
      console.warn(`[resolveInstagramLiteCountry] @${handle} about fallback: ${e.message}`);
      aboutCountryResult = { success: false, error: e.message };
    }
  }

  if (videoPublishCountry) {
    console.log(
      `[resolveInstagramLiteCountry] @${handle} country=${videoPublishCountry} source=${countrySource}` +
        (countrySource === "wbloks" ? "（About 兜底）" : "（未点 About）")
    );
  } else {
    console.log(`[resolveInstagramLiteCountry] @${handle} country=(空)`);
  }

  return {
    success: !!videoPublishCountry,
    videoPublishCountry,
    countryRaw,
    countrySource,
    profileJson,
    rawUser,
    userInfo,
    userId: userId ? String(userId) : null,
    aboutCountry: aboutCountryResult,
  };
}

/**
 * @param {object} page
 * @param {string} username
 * @param {{ onStepUpdate?: Function, userId?: string, knownCountry?: object, countryOnly?: boolean, reelsOnly?: boolean }} [options]
 */
export async function extractInstagramProfileLite(page, username, options = {}) {
  const { onStepUpdate = null } = options;
  const handle = String(username || "").replace(/^@/, "").trim();
  const userIdOpt = options.userId ? String(options.userId) : null;
  const maxReels = resolveMaxReels();

  if (!handle && !userIdOpt) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  if (options.countryOnly) {
    const countryCtx = await resolveInstagramLiteCountry(page, handle, {
      userId: userIdOpt,
      allowAbout: shouldAllowAboutFallback(options),
    });
    return {
      success: countryCtx.success,
      error: countryCtx.success ? null : "country_unknown",
      userInfo: countryCtx.userInfo,
      videos: [],
      videoPublishCountry: countryCtx.videoPublishCountry,
      accountCountryRaw: countryCtx.countryRaw,
      accountCountrySource: countryCtx.countrySource,
      aboutCountry: countryCtx.aboutCountry,
      extractionSource: "instagram_api_direct",
      extractMode: "lite",
      countryOnly: true,
    };
  }

  const countryCtx =
    options.knownCountry ||
    (await resolveInstagramLiteCountry(page, handle, {
      userId: userIdOpt,
      allowAbout: false,
    }));

  const profileJson = countryCtx.profileJson;
  const rawUser = countryCtx.rawUser;
  let userInfo = countryCtx.userInfo || mapIgUserToUserInfo(rawUser);
  const userId = countryCtx.userId || userIdOpt;
  const profileUrl = `https://www.instagram.com/${handle}/`;

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `Instagram Lite enrich @${handle || userIdOpt}（目标 ${maxReels} Reels）`
  );

  const videoMap = new Map();
  let clipsBatchCount = 0;
  let reelsSource = "graphql_pagination";

  if (userId && handle && typeof page.goto === "function") {
    await page
      .goto(`${profileUrl}reels/`, { waitUntil: "domcontentloaded", timeout: 90_000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    if (isLiteEnrichScreenshotsEnabled()) {
      await reportIgScreenshot(
        onStepUpdate,
        BROWSER_STEP_IDS.ENRICH_PROFILES,
        `Instagram Reels @${handle}`,
        page
      );
    }
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

  const videoPublishCountry = countryCtx.videoPublishCountry || null;
  const countryRaw = countryCtx.countryRaw || null;
  const countrySource = countryCtx.countrySource || null;

  const videos = sortIgVideosByPkDesc(Array.from(videoMap.values())).slice(0, maxReels);
  const statistics = computeIgVideoStatistics(videos);
  const success = videos.length > 0 || !!rawUser || !!userId;

  console.log(
    `[extractInstagramProfileLite] @${handle} reels=${videos.length}/${maxReels} ` +
      `country=${videoPublishCountry || "(空)"} countrySource=${countrySource || "(空)"} ` +
      `source=${reelsSource} avgViews=${statistics.avgViews ?? "n/a"} clipsBatches=${clipsBatchCount}`
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success ? `Lite @${handle} ${videos.length} 条 Reels` : `Lite 未获取到 @${handle} 数据`
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
    accountCountrySource: countrySource,
    aboutCountry: countryCtx.aboutCountry,
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
