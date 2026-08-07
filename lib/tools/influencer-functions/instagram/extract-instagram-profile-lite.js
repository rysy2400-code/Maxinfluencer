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
  extractIgCountryFromUserDeep,
  extractIgUserStatsFromJson,
  extractIgCountryFromClipsBatches,
} from "./instagram-json-utils.js";
import {
  fetchWebProfileInfo,
  fetchUserInfoById,
  fetchUserClipsAll,
  fetchUserReelsViaScrollCapture,
  warmUpIgRelayTemplateIfNeeded,
  fetchIgAboutCountryBloks,
  isIgPageUnhealthy,
} from "./instagram-direct-fetch.js";
import {
  enrichIgVideosEngagement,
  igEngagementCoverage,
} from "./ig-video-engagement-enrich.js";
import { resolveIgAllowReelsScrollFallback } from "../../../scraper/resolve-scraper-mode.js";
import {
  countryMatchesPublishLocation,
  normalizeInfluencerCountryToIso,
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

/** 对齐 YouTube Lite：粉丝数低于阈值跳过视频/分析（可用 IG_LITE_MIN_FOLLOWERS 覆盖） */
const IG_LITE_MIN_FOLLOWERS_FOR_ANALYSIS = Math.max(
  0,
  Number(process.env.IG_LITE_MIN_FOLLOWERS || 500) || 500
);

function shouldSkipIgLiteLowFollowers(userInfo) {
  const rawCount = userInfo?.followers?.count;
  if (rawCount == null || rawCount === "") return false;
  const count = Number(rawCount);
  return Number.isFinite(count) && count >= 0 && count < IG_LITE_MIN_FOLLOWERS_FOR_ANALYSIS;
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

export function isInstagramLiteEmailGateEnabled(
  raw = process.env.IG_LITE_REQUIRE_EMAIL_FOR_ANALYSIS
) {
  // 与 YouTube Lite 语义一致：默认开启（非 "0" 即开），显式 "0" 才关闭
  return String(raw ?? "").trim() !== "0";
}

export function hasInstagramProfileEmail(userInfo) {
  return !!String(userInfo?.email || "").trim();
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

function applyClipsCountryFallback(countryState, clipBatches, handle) {
  if (countryState.videoPublishCountry || !clipBatches?.length) return countryState;
  const clipsHit = extractIgCountryFromClipsBatches(clipBatches, handle);
  if (!clipsHit?.videoPublishCountry) return countryState;
  return {
    countryRaw: clipsHit.countryRaw,
    videoPublishCountry: clipsHit.videoPublishCountry,
    countrySource: clipsHit.source,
  };
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

function buildMissingProfileEmailSkipResult(countryCtx, handle, profileUrl) {
  const userInfo = countryCtx.userInfo || {
    username: handle,
    displayName: handle,
    avatarUrl: "",
    bio: "",
    email: null,
    followers: { count: 0, display: "0" },
    following: { count: 0, display: "0" },
    postsCount: { count: 0, display: "0" },
    profileUrl,
  };
  return {
    ...buildCountrySkipResult(
      { ...countryCtx, userInfo },
      handle,
      "profile_email_not_found",
      profileUrl
    ),
    dataIncomplete: true,
  };
}

function buildIgPageHangResult(handle, profileUrl) {
  return {
    success: false,
    error: "ig_page_hang",
    userInfo: null,
    videos: [],
    profileUrl,
    reelsUrl: `${profileUrl}reels/`,
    extractionSource: "instagram_api_direct",
    extractMode: "lite",
    pageHang: true,
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

  if (!videoPublishCountry && options.clipBatches?.length) {
    ({ countryRaw, videoPublishCountry, countrySource } = applyClipsCountryFallback(
      { countryRaw, videoPublishCountry, countrySource },
      options.clipBatches,
      handle
    ));
  }

  let aboutCountryResult = null;
  if (!videoPublishCountry && shouldCollectAboutCountry(options)) {
    aboutCountryResult = await fetchIgAboutCountryBloks(page, userId, {
      username: handle,
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
  if (isIgPageUnhealthy(page)) {
    console.warn(`[extractInstagramProfileLite] @${handle} 页面已标记不健康，快速失败 ig_page_hang`);
    return buildIgPageHangResult(handle, profileUrl);
  }

  const allowAbout = shouldCollectAboutCountry(options);

  await ensureInstagramLiteApiReady(page);

  if (options.countryOnly) {
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
    `Instagram Lite enrich @${handle || userIdOpt}（API-only，目标 ${maxReels} 条）`
  );

  // 国家解析后置：先只取 profile 信息（web_profile_info，失败用 users/info 兜底），
  // 过完邮箱/粉丝门槛后再调 About 国家 API，避免为必然被门槛跳过的红人花费国家请求。
  const profileJson = await fetchWebProfileInfo(page, handle);
  const rawUser = userFromWebProfileJson(profileJson, handle);
  let userInfo = mapIgUserToUserInfo(rawUser);
  let userId = userIdOpt || userInfo?.userId || rawUser?.id || rawUser?.pk || null;
  if (!hasMeaningfulFollowers(userInfo) && profileJson) {
    const jsonStats = extractIgUserStatsFromJson(profileJson, handle);
    ({ userInfo, userId } = mergeIgUserStatsIntoCtx(
      { userInfo, rawUser, userId },
      jsonStats,
      jsonStats?.source || "profile_json"
    ));
  }
  let countryCtx = {
    profileJson,
    rawUser,
    userInfo,
    userId,
    videoPublishCountry: null,
    countryRaw: null,
    countrySource: null,
    aboutCountry: null,
  };
  let videoPublishCountry = null;
  let countryRaw = null;
  let countrySource = null;

  // 兜底：web_profile_info 失败（profileJson 为空）且当前 userInfo 无邮箱时，
  // 用搜索记录自带的 userId 调 /api/v1/users/<id>/info/ 回填 bio/粉丝/邮箱，
  // 使邮箱门槛与 bio 语言国家门槛可以继续走完。
  if (!profileJson && userId && !hasInstagramProfileEmail(userInfo)) {
    try {
      const infoJson = await fetchUserInfoById(page, userId, { username: handle });
      const fallbackUser = infoJson?.user || infoJson?.data?.user || null;
      if (fallbackUser) {
        const fallbackInfo = mapIgUserToUserInfo(fallbackUser);
        if (fallbackInfo) {
          userInfo = { ...(userInfo || {}), ...fallbackInfo };
          if (fallbackInfo.userId) userId = fallbackInfo.userId;
          countryCtx = { ...countryCtx, userInfo, userId };
          console.log(
            `[extractInstagramProfileLite] @${handle} web_profile_info 失败，users/info 回填 userInfo（email=${!!fallbackInfo.email} followers=${fallbackInfo.followers?.count ?? "?"} bio=${(fallbackInfo.bio || "").length}）`
          );
        }
      }
    } catch (fallbackErr) {
      console.warn(
        `[extractInstagramProfileLite] @${handle} users/info 回填 userInfo 失败: ${fallbackErr?.message || fallbackErr}`
      );
    }
  }

  if (isInstagramLiteEmailGateEnabled() && !hasInstagramProfileEmail(userInfo)) {
    console.log(
      `[extractInstagramProfileLite] @${handle} profile/bio 未识别到邮箱，跳过 Reels enrich 和 LLM 分析`
    );
    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      STEP_STATUS.COMPLETED,
      `Lite @${handle} 无邮箱，跳过后续分析`
    );
    return buildMissingProfileEmailSkipResult(countryCtx, handle, profileUrl);
  }

  if (shouldSkipIgLiteLowFollowers(userInfo)) {
    const followerCount = Number(userInfo?.followers?.count);
    console.log(
      `[extractInstagramProfileLite] @${handle} followers=${followerCount} < ${IG_LITE_MIN_FOLLOWERS_FOR_ANALYSIS}, skip videos and LLM analysis`
    );
    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      STEP_STATUS.COMPLETED,
      `Lite @${handle} 粉丝 ${followerCount} < ${IG_LITE_MIN_FOLLOWERS_FOR_ANALYSIS}，跳过后续分析`
    );
    return {
      ...buildCountrySkipResult(countryCtx, handle, "followers_below_500", profileUrl),
      followerThreshold: IG_LITE_MIN_FOLLOWERS_FOR_ANALYSIS,
    };
  }

  // 国家解析（后置）：profile JSON 内国家免费；缺失时调 Bloks About（仅门槛通过者）
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
  let aboutCountryResult = null;
  if (!videoPublishCountry && userId && allowAbout) {
    aboutCountryResult = await fetchIgAboutCountryBloks(page, userId, {
      username: handle,
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
  countryCtx = {
    ...countryCtx,
    userInfo,
    userId,
    videoPublishCountry,
    countryRaw,
    countrySource,
    aboutCountry: aboutCountryResult,
  };

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

  if (isIgPageUnhealthy(page)) {
    console.warn(
      `[extractInstagramProfileLite] @${handle} 拉取过程中页面挂起（ig_page_hang），中止本红人`
    );
    return buildIgPageHangResult(handle, profileUrl);
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

    if (!videoPublishCountry && clipBatches.length) {
      const clipsCountry = applyClipsCountryFallback(
        { countryRaw, videoPublishCountry, countrySource },
        clipBatches,
        handle
      );
      if (clipsCountry.videoPublishCountry) {
        videoPublishCountry = clipsCountry.videoPublishCountry;
        countrySource = clipsCountry.countrySource;
        countryCtx = {
          ...countryCtx,
          videoPublishCountry,
          countryRaw: clipsCountry.countryRaw,
          countrySource,
        };
      }
    }

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
  const success = videos.length > 0 || !!rawUser || !!userId;
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
