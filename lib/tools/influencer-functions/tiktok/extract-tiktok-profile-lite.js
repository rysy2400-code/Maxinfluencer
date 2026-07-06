/**
 * TikTok Lite 主页 enrich：9223 signed API（user/detail + post/item_list），不打开 @profile 页面
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
 * @param {object} page 9223 tiktok.com API 会话
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
    `TikTok Lite enrich @${handle}（signed API）`
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

  const secUid = userInfo.secUid || options.secUid;
  if (!secUid) {
    return {
      success: false,
      error: "missing_sec_uid",
      userInfo: { ...userInfo, profileUrl: `https://www.tiktok.com/@${handle}` },
      videos: [],
    };
  }

  let itemBatches = [];
  try {
    itemBatches = await fetchPostItemListAll(page, {
      secUid,
      referer: `https://www.tiktok.com/@${handle}`,
    });
  } catch (e) {
    console.warn(`[extractTiktokProfileLite] post/item_list @${handle}: ${e.message}`);
  }

  const signedVideoCount = itemBatches.reduce(
    (sum, b) => sum + (b?.itemList?.length || b?.item_list?.length || 0),
    0
  );
  const enrichNavAllowed =
    process.env.TT_LITE_ENRICH_ALLOW_NAV !== "0" &&
    process.env.TT_LITE_ALLOW_NAV !== "0";
  if (signedVideoCount === 0 && enrichNavAllowed) {
    console.warn(
      `[extractTiktokProfileLite] post/item_list empty @${handle}, navigation fallback`
    );
    try {
      const nav = await captureProfileApisFromNavigation(page, handle);
      if (nav.userDetail && !userInfo.followers) {
        const fromNav = extractUserInfoFromUserDetailAPI(nav.userDetail);
        if (fromNav) {
          userInfo = { ...userInfo, ...fromNav, username: fromNav.username || handle };
        }
      }
      if (nav.itemListBatches?.length) {
        itemBatches = nav.itemListBatches;
      }
    } catch (e) {
      console.warn(
        `[extractTiktokProfileLite] profile nav fallback @${handle}: ${e.message}`
      );
    }
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
    enrichEndpoint:
      page?._ttApiSessionKey ||
      process.env.CDP_ENDPOINT_ENRICH ||
      "http://127.0.0.1:9223",
  };
}
