/**
 * Instagram Lite enrich：Reels 单入口 → API 优先 → header DOM 补 bio/userId → About 仅补国家 → 滚动兜底
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
  extractIgUserStatsFromJson,
} from "./instagram-json-utils.js";
import {
  fetchWebProfileInfo,
  fetchUserClipsAll,
  fetchUserReelsViaScrollCapture,
  warmUpIgRelayTemplateIfNeeded,
} from "./instagram-direct-fetch.js";
import {
  enrichIgVideosEngagement,
  igEngagementCoverage,
} from "./ig-video-engagement-enrich.js";
import { extractInstagramAboutCountryFromPage } from "./extract-instagram-about-country.js";
import { extractInstagramProfileHeaderFromPage, waitForInstagramProfileStats, isLikelyIgPollutedHeaderDomBio } from "./extract-instagram-profile-header-dom.js";
import { isLiteEnrichScreenshotsEnabled } from "../../../scraper/resolve-scraper-mode.js";
import { reportIgScreenshot } from "./ig-cdp-screenshot.js";
import { extractEmailFromBio } from "../../../influencer/extract-email-from-bio.js";
import {
  countryMatchesPublishLocation,
  normalizeInfluencerCountryToIso,
} from "../../../influencer/campaign-country-codes.js";

function normalizeIgEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

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

function countVideosWithDescription(videoMap) {
  let count = 0;
  for (const v of videoMap.values()) {
    if (v.description || v.caption) count += 1;
  }
  return count;
}

/** GraphQL 翻页条数不足时，才 Reels 页滚动兜底（不再因文案覆盖率触发滚动） */
function needsReelsScrollFallback(videoMap, maxReels) {
  if (process.env.IG_LITE_SKIP_REELS_SCROLL === "1") return false;
  const total = videoMap.size;
  if (total === 0) return true;
  const minReels = Math.min(
    maxReels,
    Math.max(Number(process.env.IG_LITE_REELS_MIN_COUNT || 10), 1)
  );
  return total < minReels;
}

function needsEngagementEnrichment(videos) {
  const list = Array.isArray(videos) ? videos : [];
  if (!list.length) return false;
  const minCoverage = Math.min(
    Math.max(Number(process.env.IG_LITE_ENGAGEMENT_MIN_COVERAGE || 0.35), 0),
    1
  );
  return igEngagementCoverage(list) < minCoverage;
}

function mergeScrollVideosIntoMap(videoMap, scrollVideos, maxReels) {
  for (const v of scrollVideos) {
    const key = v.videoId || v.videoUrl;
    if (!key) continue;
    const existing = videoMap.get(key);
    if (existing) {
      const desc = v.description || v.caption;
      if (desc && !(existing.description || existing.caption)) {
        existing.description = desc;
        existing.caption = desc;
      }
      continue;
    }
    videoMap.set(key, v);
    if (videoMap.size >= maxReels) break;
  }
}

function shouldAllowAboutFallback(options) {
  if (options.collectAboutCountry === false) return false;
  if (options.allowAbout === false) return false;
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

function hasMeaningfulBio(userInfo, rawUser) {
  return Boolean(
    String(userInfo?.bio || rawUser?.biography || "").trim()
  );
}

/**
 * API 缺 bio / userId 时，从当前 Reels 页 header DOM + 内嵌 JSON 轻量补全（不点 About）
 * @param {object} page
 * @param {string} handle
 * @param {{
 *   userInfo: object|null,
 *   rawUser: object|null,
 *   userId: string|null,
 *   videoPublishCountry: string|null,
 *   countryRaw: string|null,
 *   countrySource: string|null,
 * }} ctx
 */
function hasMeaningfulFollowers(userInfo) {
  return (userInfo?.followers?.count || 0) > 0;
}

function mergeIgUserStatsIntoCtx(ctx, stats, label) {
  if (!stats) return ctx;
  let { userInfo, rawUser, userId } = ctx;
  if (stats.userId && !userId) userId = String(stats.userId);
  if (stats.followers?.count > 0 && !hasMeaningfulFollowers(userInfo)) {
    if (userInfo) userInfo = { ...userInfo, followers: stats.followers };
    else if (rawUser) userInfo = mapIgUserToUserInfo(rawUser);
    else userInfo = { followers: stats.followers };
  }
  if (stats.following?.count > 0 && !(userInfo?.following?.count > 0)) {
    userInfo = { ...(userInfo || {}), following: stats.following };
  }
  if (stats.postsCount?.count > 0 && !(userInfo?.postsCount?.count > 0)) {
    userInfo = { ...(userInfo || {}), postsCount: stats.postsCount };
  }
  if (stats.followers?.count > 0) {
    console.log(
      `[resolveInstagramLiteProfile] @${ctx.userInfo?.username || rawUser?.username || "?"} followers from ${label} count=${stats.followers.count}`
    );
  }
  return { ...ctx, userInfo, userId, statsSource: label };
}

async function ensureOnIgProfilePage(page, handle, options = {}) {
  const profileUrl = buildIgProfileUrl(handle);
  const waitMs = Math.min(
    Math.max(Number(options.statsWaitMs || process.env.IG_PROFILE_STATS_WAIT_MS || 8000), 1500),
    15_000
  );
  if (typeof page.goto === "function" && !isOnIgHandlePage(page, handle)) {
    await page
      .goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 })
      .catch(() => {});
  }
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(1200);
  }
  await waitForInstagramProfileStats(page, handle, { maxWaitMs: waitMs }).catch(() => false);
  return profileUrl;
}

