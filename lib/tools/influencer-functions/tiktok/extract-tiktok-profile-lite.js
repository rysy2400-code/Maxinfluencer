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
} from "./tiktok-direct-fetch.js";
// 注意：navigation 兜底 helper 在 "signed API" 重构后已从 tiktok-direct-fetch 移除。
// 之前用「具名 import」引用不存在的导出，会让整个模块 import 失败（TikTok Lite enrich 直接挂掉）。
// 这里改为命名空间引用 + 运行时判空，保持「有则用、无则跳过兜底」的语义。
import * as tiktokDirectFetch from "./tiktok-direct-fetch.js";
import { computeViewMedianAndRates } from "../../../influencer/video-metrics.js";

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
  // 口径统一：剔除播放量为 0/缺失的视频；所有样本指标（均播、均赞、均评、中位、比率）
  // 都只在这批视频上计算，均值分母同步用剔除后的条数。
  const viewVideos = (videos || []).filter((v) => (v.views?.count || 0) > 0);
  const avg = (list, getter) =>
    list.length > 0
      ? list.reduce((sum, v) => sum + (getter(v) || 0), 0) / list.length
      : null;
  const avgViews = avg(viewVideos, (v) => v.views?.count);
  const avgLikes = avg(viewVideos, (v) => v.likes?.count);
  const avgComments = avg(viewVideos, (v) => v.comments?.count);
  const avgFavorites = avg(viewVideos, (v) => v.favorites?.count);
  return {
    videoCount: videos.length,
    avgViews: avgViews ? Math.round(avgViews) : null,
    avgLikes: avgLikes ? Math.round(avgLikes) : null,
    avgComments: avgComments ? Math.round(avgComments) : null,
    avgFavorites: avgFavorites ? Math.round(avgFavorites) : null,
    videosWithPlayCount: viewVideos.length,
    // 中位播放 + 点赞率/评论率：与均播同一批样本（views > 0）
    ...computeViewMedianAndRates(viewVideos),
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
      const captureApis =
        tiktokDirectFetch.captureProfileApisFromNavigation ||
        tiktokDirectFetch.captureProfileApis;
      if (typeof captureApis !== "function") {
        throw new Error("navigation capture helper unavailable");
      }
      const nav = await captureApis(page, handle);
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
