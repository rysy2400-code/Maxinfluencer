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
  extractChannelHeaderFromBrowseJson,
  extractChannelHeaderFromYtInitialData,
  computeYtVideoStatistics,
  mergeYtVideoIntoMap,
  sortYtVideosByRecency,
  buildChannelProfileUrl,
} from "./youtube-json-utils.js";
import { extractEmailFromBio } from "../../../influencer/extract-email-from-bio.js";
import { reportYtScreenshot } from "./yt-cdp-screenshot.js";
import {
  attachInnertubeCollector,
  readYtInitialDataFromPage,
  resolveYtExtractMode,
} from "./cdp-innertube-collector.js";

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

function ingestBrowseBatches(batches, videoMap, maxVideos) {
  let added = 0;
  for (const b of batches) {
    if (b.kind !== "browse" && b.kind !== "next") continue;
    const vids = extractVideosFromInnertubeJson(b.json);
    const before = videoMap.size;
    for (const v of vids) mergeYtVideoIntoMap(videoMap, v, maxVideos);
    added += videoMap.size - before;
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

  const collector = attachInnertubeCollector(page);

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
    await page.goto(videosUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  } catch (e) {
    console.warn(`[extractYoutubeChannel] goto 警告: ${e.message}`);
  }

  await page.waitForTimeout(2500);

  // goto 后 drain（频道首屏通常无 browse 数据 API，数据在滚动后）
  const gotoBatches = collector.drain();
  const gotoAdded = ingestBrowseBatches(gotoBatches, videoMap, maxVideos);
  if (gotoAdded > 0) {
    apiBatchCount += gotoBatches.filter((b) => b.kind === "browse" || b.kind === "next").length;
    console.log(`[extractYoutubeChannel] goto API 视频 +${gotoAdded}`);
  }
  for (const b of gotoBatches) {
    if (b.kind === "browse" || b.kind === "next") browseJsonForHeader.push(b.json);
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
    const added = ingestBrowseBatches(scrollBatches, videoMap, maxVideos);
    if (added > 0) {
      apiBatchCount += scrollBatches.filter(
        (b) => b.kind === "browse" || b.kind === "next"
      ).length;
      console.log(
        `[extractYoutubeChannel] API /browse|next +${added} (total ${videoMap.size})`
      );
    }
    for (const b of scrollBatches) {
      if (b.kind === "browse" || b.kind === "next") browseJsonForHeader.push(b.json);
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
    userInfo = extractChannelHeaderFromYtInitialData(ytInitialData, handle);
  }
  if (!userInfo) {
    for (const json of browseJsonForHeader) {
      const h = extractChannelHeaderFromBrowseJson(json, handle);
      if (h) {
        userInfo = h;
        break;
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

  if (!userInfo.country || !userInfo.email) {
    try {
      const aboutUrl = videosUrl.replace(/\/(videos|about|shorts)$/, "") + "/about";
      await page.goto(aboutUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      const aboutData = await readYtInitialDataFromPage(page);
      if (aboutData) {
        let aboutMeta = null;
        const walkAbout = (obj, d = 0) => {
          if (d > 22 || !obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) {
            obj.forEach((x) => walkAbout(x, d + 1));
            return;
          }
          if (obj.channelAboutFullMetadataRenderer || obj.aboutChannelViewModel) {
            aboutMeta = obj.channelAboutFullMetadataRenderer || obj.aboutChannelViewModel;
            return;
          }
          for (const v of Object.values(obj)) {
            if (typeof v === "object" && v) walkAbout(v, d + 1);
          }
        };
        walkAbout(aboutData);
        if (aboutMeta) {
          const countryText =
            (typeof aboutMeta.country === "string" ? aboutMeta.country : null) ||
            aboutMeta?.country?.simpleText ||
            null;
          if (countryText && !userInfo.country) userInfo.country = countryText;
          const desc =
            (typeof aboutMeta.description === "string"
              ? aboutMeta.description
              : null) ||
            aboutMeta?.description?.simpleText ||
            (aboutMeta?.description?.runs || []).map((r) => r.text || "").join("") ||
            "";
          if (desc && !userInfo.bio) userInfo.bio = desc;
          const emailFromAbout = extractEmailFromBio(desc) || null;
          if (emailFromAbout && !userInfo.email) userInfo.email = emailFromAbout;
          console.log(
            `[extractYoutubeChannel] /about country=${countryText || "(空)"} email=${emailFromAbout || "(无)"}`
          );
        }
      }
    } catch (e) {
      console.warn(`[extractYoutubeChannel] /about 读取失败: ${e.message}`);
    }
  }

  const profileUrl =
    userInfo.channelId || channelIdOpt
      ? `https://www.youtube.com/channel/${userInfo.channelId || channelIdOpt}`
      : `https://www.youtube.com/@${handle}`;

  userInfo.profileUrl = profileUrl;
  userInfo.userId = userInfo.channelId || channelIdOpt || null;

  const videos = sortYtVideosByRecency(Array.from(videoMap.values())).slice(
    0,
    maxVideos
  );
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
    `[extractYoutubeChannel] @${handle} videos=${videos.length} apiBatches=${apiBatchCount} source=${source} country=${userInfo.country || "(空)"}`
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