async function applyInstagramLiteHeaderDomFallback(page, handle, ctx) {
  const needsBio = !hasMeaningfulBio(ctx.userInfo, ctx.rawUser);
  const needsUserId = !ctx.userId;
  const needsFollowers = !hasMeaningfulFollowers(ctx.userInfo);
  const needsFollowing = !(ctx.userInfo?.following?.count > 0);
  const needsPosts = !(ctx.userInfo?.postsCount?.count > 0);
  const needsEmail = !normalizeIgEmail(ctx.userInfo?.email);
  const currentBio = String(ctx.userInfo?.bio || ctx.rawUser?.biography || "").trim();
  const needsCleanerBio =
    currentBio && isLikelyIgPollutedHeaderDomBio(currentBio, handle);
  if (
    !needsBio &&
    !needsUserId &&
    !needsFollowers &&
    !needsFollowing &&
    !needsPosts &&
    !needsEmail &&
    !needsCleanerBio
  ) {
    return ctx;
  }

  await ensureOnIgProfilePage(page, handle, { statsWaitMs: 6000 });

  if (!isOnIgHandlePage(page, handle) || typeof page.evaluate !== "function") {
    return ctx;
  }

  const headerHit = await extractInstagramProfileHeaderFromPage(page, handle);
  if (!headerHit) return ctx;

  let { userInfo, rawUser, userId, videoPublishCountry, countryRaw, countrySource } = ctx;
  let headerDomSource = headerHit.source || "header_dom";

  if (needsBio && headerHit.bio) {
    const bio = String(headerHit.bio).trim();
    rawUser = rawUser
      ? { ...rawUser, biography: bio }
      : { username: handle, biography: bio, pk: headerHit.userId || userId };
    if (userInfo) {
      userInfo = {
        ...userInfo,
        bio,
        email:
          userInfo.email ||
          headerHit.email ||
          extractEmailFromBio(bio) ||
          null,
        displayName: userInfo.displayName || headerHit.displayName || handle,
      };
    } else {
      userInfo = mapIgUserToUserInfo(rawUser);
    }

    if (!videoPublishCountry) {
      const bioHit = inferIgCountryFromBio(bio);
      if (bioHit?.videoPublishCountry) {
        countryRaw = bioHit.countryRaw;
        videoPublishCountry = bioHit.videoPublishCountry;
        countrySource = bioHit.source;
      }
    }
  } else if (needsCleanerBio && headerHit.bio) {
    const bio = String(headerHit.bio).trim();
    rawUser = rawUser ? { ...rawUser, biography: bio } : rawUser;
    userInfo = {
      ...(userInfo || mapIgUserToUserInfo(rawUser) || {}),
      bio,
      email:
        userInfo?.email ||
        headerHit.email ||
        extractEmailFromBio(bio) ||
        null,
    };
  } else if (needsEmail && headerHit.email) {
    userInfo = {
      ...(userInfo || mapIgUserToUserInfo(rawUser) || {}),
      email: headerHit.email,
    };
  } else if (needsEmail && headerHit.bio) {
    const fromBio = extractEmailFromBio(headerHit.bio);
    if (fromBio) {
      userInfo = { ...(userInfo || {}), email: fromBio };
    }
  }

  if (needsUserId && headerHit.userId) {
    userId = String(headerHit.userId);
    if (userInfo) userInfo = { ...userInfo, userId };
    if (rawUser) rawUser = { ...rawUser, pk: userId, id: userId };
  }

  if (needsFollowers && headerHit.followers?.count > 0) {
    userInfo = { ...(userInfo || mapIgUserToUserInfo(rawUser) || {}), followers: headerHit.followers };
  }
  if (needsFollowing && headerHit.following?.count > 0) {
    userInfo = { ...(userInfo || mapIgUserToUserInfo(rawUser) || {}), following: headerHit.following };
  }
  if (needsPosts && headerHit.postsCount?.count > 0) {
    userInfo = { ...(userInfo || mapIgUserToUserInfo(rawUser) || {}), postsCount: headerHit.postsCount };
  }

  if ((needsBio || needsCleanerBio) && headerHit.bio) {
    console.log(
      `[resolveInstagramLiteProfile] @${handle} bio from ${headerDomSource} len=${headerHit.bio.length}`
    );
  }
  if (needsEmail && userInfo?.email) {
    console.log(
      `[resolveInstagramLiteProfile] @${handle} email from ${headerDomSource} email=${userInfo.email}`
    );
  }
  if (needsUserId && headerHit.userId) {
    console.log(
      `[resolveInstagramLiteProfile] @${handle} userId from ${headerDomSource} id=${headerHit.userId}`
    );
  }
  if (needsFollowers && headerHit.followers?.count > 0) {
    console.log(
      `[resolveInstagramLiteProfile] @${handle} followers from ${headerDomSource} count=${headerHit.followers.count}`
    );
  }

  return {
    ...ctx,
    userInfo,
    rawUser,
    userId,
    videoPublishCountry,
    countryRaw,
    countrySource,
    headerDomSource,
  };
}

