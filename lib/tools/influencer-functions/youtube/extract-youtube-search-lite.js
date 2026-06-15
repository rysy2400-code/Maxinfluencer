/**
 * YouTube Lite 搜索：innertube 直调，不打开搜索页、不滚动、不截图
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractSearchRenderersFromJson,
  channelFromVideoRenderer,
  channelFromChannelRenderer,
  mergeChannelIntoMap,
  mapVideoRendererToSearchClip,
} from "./youtube-json-utils.js";
import {
  acquireYoutubeInnertubeSession,
  fetchSearchFirstPage,
  fetchSearchContinuation,
  paginateViaContinuation,
} from "./innertube-direct-fetch.js";
import { isLiteScreenshotsDisabled } from "../../../scraper/resolve-scraper-mode.js";
import { reportYtScreenshot } from "./yt-cdp-screenshot.js";

function resolveYtLiteSearchMaxPages(maxChannels, scrollUntilStuck = true) {
  const target = Math.max(Number(maxChannels) || 120, 40);
  const envPages = Number(process.env.YT_LITE_SEARCH_MAX_PAGES);
  const estimated = Math.ceil(target / 6);
  const base = envPages > 0 ? envPages : scrollUntilStuck !== false ? Math.max(20, estimated) : Math.max(8, estimated);
  return Math.min(Math.max(base, 3), 80);
}

function reportStep(onStepUpdate, stepId, status, detail = null, stats = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, stats) });
  } catch {
    /* ignore */
  }
}

function ingestSearchBatch(batch, channelMap, videosFlat, maxChannels) {
  const seenVideoIds = new Set(videosFlat.map((v) => v.videoId).filter(Boolean));
  for (const cr of batch.channels) {
    mergeChannelIntoMap(channelMap, channelFromChannelRenderer(cr), maxChannels);
  }
  for (const vr of batch.videos) {
    const ch = channelFromVideoRenderer(vr);
    mergeChannelIntoMap(channelMap, ch, maxChannels);
    const key =
      ch?.channelId || (ch?.handle ? `@${ch.handle.toLowerCase()}` : null);
    const rec = key ? channelMap.get(key) : null;
    const clip = mapVideoRendererToSearchClip(vr, rec);
    if (clip?.videoId && !seenVideoIds.has(clip.videoId)) {
      seenVideoIds.add(clip.videoId);
      videosFlat.push(clip);
      if (rec) {
        rec.search_video_data.push({
          videoId: clip.videoId,
          videoUrl: clip.videoUrl,
          description: clip.description,
          views: clip.views,
          thumbnail: clip.thumbnail,
        });
      }
    }
  }
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} keyword
 * @param {{ onStepUpdate?: Function, maxChannels?: number }} [options]
 */
export async function extractYoutubeSearchLite(context, keyword, options = {}) {
  const { onStepUpdate = null } = options;
  const maxChannels = Math.min(
    Math.max(Number(options.maxChannels || process.env.YT_SEARCH_MAX_CHANNELS || 120), 1),
    2000
  );

  const session = await acquireYoutubeInnertubeSession(context);
  const { page } = session;

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    STEP_STATUS.RUNNING,
    `YouTube Lite 搜索: ${keyword}`
  );

  const channelMap = new Map();
  const videosFlat = [];
  const capturedJson = [];
  let apiBatchCount = 0;
  let continuationPages = 0;

  const pushJson = (json) => {
    const batch = extractSearchRenderersFromJson(json);
    if (!batch.videos.length && !batch.channels.length) return false;
    capturedJson.push(json);
    apiBatchCount += 1;
    ingestSearchBatch(batch, channelMap, videosFlat, maxChannels);
    return true;
  };

  try {
    const first = await fetchSearchFirstPage(page, keyword);
    if (!first) {
      throw new Error("innertube search 首屏失败");
    }
    const ok = pushJson(first);
    console.log(
      `[extractYoutubeSearchLite] 首屏 API: ${ok ? channelMap.size : 0} channels`
    );

    const { pages } = await paginateViaContinuation(page, capturedJson, pushJson, {
      fetchPage: fetchSearchContinuation,
      getProgress: () => `${channelMap.size}|${videosFlat.length}`,
      maxPages: resolveYtLiteSearchMaxPages(maxChannels, options.scrollUntilStuck),
    });
    continuationPages = pages;

    const influencerRecords = Array.from(channelMap.values()).slice(0, maxChannels);
    const success = influencerRecords.length > 0;

    if (success && !isLiteScreenshotsDisabled()) {
      await reportYtScreenshot(
        onStepUpdate,
        BROWSER_STEP_IDS.SEARCH_VIDEOS,
        `YouTube Lite 搜索完成（${influencerRecords.length} 频道）`,
        page
      );
    }

    console.log(
      `[extractYoutubeSearchLite] 完成 channels=${influencerRecords.length} videos=${videosFlat.length} ` +
        `apiBatches=${apiBatchCount} continuationPages=${continuationPages}`
    );

    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.SEARCH_VIDEOS,
      success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
      success
        ? `YouTube Lite: ${influencerRecords.length} 频道`
        : "Lite 搜索无结果",
      { channels: influencerRecords.length, apiBatches: apiBatchCount }
    );

    return {
      success,
      workPage: page,
      session,
      influencerRecords,
      videos: videosFlat,
      stats: {
        influencerCount: influencerRecords.length,
        videoCount: videosFlat.length,
        apiBatches: apiBatchCount,
        continuationPages,
        extractionSource: "innertube_search_direct",
        extractMode: "lite",
        scrollRounds: 0,
      },
      searchUrl: `(lite-api) query=${keyword}`,
      error: success ? null : "no_youtube_search_results",
    };
  } catch (e) {
    await session.dispose();
    throw e;
  }
}
