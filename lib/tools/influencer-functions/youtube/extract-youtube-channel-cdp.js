/**
 * YouTube 频道 /videos：默认纯 innertube API（/browse、/next）；api_first 时可回退 ytInitialData
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
  buildChannelProfileUrl,
} from "./youtube-json-utils.js";
import { reportYtScreenshot } from "./yt-cdp-screenshot.js";
import {
  attachInnertubeCollector,
  readYtInitialDataFromPage,
  resolveYtExtractMode,
} from "./cdp-innertube-collector.js";
import { enrichUserInfoFromAboutPage } from "./yt-about-enrich.js";
import { enrichYoutubeVideosEngagement } from "./yt-video-engagement-enrich.js";
import { guardedGoto } from "../../../cdp/cdp-tab-utils.js";

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

const DEFAULT_MAX_VIDEOS = 50;
const DEFAULT_SCROLL_ROUNDS = 15;
const DEFAULT_MAX_STALE_ROUNDS = 3;

function reportStep(onStepUpdate, stepId, status, detail = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, null) });
  } catch {
    /* ignore */
  }
}

function resolveMaxVideos() {
  return Math.min(
    Math.max(
      Number(process.env.YT_CHANNEL_MAX_VIDEOS || DEFAULT_MAX_VIDEOS) ||
        DEFAULT_MAX_VIDEOS,
      1
    ),
    80
  );
}

function resolveScrollRounds() {
  return Math.min(
    Math.max(
      Number(process.env.YT_VIDEOS_SCROLL_ROUNDS || DEFAULT_SCROLL_ROUNDS) ||
        DEFAULT_SCROLL_ROUNDS,
      3
    ),
    40
  );
}

function resolveMaxStaleRounds() {
  return Math.min(
    Math.max(
      Number(process.env.YT_VIDEOS_MAX_STALE_ROUNDS || DEFAULT_MAX_STALE_ROUNDS) ||
        DEFAULT_MAX_STALE_ROUNDS,
      1
    ),
    8
  );
}

function ingestBrowseBatches(batches, videoMap, maxVideos, browseJsonForHeader) {
  let added = 0;
  for (const b of batches) {
    if (b.kind !== "browse" && b.kind !== "next") continue;
    const vids = extractVideosFromInnertubeJson(b.json);
    const before = videoMap.size;
    for (const v of vids) mergeYtVideoIntoMap(videoMap, v, maxVideos);
    added += videoMap.size - before;
    if (b.kind === "browse" || b.kind === "next") {
      browseJsonForHeader.push(b.json);
    }
  }
  return added;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} username handle（无 @）或 UC channelId
 * @param {{ onStepUpdate?: Function, channelId?: string }} [options]
 */