function tryInferCountryFromBio(rawUser, userInfo, countryState) {
  let { countryRaw, videoPublishCountry, countrySource } = countryState;
  const bio = rawUser?.biography || userInfo?.bio;
  if (!videoPublishCountry && bio) {
    const bioHit = inferIgCountryFromBio(bio);
    if (bioHit?.videoPublishCountry) {
      countryRaw = bioHit.countryRaw;
      videoPublishCountry = bioHit.videoPublishCountry;
      countrySource = bioHit.source;
    }
  }
  return { countryRaw, videoPublishCountry, countrySource };
}

function buildIgReelsUrl(handle) {
  return `https://www.instagram.com/${handle}/reels/`;
}

function buildIgProfileUrl(handle) {
  return `https://www.instagram.com/${handle}/`;
}

function pageUrlString(page) {
  try {
    return String(typeof page.url === "function" ? page.url() : "");
  } catch {
    return "";
  }
}

function isOnIgHandlePage(page, handle) {
  return pageUrlString(page).includes(`instagram.com/${handle}`);
}

function isOnIgReelsPage(page, handle) {
  const url = pageUrlString(page);
  return url.includes(`instagram.com/${handle}`) && url.includes("/reels");
}

/**
 * Lite 入口：profile 页 + relay 预热（避免 Reels 页大流量加载）
 * @param {object} page
 * @param {string} handle
 * @param {{ onStepUpdate?: Function|null, screenshot?: boolean }} [options]
 */
async function ensureInstagramLiteEntry(page, handle, options = {}) {
  const { onStepUpdate = null, screenshot = true } = options;
  const profileUrl = buildIgProfileUrl(handle);

  if (typeof page.goto === "function" && !isOnIgHandlePage(page, handle)) {
    await page
      .goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
  } else if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(500);
  }

  await warmUpIgRelayTemplateIfNeeded(page);

  if (!isOnIgHandlePage(page, handle) && typeof page.goto === "function") {
    await page
      .goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 90_000 })
      .catch(() => {});
    await page.waitForTimeout(1200);
  }
  await waitForInstagramProfileStats(page, handle).catch(() => false);

  if (screenshot && isLiteEnrichScreenshotsEnabled() && onStepUpdate) {
    await reportIgScreenshot(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      `Instagram Profile @${handle}`,
      page
    );
  }

  return profileUrl;
}

function buildCountrySkipResult(countryCtx, handle, skippedReason, profileUrl) {
  return {
    success: true,
    skippedReason,
    error: null,
    userInfo: countryCtx.userInfo,
    videos: [],
    statistics: null,
    profileUrl,
    reelsUrl: `${profileUrl}reels/`,
    videoPublishCountry: countryCtx.videoPublishCountry || null,
    accountCountryRaw: countryCtx.countryRaw || null,
    accountCountrySource: countryCtx.countrySource || null,
    aboutCountry: countryCtx.aboutCountry,
    extractionSource: "instagram_api_direct",
    extractMode: "lite",
    interceptedCounts: {
      profileApi: countryCtx.profileJson ? 1 : 0,
      clipsBatches: 0,
      reelsKept: 0,
      scrollRoundsUsed: 0,
    },
  };
}

