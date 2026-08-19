/**
 * TikTok Lite 主页 enrich：9223 signed API（user/detail + post/item_list），不打开 @profile 页面
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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
  classifyItemListError,
} from "./tiktok-direct-fetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const ENRICH_LOG = path.join(PROJECT_ROOT, "logs", "tiktok-enrich.log");

/** enrich 阶段逐条落盘（worker console 隐藏，用于排查单条耗时/停滞） */
function logEnrich(msg) {
  try {
    fs.mkdirSync(path.dirname(ENRICH_LOG), { recursive: true });
    fs.appendFileSync(ENRICH_LOG, `${new Date().toISOString()} ${msg}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

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

function isTiktokLiteEmailGateEnabled(
  raw = process.env.TT_LITE_REQUIRE_EMAIL_FOR_ANALYSIS
) {
  return String(raw ?? "0").trim() === "1";
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
 * @param {{ onStepUpdate?: Function, secUid?: string, userId?: string, userInfo?: object }} [options]
 */
export async function extractTiktokProfileLite(page, username, options = {}) {
  const { onStepUpdate = null, userInfo: prefetchedUserInfo = null } = options;
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

  if (prefetchedUserInfo) {
    // 预过滤阶段已拉过 user/detail（邮箱/粉丝门槛），直接复用，省一次 API 请求。
    userInfo = {
      ...userInfo,
      ...prefetchedUserInfo,
      username: prefetchedUserInfo.username || handle,
    };
  } else {
    try {
      const t0 = Date.now();
      const detailJson = await fetchUserDetail(page, handle, {
        secUid: options.secUid || userInfo.secUid || "",
        userId: options.userId || userInfo.userId || "",
      });
      const fromDetail = extractUserInfoFromUserDetailAPI(detailJson);
      if (fromDetail) {
        userInfo = { ...userInfo, ...fromDetail, username: fromDetail.username || handle };
      }
      logEnrich(
        `@${handle} user/detail ${Date.now() - t0}ms ok=${!!fromDetail} endpoint=${page?._ttApiSessionKey || "-"}`
      );
    } catch (e) {
      console.warn(`[extractTiktokProfileLite] user/detail @${handle}: ${e.message}`);
      logEnrich(`@${handle} user/detail FAIL ${e.message}`);
    }
  }

  if (userInfo.email && !userInfo.aboutEmailSource) {
    userInfo.aboutEmailSource = "bio";
    userInfo.aboutEmailSourceDetail = "tiktok_user_detail_signature";
  }

  if (isTiktokLiteEmailGateEnabled() && !String(userInfo.email || "").trim()) {
    const profileUrl = `https://www.tiktok.com/@${userInfo.username || handle}`;
    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      STEP_STATUS.COMPLETED,
      `TikTok Lite @${handle}: bio 未识别到邮箱，跳过视频 enrich`,
      { videos: 0, skippedReason: "profile_email_not_found" }
    );
    return {
      success: true,
      skippedReason: "profile_email_not_found",
      error: null,
      userInfo: {
        ...userInfo,
        profileUrl,
      },
      videos: [],
      statistics: null,
      dataIncomplete: true,
      extractMode: "lite",
      enrichEndpoint:
        page?._ttApiSessionKey ||
        process.env.CDP_ENDPOINT_ENRICH ||
        "http://127.0.0.1:9223",
    };
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
    const t1 = Date.now();
    itemBatches = await fetchPostItemListAll(page, {
      secUid,
      referer: `https://www.tiktok.com/@${handle}`,
    });
    const itemListMs = Date.now() - t1;
    const signedVideoCountNow = itemBatches.reduce(
      (sum, b) => sum + (b?.itemList?.length || b?.item_list?.length || 0),
      0
    );
    logEnrich(
      `@${handle} item_list pages=${itemBatches.length} items=${signedVideoCountNow} ${itemListMs}ms endpoint=${page?._ttApiSessionKey || "-"}`
    );
    if (itemListMs > 15000) {
      logEnrich(`@${handle} SLOW item_list ${itemListMs}ms (possible stall)`);
    }
  } catch (e) {
    console.warn(`[extractTiktokProfileLite] post/item_list @${handle}: ${e.message}`);
    logEnrich(`@${handle} item_list FAIL ${e.message}`);
    itemBatches.itemListError = classifyItemListError(e);
  }

  const signedVideoCount = itemBatches.reduce(
    (sum, b) => sum + (b?.itemList?.length || b?.item_list?.length || 0),
    0
  );
  if (signedVideoCount < maxVideos && process.env.TT_LITE_API_FETCH_DEBUG === "1") {
    console.log(
      `[extractTiktokProfileLite] post/item_list ${signedVideoCount}/${maxVideos} @${handle}`
    );
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
  const hasUserInfo = !!userInfo.userId || !!userInfo.followers;
  const allowEmptyVideos =
    String(process.env.TT_LITE_ALLOW_EMPTY_PROFILE_SUCCESS || "")
      .trim()
      .toLowerCase() === "1";
  const videoFetchError = videos.length > 0 ? null : "profile_videos_empty";
  const success = hasUserInfo && (videos.length > 0 || allowEmptyVideos);

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success
      ? `TikTok Lite @${handle}: ${videos.length} 视频`
      : `TikTok Lite @${handle} 视频为空`,
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
    dataIncomplete: !success,
    itemListError: itemBatches.itemListError || null,
    enrichError: success ? null : videoFetchError,
    error: success ? null : videoFetchError,
    extractMode: "lite",
    enrichEndpoint:
      page?._ttApiSessionKey ||
      process.env.CDP_ENDPOINT_ENRICH ||
      "http://127.0.0.1:9223",
  };
}
