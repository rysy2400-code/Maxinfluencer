/**
 * YouTube Lite 频道 enrich：innertube browse 直调，不打开 /videos、/about 页面
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractVideosFromInnertubeJson,
  extractChannelHeaderFromInnertubeJson,
  computeYtVideoStatistics,
  mergeYtVideoIntoMap,
  sortYtVideosByRecency,
  buildChannelPublicUrl,
  extractSubscriberFromAboutViewModel,
} from "./youtube-json-utils.js";
import { extractEmailFromBio } from "../../../influencer/extract-email-from-bio.js";
import {
  fetchChannelVideosFirstPage,
  fetchChannelAbout,
  fetchBrowseContinuation,
  paginateViaContinuation,
} from "./innertube-direct-fetch.js";
import { isLiteScreenshotsDisabled } from "../../../scraper/resolve-scraper-mode.js";
import { reportYtScreenshot } from "./yt-cdp-screenshot.js";

function reportStep(onStepUpdate, stepId, status, detail = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, null) });
  } catch {
    /* ignore */
  }
}

function mergeUserInfo(base, patch) {
  if (!patch) return base;
  const out = { ...(base || {}), ...patch };
  if (patch.followers?.count > 0) out.followers = patch.followers;
  if (patch.bio && !base?.bio) out.bio = patch.bio;
  if (patch.country && !base?.country) out.country = patch.country;
  if (patch.email && !base?.email) out.email = patch.email;
  if (patch.avatarUrl && !base?.avatarUrl) out.avatarUrl = patch.avatarUrl;
  return out;
}

function walkAboutMeta(obj, d = 0) {
  if (d > 22 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const found = walkAboutMeta(x, d + 1);
      if (found) return found;
    }
    return null;
  }
  if (obj.channelAboutFullMetadataRenderer || obj.aboutChannelViewModel) {
    return obj.channelAboutFullMetadataRenderer || obj.aboutChannelViewModel;
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v) {
      const found = walkAboutMeta(v, d + 1);
      if (found) return found;
    }
  }
  return null;
}

function parseAboutFromBrowseJson(json, handle) {
  const aboutMeta = walkAboutMeta(json);
  if (!aboutMeta) return null;

  const countryText =
    (typeof aboutMeta.country === "string" ? aboutMeta.country : null) ||
    aboutMeta?.country?.simpleText ||
    null;
  const desc =
    (typeof aboutMeta.description === "string" ? aboutMeta.description : null) ||
    aboutMeta?.description?.simpleText ||
    (aboutMeta?.description?.runs || []).map((r) => r.text || "").join("") ||
    "";
  const emailFromAbout = extractEmailFromBio(desc) || null;
  const subs = extractSubscriberFromAboutViewModel(aboutMeta);

  return {
    country: countryText ? String(countryText).trim() : null,
    bio: desc || "",
    email: emailFromAbout,
    followers: subs?.count > 0 ? subs : null,
  };
}

function resolveMaxVideos() {
  return Math.min(
    Math.max(Number(process.env.YT_CHANNEL_MAX_VIDEOS || 50) || 50, 1),
    80
  );
}

/**
 * @param {import('playwright').Page} page innertube 会话页（youtube.com 上下文）
 * @param {string} username
 * @param {{ onStepUpdate?: Function, channelId?: string }} [options]
 */