/**
 * Lite 红人 metadata：web_profile_info → header DOM 补 bio/userId → 国家推断 → About 仅补国家
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
      headerDomSource: null,
    };
  }

  const profileJson =
    options.profileJson || (await fetchWebProfileInfo(page, handle));
  let rawUser = options.rawUser || userFromWebProfileJson(profileJson, handle);
  let userInfo = mapIgUserToUserInfo(rawUser);
  let userId =
    options.userId ||
    userInfo?.userId ||
    rawUser?.id ||
    rawUser?.pk ||
    null;

  if (!hasMeaningfulFollowers(userInfo) && profileJson) {
    const jsonStats = extractIgUserStatsFromJson(profileJson, handle);
    ({ userInfo, userId } = mergeIgUserStatsIntoCtx(
      { userInfo, rawUser, userId },
      jsonStats,
      jsonStats?.source || "profile_json"
    ));
  }

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

  ({ countryRaw, videoPublishCountry, countrySource } = tryInferCountryFromBio(
    rawUser,
    userInfo,
    { countryRaw, videoPublishCountry, countrySource }
  ));

  const headerEnriched = await applyInstagramLiteHeaderDomFallback(page, handle, {
    userInfo,
    rawUser,
    userId,
    videoPublishCountry,
    countryRaw,
    countrySource,
  });
  userInfo = headerEnriched.userInfo;
  rawUser = headerEnriched.rawUser;
  userId = headerEnriched.userId;
  countryRaw = headerEnriched.countryRaw;
  videoPublishCountry = headerEnriched.videoPublishCountry;
  countrySource = headerEnriched.countrySource;
  const headerDomSource = headerEnriched.headerDomSource || null;

  let aboutCountryResult = null;
  const allowAbout = shouldAllowAboutFallback(options);
  if (!videoPublishCountry && allowAbout && typeof page.goto === "function") {
    try {
      if (!isOnIgHandlePage(page, handle)) {
        await page
          .goto(buildIgProfileUrl(handle), { waitUntil: "domcontentloaded", timeout: 90_000 })
          .catch(() => {});
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

  if (!hasMeaningfulFollowers(userInfo)) {
    const reHeader = await applyInstagramLiteHeaderDomFallback(page, handle, {
      userInfo,
      rawUser,
      userId,
      videoPublishCountry,
      countryRaw,
      countrySource,
    });
    userInfo = reHeader.userInfo;
    rawUser = reHeader.rawUser;
    userId = reHeader.userId;
  }

  if (videoPublishCountry) {
    console.log(
      `[resolveInstagramLiteCountry] @${handle} country=${videoPublishCountry} source=${countrySource}` +
        (countrySource === "wbloks" || countrySource === "about_dialog_dom"
          ? "（About 兜底）"
          : "（未点 About）")
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
    headerDomSource,
  };
}

/**
 * @param {object} page
 * @param {string} username
 * @param {{
 *   onStepUpdate?: Function,
 *   userId?: string,
 *   allowedCountriesIso?: string[],
 *   countryOnly?: boolean,
 *   allowAbout?: boolean,
 *   collectAboutCountry?: boolean,
 * }} [options]
 */
