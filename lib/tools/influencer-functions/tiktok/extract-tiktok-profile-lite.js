/**
 * TikTok Lite 主页 enrich：9222 登录态 API 直调，不打开 @profile 页面
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractUserInfoFromAPI,
  extractUserInfoFromUserDetailAPI,
  extractVideosFromAPI,
} from "../extract-user-profile-cdp.js";
import {
  fetchUserDetail,
  fetchPostItemListAll,
  captureProfileApisFromNavigation,
} from "./tiktok-direct-fetch.js";

function reportStep(onStepUpdate, stepId, status, detail = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, null) });
  } catch {
    /* ignore */
  }
}

function resolveMaxVideos() {
  return Math.min(Math.max(Number(process.env.TT_LITE_MAX_VIDEOS || 50), 1), 80);
}

function computeStatistics(videos) {
  const valid = videos.filter((v) => v.views || v.likes || v.comments || v.favorites);
  const avg = (getter) =>
    valid.length > 0
      ? valid.reduce((sum, v) => sum + (getter(v) || 0), 0) / valid.length
      : null;
  const avgViews = avg((v) => v.views?.count);
  const avgLikes = avg((v) => v.likes?.count);
  const avgComments = avg((v) => v.comments?.count);
  const avgFavorites = avg((v) => v.favorites?.count);
  return {
    videoCount: videos.length,
    avgViews: avgViews ? Math.round(avgViews) : null,
    avgLikes: avgLikes ? Math.round(avgLikes) : null,
    avgComments: avgComments ? Math.round(avgComments) : null,
    avgFavorites: avgFavorites ? Math.round(avgFavorites) : null,
  };
}

/**
 * @param {object} page tiktok.com 上下文（9223）
 * @param {string} username
 * @param {{ onStepUpdate?: Function, secUid?: string, userId?: string }} [options]
 */
export async function extractTiktokProfileLite(page, username, options = {}) {
  const { onStepUpdate = null } = options;
  const handle = String(username || "").replace(/^@/, "").trim();
  const maxVideos = resolveMaxVideos();

  if (!handle) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `TikTok Lite enrich @${handle}（API 直调）`
  );

  let userInfo = {
    username: handle,
    displayName: null,
    avatarUrl: null,
    bio: null,
    email: null,
    followers: null,
    following: null,
    likes: null,
    verified: false,
    postsCount: null,
    userId: options.userId || null,
    secUid: options.secUid || null,
  };

  let itemBatches = [];

  const preferCapture =
    page?.mode === "cdp" || process.env.TT_LITE_PROFILE_NAV !== "0";

  if (preferCapture) {
    const captured = await captureProfileApisFromNavigation(page, handle);
    if (captured.userDetail) {
      const fromDetail = extractUserInfoFromUserDetailAPI(captured.userDetail);
      if (fromDetail) {
        userInfo = { ...userInfo, ...fromDetail, username: fromDetail.username || handle };
      }
    }
    itemBatches = captured.itemListBatches || [];
  } else {
    try {
      const detailJson = await fetchUserDetail(page, handle, {
        secUid: options.secUid || userInfo.secUid || "",
      });
      const fromDetail = extractUserInfoFromUserDetailAPI(detailJson);
      if (fromDetail) {
        userInfo = { ...userInfo, ...fromDetail, username: fromDetail.username || handle };
      }
    } catch (e) {
      console.warn(`[extractTiktokProfileLite] user/detail @${handle}: ${e.message}`);
    }

    const secUidForFetch = userInfo.secUid || options.secUid;
    if (secUidForFetch) {
      itemBatches = await fetchPostItemListAll(page, {
        secUid: secUidForFetch,
        maxPages: Math.min(
          Math.max(Number(process.env.TT_LITE_ITEM_LIST_MAX_PAGES || 3), 1),
          8
        ),
      });
    }
  }

  const secUid = userInfo.secUid || options.secUid;
  if (!secUid && !itemBatches.length && !userInfo.followers) {
    return {
      success: false,
      error: "missing_profile_data",
      userInfo: { ...userInfo, profileUrl: `https://www.tiktok.com/@${handle}` },
      videos: [],
    };
  }

  let videos = [];
  for (const batch of itemBatches) {
    videos = videos.concat(extractVideosFromAPI(batch, userInfo.username || handle));
  }

  if (!userInfo.userId || !userInfo.followers) {
    for (const batch of itemBatches) {
      const partial = extractUserInfoFromAPI(batch);
      userInfo = {
        ...userInfo,
        ...partial,
        username: partial.username || userInfo.username || handle,
        secUid: partial.secUid || userInfo.secUid,
      };
      if (userInfo.followers && userInfo.userId) break;
    }
  }

  const videoMap = new Map();
  for (const v of videos) {
    if (v.videoId && !videoMap.has(v.videoId)) videoMap.set(v.videoId, v);
  }
  videos = Array.from(videoMap.values()).slice(0, maxVideos);
  const statistics = computeStatistics(videos);
  const success = videos.length > 0 || !!userInfo.userId || !!userInfo.followers;

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success
      ? `TikTok Lite @${handle}: ${videos.length} 视频`
      : `TikTok Lite @${handle} 无数据`,
    { videos: videos.length }
  );

  return {
    success,
    userInfo: {
      ...userInfo,
      profileUrl: `https://www.tiktok.com/@${userInfo.username || handle}`,
    },
    videos,
    statistics,
    extractMode: "lite",
    enrichEndpoint: page?._ttApiSessionKey || process.env.CDP_ENDPOINT || "http://127.0.0.1:9222",
  };
}
