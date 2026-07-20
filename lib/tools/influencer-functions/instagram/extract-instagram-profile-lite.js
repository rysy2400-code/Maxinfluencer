/**
 * Instagram Lite enrich v2：纯 API（web_profile_info + clips GraphQL），不打开 profile/Reels/About 页
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
  extractIgUserStatsFromJson,
} from "./instagram-json-utils.js";
import {
  fetchWebProfileInfo,
  fetchUserInfoById,
  fetchProfilePageContentGraphql,
  fetchUserClipsAll,
  fetchUserReelsViaScrollCapture,
  warmUpIgRelayTemplateIfNeeded,
  fetchIgAboutCountryBloks,
} from "./instagram-direct-fetch.js";
import {
  enrichIgVideosEngagement,
  igEngagementCoverage,
} from "./ig-video-engagement-enrich.js";
import { resolveIgAllowReelsScrollFallback } from "../../../scraper/resolve-scraper-mode.js";
import {
  countryMatchesPublishLocation,
} from "../../../influencer/campaign-country-codes.js";
import { resolveUnknownCountryBioGate } from "../../../influencer/infer-bio-language.js";

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

function needsReelsScrollFallback(videoMap, maxReels) {
  if (!resolveIgAllowReelsScrollFallback()) return false;
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

function shouldCollectAboutCountry(options) {
  if (options.collectAboutCountry === false) return false;
  if (options.allowAbout === false) return false;
  if (process.env.IG_SKIP_ABOUT_COUNTRY === "1") return false;
  return true;
}

function userFromWebProfileJson(json, handle) {
  const user =
    json?.data?.user ||
    json?.user ||
    json?.data?.xdt_api__v1__users__info?.user ||
    json?.data?.xdt_api__v1__users__web_profile_info?.user ||
    extractUserNodesFromJson(json, handle) ||
    null;
  return user;
}

async function resolveInstagramProfileMetadata(page, handle, userIdOpt = null) {
  const profileJson = await fetchWebProfileInfo(page, handle);
  let rawUser = userFromWebProfileJson(profileJson, handle);
  let userInfo = mapIgUserToUserInfo(rawUser);
  let userId =
    userIdOpt ||
    userInfo?.userId ||
    rawUser?.id ||
    rawUser?.pk ||
    null;

  if (!hasMeaningfulFollowers(userInfo) && profileJson) {
    const jsonStats = extractIgUserStatsFromJson(profileJson, handle);
    ({ userInfo, userId } = mergeIgUserStatsIntoCtx(
      { userInfo, rawUser, userId },
      jsonStats,
      jsonStats?.source || "web_profile_info"
    ));
  }

  if ((!rawUser || !hasMeaningfulFollowers(userInfo)) && userId) {
    const userInfoByIdJson = await fetchUserInfoById(page, userId, { username: handle });
    const byIdUser = userFromWebProfileJson(userInfoByIdJson, handle);
    if (byIdUser) {
      rawUser = rawUser || byIdUser;
      userInfo = mergeUserInfo(userInfo, mapIgUserToUserInfo(byIdUser));
      userId = userId || userInfo?.userId || byIdUser.id || byIdUser.pk || null;
    }
    const byIdStats = extractIgUserStatsFromJson(userInfoByIdJson, handle);
    ({ userInfo, userId } = mergeIgUserStatsIntoCtx(
      { userInfo, rawUser, userId },
      byIdStats,
      byIdStats?.source || "user_info_by_id"
    ));
  }

  if (!hasMeaningfulFollowers(userInfo)) {
    const gqlJson = await fetchProfilePageContentGraphql(page, {
      userId,
      username: handle,
    });
    const gqlUser = userFromWebProfileJson(gqlJson, handle);
    if (gqlUser) {
      rawUser = rawUser || gqlUser;
      userInfo = mergeUserInfo(userInfo, mapIgUserToUserInfo(gqlUser));
      userId = userId || userInfo?.userId || gqlUser.id || gqlUser.pk || null;
    }
    const gqlStats = extractIgUserStatsFromJson(gqlJson, handle);
    ({ userInfo, userId } = mergeIgUserStatsIntoCtx(
      { userInfo, rawUser, userId },
      gqlStats,
      gqlStats?.source || "profile_graphql"
    ));
  }

  return {
    profileJson,
    rawUser,
    userInfo,
    userId: userId ? String(userId) : null,
  };
}

function mergeUserInfo(base, patch) {
  if (!patch) return base || null;
  if (!base) return patch;
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v != null && v !== "")
    ),
    followers:
      patch.followers?.count > 0 ? patch.followers : base.followers,
    following:
      patch.following?.count > 0 ? patch.following : base.following,
    postsCount:
      patch.postsCount?.count > 0 ? patch.postsCount : base.postsCount,
    bio: patch.bio || base.bio,
    email: patch.email || base.email,
    avatarUrl: patch.avatarUrl || base.avatarUrl,
    displayName: patch.displayName || base.displayName,
  };
}

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

function buildIgReelsUrl(handle) {
  return `https://www.instagram.com/${handle}/reels/`;
}

function buildIgProfileUrl(handle) {
  return `https://www.instagram.com/${handle}/`;
}

/** Lite API 就绪：仅预热 relay 模板，不 goto profile/Reels */
async function ensureInstagramLiteApiReady(page) {
  await warmUpIgRelayTemplateIfNeeded(page);
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
 * Lite 红人 metadata：web_profile_info → Bloks About API → clips owner（不使用 bio 推断国家）
 * @param {object} page
 * @param {string} username
 * @param {{ userId?: string, profileJson?: object, rawUser?: object, allowAbout?: boolean, clipBatches?: object[] }} [options]
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

  let profileJson = options.profileJson || null;
  let rawUser = options.rawUser || null;
  let userInfo = rawUser ? mapIgUserToUserInfo(rawUser) : null;
  let userId = options.userId ? String(options.userId) : null;
  if (!profileJson || !rawUser || !hasMeaningfulFollowers(userInfo)) {
    const meta = await resolveInstagramProfileMetadata(page, handle, userId);
    profileJson = profileJson || meta.profileJson;
    rawUser = rawUser || meta.rawUser;
    userInfo = mergeUserInfo(userInfo, meta.userInfo);
    userId = userId || meta.userId || null;
  }

  let countryRaw = null;
  let videoPublishCountry = null;
  let countrySource = null;

  let aboutCountryResult = null;
  if (!videoPublishCountry && shouldCollectAboutCountry(options)) {
    aboutCountryResult = await fetchIgAboutCountryBloks(page, userId, {
      username: handle,
      taskId: options.taskId,
      circuitKey: options.circuitKey,
      aboutConcurrency: options.aboutConcurrency,
    });
    if (aboutCountryResult?.videoPublishCountry) {
      countryRaw =
        aboutCountryResult.accountCountryRaw ||
        aboutCountryResult.accountCountry ||
        countryRaw;
      videoPublishCountry = aboutCountryResult.videoPublishCountry;
      countrySource = aboutCountryResult.source || "bloks_about_api";
    }
  }

  if (videoPublishCountry) {
    console.log(
      `[resolveInstagramLiteCountry] @${handle} country=${videoPublishCountry} source=${countrySource}` +
        (countrySource === "bloks_about_api"
          ? "（Bloks About API）"
          : "（API-only）")
    );
  } else {
    console.log(
      `[resolveInstagramLiteCountry] @${handle} country=(空)` +
        (aboutCountryResult?.error ? ` about=${aboutCountryResult.error}` : "")
    );
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
 * @param {{
 *   onStepUpdate?: Function,
 *   userId?: string,
 *   allowedCountriesIso?: string[],
 *   countryOnly?: boolean,
 *   allowAbout?: boolean,
 *   collectAboutCountry?: boolean,
 *   taskId?: string|number,
 *   circuitKey?: string|number,
 *   aboutConcurrency?: number,
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

  const allowAbout = shouldCollectAboutCountry(options);

  await ensureInstagramLiteApiReady(page);

  if (options.countryOnly) {
    const countryCtx = await resolveInstagramLiteCountry(page, handle, {
      userId: userIdOpt,
      allowAbout,
      taskId: options.taskId,
      circuitKey: options.circuitKey,
      aboutConcurrency: options.aboutConcurrency,
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
    `Instagram Lite enrich @${handle || userIdOpt}（API-only，目标 ${maxReels} 条）`
  );

  let countryCtx = await resolveInstagramLiteCountry(page, handle, {
    userId: userIdOpt,
    allowAbout,
    taskId: options.taskId,
    circuitKey: options.circuitKey,
    aboutConcurrency: options.aboutConcurrency,
  });

  const profileJson = countryCtx.profileJson;
  const rawUser = countryCtx.rawUser;
  let userInfo = countryCtx.userInfo || mapIgUserToUserInfo(rawUser);
  let userId = countryCtx.userId || userIdOpt;
  let videoPublishCountry = countryCtx.videoPublishCountry || null;
  const countryRaw = countryCtx.countryRaw || null;
  let countrySource = countryCtx.countrySource || null;

  if (allowedCountriesIso.length > 0) {
    if (!videoPublishCountry) {
      const bioGate = resolveUnknownCountryBioGate(userInfo?.bio, allowedCountriesIso);
      if (!bioGate.proceed) {
        reportStep(
          onStepUpdate,
          BROWSER_STEP_IDS.ENRICH_PROFILES,
          STEP_STATUS.COMPLETED,
          `Lite @${handle} bio 语言 ${bioGate.bioLanguage} 不符合 campaign，跳过 Reels 拉取`
        );
        return buildCountrySkipResult(countryCtx, handle, bioGate.skippedReason, profileUrl);
      }
      if (bioGate.countrySource) {
        countryCtx.countrySource = bioGate.countrySource;
        countrySource = bioGate.countrySource;
      }
    } else if (!countryMatchesPublishLocation(videoPublishCountry, allowedCountriesIso)) {
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
  const clipBatches = [];

  if (userId && handle) {
    const fetchedBatches = await fetchUserClipsAll(page, userId, {
      maxPages: Math.min(
        Math.max(Number(process.env.IG_LITE_CLIPS_MAX_PAGES || 8), 3),
        25
      ),
      pageSize: 24,
      username: handle,
    });
    clipBatches.push(...fetchedBatches);

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
    reelsSource = videoMap.size > 0 ? "graphql_plus_scroll" : "scroll_capture";
    const scrollVideos = await fetchUserReelsViaScrollCapture(page, handle, {
      maxReels,
      skipGoto: false,
    });
    mergeScrollVideosIntoMap(videoMap, scrollVideos, maxReels);
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
  // A search-stage userId only identifies the account; it does not prove that
  // profile or Reels enrichment returned usable data.
  const success = videos.length > 0 || !!rawUser || hasMeaningfulFollowers(userInfo);
  const descCount = videos.filter((v) => v.description || v.caption).length;
  const engagementCov = igEngagementCoverage(videos);

  console.log(
    `[extractInstagramProfileLite] @${handle} reels=${videos.length}/${maxReels} ` +
      `desc=${descCount}/${videos.length} engagement=${Math.round(engagementCov * 100)}% ` +
      `country=${videoPublishCountry || "(空)"} countrySource=${countrySource || "(空)"} ` +
      `source=${reelsSource} avgViews=${statistics.avgViews ?? "n/a"} avgLikes=${statistics.avgLikes ?? "n/a"} ` +
      `clipsBatches=${clipsBatchCount} apiOnly=true`
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success ? `Lite @${handle} ${videos.length} 条 Reels（API-only）` : `Lite 未获取到 @${handle} 数据`
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