export async function extractInstagramProfileLite(page, username, options = {}) {
  const { onStepUpdate = null } = options;
  const handle = String(username || "").replace(/^@/, "").trim();
  const userIdOpt = options.userId ? String(options.userId) : null;
  const maxReels = resolveMaxReels();
  const allowedCountriesIso = Array.isArray(options.allowedCountriesIso)
    ? options.allowedCountriesIso.filter(Boolean)
    : [];
  const profileUrl = buildIgProfileUrl(handle);

  if (!handle && !userIdOpt) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  const allowAbout = shouldAllowAboutFallback(options);

  if (options.countryOnly) {
    await ensureInstagramLiteEntry(page, handle, {
      onStepUpdate,
      screenshot: !!onStepUpdate,
    });
    const countryCtx = await resolveInstagramLiteCountry(page, handle, {
      userId: userIdOpt,
      allowAbout,
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

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `Instagram Lite enrich @${handle || userIdOpt}（API 优先，目标 ${maxReels} 条）`
  );

  await ensureInstagramLiteEntry(page, handle, { onStepUpdate, screenshot: true });

  const countryCtx = await resolveInstagramLiteCountry(page, handle, {
    userId: userIdOpt,
    allowAbout,
  });

  const profileJson = countryCtx.profileJson;
  const rawUser = countryCtx.rawUser;
  let userInfo = countryCtx.userInfo || mapIgUserToUserInfo(rawUser);
  const userId = countryCtx.userId || userIdOpt;
  const videoPublishCountry = countryCtx.videoPublishCountry || null;
  const countryRaw = countryCtx.countryRaw || null;
  const countrySource = countryCtx.countrySource || null;

  if (allowedCountriesIso.length > 0) {
    if (!videoPublishCountry) {
      reportStep(
        onStepUpdate,
        BROWSER_STEP_IDS.ENRICH_PROFILES,
        STEP_STATUS.COMPLETED,
        `Lite @${handle} 未获取国家，跳过 Reels 拉取`
      );
      return buildCountrySkipResult(countryCtx, handle, "country_unknown", profileUrl);
    }
    if (!countryMatchesPublishLocation(videoPublishCountry, allowedCountriesIso)) {
      reportStep(
        onStepUpdate,
        BROWSER_STEP_IDS.ENRICH_PROFILES,
        STEP_STATUS.COMPLETED,
        `Lite @${handle} 国家 ${videoPublishCountry} 不符合 campaign`
      );
      return buildCountrySkipResult(countryCtx, handle, "country_mismatch", profileUrl);
    }
  }

  const videoMap = new Map();
  let clipsBatchCount = 0;
  let reelsSource = "graphql_pagination";

  if (userId && handle) {
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
      if (!hasMeaningfulFollowers(userInfo)) {
        const clipStats = extractIgUserStatsFromJson(json, handle);
        const merged = mergeIgUserStatsIntoCtx(
          { userInfo, rawUser, userId },
          clipStats,
          clipStats?.source || "clips_graphql"
        );
        userInfo = merged.userInfo;
        userId = merged.userId || userId;
      }
      const medias = extractClipsMediaFromJson(json);
      for (const m of medias) {
        mergeIgReelIntoMap(videoMap, m, handle);
        if (videoMap.size >= maxReels) break;
      }
      if (videoMap.size >= maxReels) break;
    }
    if (videoMap.size >= maxReels && !needsReelsScrollFallback(videoMap, maxReels)) {
      reelsSource = clipsBatchCount > 1 ? "graphql_pagination" : "graphql";
    }
  }

  let videos = sortIgVideosByPkDesc(Array.from(videoMap.values())).slice(0, maxReels);

  if (needsEngagementEnrichment(videos)) {
    videos = await enrichIgVideosEngagement(page, videos);
    for (const v of videos) {
      const key = v.videoId || v.videoUrl;
      if (key) videoMap.set(key, v);
    }
    if (igEngagementCoverage(videos) >= 0.35) {
      reelsSource = reelsSource.includes("graphql") ? `${reelsSource}+media_info` : "media_info";
    }
  }

  if (handle && needsReelsScrollFallback(videoMap, maxReels)) {
    const hadGraphqlVideos = videoMap.size > 0;
    const descBeforeScroll = countVideosWithDescription(videoMap);
    reelsSource = hadGraphqlVideos ? "graphql_plus_scroll" : "scroll_capture";
    const scrollVideos = await fetchUserReelsViaScrollCapture(page, handle, {
      maxReels,
      skipGoto: false,
    });
    mergeScrollVideosIntoMap(videoMap, scrollVideos, maxReels);
    if (hadGraphqlVideos && countVideosWithDescription(videoMap) > descBeforeScroll) {
      reelsSource = "graphql_plus_scroll_enriched";
    }
    videos = sortIgVideosByPkDesc(Array.from(videoMap.values())).slice(0, maxReels);
    if (needsEngagementEnrichment(videos)) {
      videos = await enrichIgVideosEngagement(page, videos);
    }
  } else {
    videos = sortIgVideosByPkDesc(Array.from(videoMap.values())).slice(0, maxReels);
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

  const statistics = computeIgVideoStatistics(videos);
  const success = videos.length > 0 || !!rawUser || !!userId;
  const descCount = videos.filter((v) => v.description || v.caption).length;
  const engagementCov = igEngagementCoverage(videos);

  console.log(
    `[extractInstagramProfileLite] @${handle} reels=${videos.length}/${maxReels} ` +
      `desc=${descCount}/${videos.length} engagement=${Math.round(engagementCov * 100)}% ` +
      `country=${videoPublishCountry || "(空)"} countrySource=${countrySource || "(空)"} ` +
      `source=${reelsSource} avgViews=${statistics.avgViews ?? "n/a"} avgLikes=${statistics.avgLikes ?? "n/a"} clipsBatches=${clipsBatchCount}`
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
    reelsUrl: buildIgReelsUrl(handle),
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
      scrollRoundsUsed: reelsSource.includes("scroll") ? "fallback" : 0,
    },
  };
}