export async function extractYoutubeChannelFromPageCDP(page, username, options = {}) {
  const { onStepUpdate = null } = options;
  const extractMode = resolveYtExtractMode();
  const handle = String(username || "")
    .replace(/^@/, "")
    .trim();
  const channelIdOpt = options.channelId || null;
  const maxVideos = resolveMaxVideos();
  const scrollRounds = resolveScrollRounds();
  const maxStaleRounds = resolveMaxStaleRounds();

  if (!handle && !channelIdOpt) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  const videosUrl =
    buildChannelProfileUrl(handle, channelIdOpt) ||
    `https://www.youtube.com/@${handle}/videos`;

  const videoMap = new Map();
  const browseJsonForHeader = [];
  let apiBatchCount = 0;
  let initialDataUsed = false;

  let collector = attachInnertubeCollector(page);

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `正在提取 @${handle || channelIdOpt} 的 Videos（目标 ${maxVideos} 条） [${extractMode}]`
  );

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  console.log(`[extractYoutubeChannel] goto ${videosUrl} mode=${extractMode}`);
  try {
    const beforeGotoPage = page;
    page = await guardedGoto(page, videosUrl, {
      label: "yt_channel_videos",
      budgetMs: 30_000,
      waitUntil: "domcontentloaded",
      retries: 1,
      createRetryPage: async () => page.context().newPage(),
    });
    if (page !== beforeGotoPage) {
      collector.detach();
      collector = attachInnertubeCollector(page);
    }
  } catch (e) {
    console.warn(`[extractYoutubeChannel] goto 警告: ${e.message}`);
  }

  await page.waitForTimeout(2500);

  // goto 后 drain（频道首屏通常无 browse 数据 API，数据在滚动后）
  const gotoBatches = collector.drain();
  const gotoAdded = ingestBrowseBatches(
    gotoBatches,
    videoMap,
    maxVideos,
    browseJsonForHeader
  );
  if (gotoAdded > 0) {
    apiBatchCount += gotoBatches.filter((b) => b.kind === "browse" || b.kind === "next").length;
    console.log(`[extractYoutubeChannel] goto API 视频 +${gotoAdded}`);
  }

  await reportYtScreenshot(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    `YouTube 频道 Videos @${handle || channelIdOpt}`,
    page
  );

  let staleRounds = 0;
  let round = 0;
  while (round < scrollRounds && videoMap.size < maxVideos) {
    const sizeBefore = videoMap.size;
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight)
    );

    const scrollBatches = await collector.waitFor(["browse", "next"], {
      timeoutMs: Number(process.env.YT_API_WAIT_MS || 12000),
    });
    const added = ingestBrowseBatches(
      scrollBatches,
      videoMap,
      maxVideos,
      browseJsonForHeader
    );
    if (added > 0) {
      apiBatchCount += scrollBatches.filter(
        (b) => b.kind === "browse" || b.kind === "next"
      ).length;
      console.log(
        `[extractYoutubeChannel] API /browse|next +${added} (total ${videoMap.size})`
      );
    }

    round += 1;
    if (videoMap.size === sizeBefore) {
      staleRounds += 1;
    } else {
      staleRounds = 0;
    }
    if (staleRounds >= maxStaleRounds) {
      console.log(
        `[extractYoutubeChannel] @${handle} 连续 ${maxStaleRounds} 轮无新视频，停止`
      );
      break;
    }
  }

  await page.waitForTimeout(1500);

  // 回退 ytInitialData
  const needFallback =
    extractMode !== "api_only" &&
    (videoMap.size === 0 || extractMode === "initial_only");
  let ytInitialData = null;
  if (needFallback && videoMap.size < maxVideos) {
    try {
      ytInitialData = await readYtInitialDataFromPage(page);
      if (ytInitialData) {
        const initVids = extractVideosFromInnertubeJson(ytInitialData);
        const before = videoMap.size;
        for (const v of initVids) mergeYtVideoIntoMap(videoMap, v, maxVideos);
        const added = videoMap.size - before;
        if (added > 0) {
          initialDataUsed = true;
          console.log(
            `[extractYoutubeChannel] ytInitialData 回退 +${added} (total ${videoMap.size})`
          );
        }
      }
    } catch (e) {
      console.warn(`[extractYoutubeChannel] ytInitialData 回退失败: ${e.message}`);
    }
  }

  collector.detach();

  let userInfo = null;
  if (ytInitialData) {
    userInfo = extractChannelHeaderFromInnertubeJson(ytInitialData, handle);
  }
  for (const json of browseJsonForHeader) {
    const h = extractChannelHeaderFromInnertubeJson(json, handle);
    if (h) userInfo = mergeUserInfo(userInfo, h);
    if (userInfo?.followers?.count > 0) break;
  }

  if (!userInfo?.followers?.count) {
    try {
      const hdrData = await readYtInitialDataFromPage(page);
      if (hdrData) {
        userInfo = mergeUserInfo(
          userInfo,
          extractChannelHeaderFromInnertubeJson(hdrData, handle)
        );
      }
    } catch (e) {
      console.warn(`[extractYoutubeChannel] /videos 头部读取失败: ${e.message}`);
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

  const needAbout =
    !userInfo.country || !userInfo.email || !(userInfo.followers?.count > 0);
  if (needAbout) {
    const aboutUrl = videosUrl.replace(/\/(videos|about|shorts)$/, "") + "/about";
    userInfo = await enrichUserInfoFromAboutPage(
      page,
      aboutUrl,
      videosUrl,
      userInfo,
      handle
    );
  }

  const profileUrl =
    userInfo.channelId || channelIdOpt
      ? `https://www.youtube.com/channel/${userInfo.channelId || channelIdOpt}`
      : `https://www.youtube.com/@${handle}`;

  userInfo.profileUrl = profileUrl;
  userInfo.userId = userInfo.channelId || channelIdOpt || null;

  const videosRaw = sortYtVideosByRecency(Array.from(videoMap.values())).slice(
    0,
    maxVideos
  );
  const videos = await enrichYoutubeVideosEngagement(page, videosRaw, {
    maxVideos,
  });
  const statistics = computeYtVideoStatistics(videos);
  const success = videos.length > 0 || !!userInfo.channelId;

  const source =
    apiBatchCount > 0 && !initialDataUsed
      ? "innertube_browse_api"
      : apiBatchCount > 0 && initialDataUsed
        ? "innertube_browse_api+ytInitialData"
        : initialDataUsed
          ? "ytInitialData"
          : "none";

  console.log(
    `[extractYoutubeChannel] @${handle} videos=${videos.length} apiBatches=${apiBatchCount} source=${source} country=${userInfo.country || "(空)"} avgLikes=${statistics.avgLikes ?? "n/a"} avgComments=${statistics.avgComments ?? "n/a"}`
  );

  await reportYtScreenshot(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    `Videos 提取完成 @${handle}（${videos.length} 条）`,
    page
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success
      ? `@${handle} ${videos.length} 条视频，均播 ${statistics.avgViews ?? "—"}`
      : `未获取到 @${handle} 的视频列表`
  );

  return {
    success,
    error: success ? null : "youtube_videos_not_found",
    userInfo,
    videos,
    statistics,
    profileUrl,
    videosUrl,
    videoPublishCountry: userInfo.country || null,
    extractionSource: source,
    extractMode,
    interceptedCounts: {
      browseBatches: apiBatchCount,
      videosKept: videos.length,
      scrollRoundsUsed: round,
      initialDataUsed,
    },
  };
}