export async function extractYoutubeChannelLite(page, username, options = {}) {
  const { onStepUpdate = null } = options;
  const handle = String(username || "").replace(/^@/, "").trim();
  const channelIdOpt = options.channelId || null;
  const maxVideos = resolveMaxVideos();

  if (!handle && !channelIdOpt) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  const target = {
    browseId: channelIdOpt?.startsWith("UC") ? channelIdOpt : null,
    handle: handle || null,
  };

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `YouTube Lite enrich @${handle || channelIdOpt}`
  );

  const videoMap = new Map();
  const browseJsonForHeader = [];
  let apiBatchCount = 0;

  const ingestBrowseJson = (json) => {
    const vids = extractVideosFromInnertubeJson(json);
    const before = videoMap.size;
    for (const v of vids) mergeYtVideoIntoMap(videoMap, v, maxVideos);
    if (vids.length || extractChannelHeaderFromInnertubeJson(json, handle)) {
      browseJsonForHeader.push(json);
      apiBatchCount += 1;
    }
    return videoMap.size - before;
  };

  const first = await fetchChannelVideosFirstPage(page, target);
  if (!first) {
    return {
      success: false,
      error: "innertube_browse_failed",
      userInfo: null,
      videos: [],
      extractionSource: "innertube_browse_direct",
      extractMode: "lite",
    };
  }

  const addedFirst = ingestBrowseJson(first);
  console.log(
    `[extractYoutubeChannelLite] @${handle || channelIdOpt} 首屏 +${addedFirst} videos`
  );

  await paginateViaContinuation(page, browseJsonForHeader, ingestBrowseJson, {
    fetchPage: fetchBrowseContinuation,
    getProgress: () => String(videoMap.size),
    maxPages: Math.min(
      Math.max(Number(process.env.YT_LITE_CHANNEL_MAX_PAGES || 12), 2),
      40
    ),
  });

  let userInfo = null;
  for (const json of browseJsonForHeader) {
    userInfo = mergeUserInfo(
      userInfo,
      extractChannelHeaderFromInnertubeJson(json, handle)
    );
    if (userInfo?.channelId && !target.browseId) {
      target.browseId = userInfo.channelId;
    }
    if (userInfo?.followers?.count > 0 && userInfo?.country) break;
  }

  const needAbout =
    !userInfo?.country || !userInfo?.email || !(userInfo?.followers?.count > 0);
  if (needAbout) {
    const aboutJson = await fetchChannelAbout(page, {
      browseId: target.browseId || userInfo?.channelId || channelIdOpt,
      handle: handle || null,
    });
    if (aboutJson) {
      const aboutPatch = parseAboutFromBrowseJson(aboutJson, handle);
      if (aboutPatch) {
        userInfo = mergeUserInfo(userInfo, aboutPatch);
        const hdr = extractChannelHeaderFromInnertubeJson(aboutJson, handle);
        userInfo = mergeUserInfo(userInfo, hdr);
      }
    }
  }

  if (!userInfo) {
    userInfo = {
      username: handle || channelIdOpt,
      displayName: handle || channelIdOpt,
      channelId: channelIdOpt,
      bio: "",
      email: null,
      country: null,
      avatarUrl: "",
      verified: false,
      followers: { count: 0, display: "0" },
    };
  }

  const resolvedChannelId = userInfo.channelId || channelIdOpt || target.browseId;
  const profileUrl =
    buildChannelPublicUrl(handle, resolvedChannelId) ||
    `https://www.youtube.com/@${handle}`;
  userInfo.profileUrl = profileUrl;
  userInfo.userId = resolvedChannelId || null;

  const videos = sortYtVideosByRecency(Array.from(videoMap.values())).slice(
    0,
    maxVideos
  );
  const statistics = computeYtVideoStatistics(videos);
  const success = videos.length > 0 || !!resolvedChannelId;

  if (success && !isLiteScreenshotsDisabled()) {
    await reportYtScreenshot(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      `Lite enrich @${handle}（${videos.length} 条）`,
      page
    );
  }

  console.log(
    `[extractYoutubeChannelLite] @${handle} videos=${videos.length} country=${userInfo.country || "(空)"} apiBatches=${apiBatchCount}`
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success
      ? `Lite @${handle} ${videos.length} 条视频`
      : `Lite 未获取到 @${handle} 视频`
  );

  return {
    success,
    error: success ? null : "youtube_videos_not_found",
    userInfo,
    videos,
    statistics,
    profileUrl,
    videosUrl: `${profileUrl}/videos`,
    videoPublishCountry: userInfo.country || null,
    extractionSource: "innertube_browse_direct",
    extractMode: "lite",
    interceptedCounts: {
      browseBatches: apiBatchCount,
      videosKept: videos.length,
      scrollRoundsUsed: 0,
      initialDataUsed: false,
    },
  };
}
