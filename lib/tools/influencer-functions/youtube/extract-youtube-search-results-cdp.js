/**
 * YouTube 关键词搜索（视频 Tab）
 * 默认 api_first：优先 innertube API（/youtubei/v1/search），无数据时回退 ytInitialData
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
import { reportYtScreenshot } from "./yt-cdp-screenshot.js";
import { gotoYoutubeSearchUrl } from "./cdp-page-utils.js";
import { safeCloseCdpPage } from "../../../cdp/cdp-tab-utils.js";
import {
  attachInnertubeCollector,
  readYtInitialDataFromPage,
  resolveYtExtractMode,
} from "./cdp-innertube-collector.js";
import {
  runYoutubeSearchScrollUntilStuck,
  resolveYtSearchScrollConfig,
} from "./yt-search-scroll.js";
import {
  paginateSearchViaContinuation,
  extractSearchContinuationToken,
} from "./yt-search-pagination.js";

/** YouTube 搜索「视频」筛选（sp=EgIQAQ==） */
const SEARCH_FILTER_VIDEOS_SP = "EgIQAQ%3D%3D";

function buildVideoSearchUrl(keyword) {
  const q = encodeURIComponent(String(keyword || "").trim());
  return `https://www.youtube.com/results?search_query=${q}&sp=${SEARCH_FILTER_VIDEOS_SP}`;
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
  let apiVideos = 0;
  for (const cr of batch.channels) {
    const ch = channelFromChannelRenderer(cr);
    mergeChannelIntoMap(channelMap, ch, maxChannels);
  }
  for (const vr of batch.videos) {
    apiVideos += 1;
    const ch = channelFromVideoRenderer(vr);
    mergeChannelIntoMap(channelMap, ch, maxChannels);
    const key =
      ch?.channelId || (ch?.handle ? `@${ch.handle.toLowerCase()}` : null);
    const rec = key ? channelMap.get(key) : null;
    const clip = mapVideoRendererToSearchClip(vr, rec);
    if (clip && clip.videoId && !seenVideoIds.has(clip.videoId)) {
      seenVideoIds.add(clip.videoId);
      videosFlat.push(clip);
      if (rec) {
        rec.search_video_data.push({
          videoId: clip.videoId,
          videoUrl: clip.videoUrl,
          description: clip.description,
          views: clip.views,
          duration: clip.duration,
          durationSeconds: clip.durationSeconds,
          publishedTimeText: clip.publishedTimeText,
          thumbnail: clip.thumbnail,
        });
      }
    }
  }
  return apiVideos;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} keyword
 * @param {{ onStepUpdate?: Function, maxChannels?: number, scrollRounds?: number }} [options]
 */
export async function extractYoutubeSearchResultsFromPageCDP(
  page,
  keyword,
  options = {}
) {
  const { onStepUpdate = null } = options;
  const extractMode = resolveYtExtractMode();
  const scrollUntilStuck = options.scrollUntilStuck !== false;
  const ytTiming = resolveYtSearchScrollConfig();
  const maxChannels = Math.min(
    Math.max(
      Number(options.maxChannels || process.env.YT_SEARCH_MAX_CHANNELS || 500),
      1
    ),
    2000
  );
  const scrollRounds = Math.min(
    Math.max(
      Number(options.scrollRounds || process.env.YT_SEARCH_SCROLL_ROUNDS || 12),
      3
    ),
    30
  );

  const searchUrl = buildVideoSearchUrl(keyword);
  const captured = [];
  /** @type {object[]} */
  const capturedJson = [];
  let apiBatchCount = 0;
  let continuationPages = 0;
  let scrollRoundsDone = 0;
  let initialDataUsed = false;

  let workPage = page;
  let collector = attachInnertubeCollector(workPage);

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    STEP_STATUS.RUNNING,
    `YouTube 关键词搜索（视频）: ${keyword} [${extractMode}]`
  );

  console.log(
    `[extractYoutubeSearch] goto ${searchUrl} mode=${extractMode}`
  );
  const afterGoto = await gotoYoutubeSearchUrl(workPage, searchUrl, {
    logPrefix: "[extractYoutubeSearch]",
  });
  if (afterGoto !== workPage) {
    collector.detach();
    await safeCloseCdpPage(workPage);
    workPage = afterGoto;
    collector = attachInnertubeCollector(workPage);
  }
  await workPage.waitForTimeout(ytTiming.gotoSettleMs);

  const channelMap = new Map();
  const videosFlat = [];

  const pushSearchJson = (json, { fromInitial = false } = {}) => {
    const batch = extractSearchRenderersFromJson(json);
    if (!batch.videos.length && !batch.channels.length) return false;
    captured.push(batch);
    capturedJson.push(json);
    if (fromInitial) initialDataUsed = true;
    else apiBatchCount += 1;
    ingestSearchBatch(batch, channelMap, videosFlat, maxChannels);
    return true;
  };

  const onContinuationJson = (json) => {
    pushSearchJson(json);
  };

  const runContinuationPages = async (label, { startToken = null } = {}) => {
    if (channelMap.size >= maxChannels) return 0;
    const channelsBefore = channelMap.size;
    const { pages } = await paginateSearchViaContinuation(
      workPage,
      capturedJson,
      onContinuationJson,
      {
        startToken,
        maxChannels,
        getChannelCount: () => channelMap.size,
        getVideoCount: () => videosFlat.length,
      }
    );
    continuationPages += pages;
    if (pages > 0) {
      console.log(
        `[extractYoutubeSearch] continuation (${label}): +${pages} pages, channels=${channelMap.size} (was ${channelsBefore})`
      );
    }
    return pages;
  };

  // goto 阶段偶发 search API；先 drain
  let batches = collector.drain();
  for (const b of batches) {
    if (b.kind === "search") {
      const batch = extractSearchRenderersFromJson(b.json);
      if (batch.videos.length || batch.channels.length) {
        pushSearchJson(b.json);
        console.log(
          `[extractYoutubeSearch] API /search (goto): ${batch.videos.length} videos`
        );
      }
    }
  }

  // P1：首屏立即 ingest ytInitialData（不等滚动失败）
  if (extractMode !== "api_only" && channelMap.size < maxChannels) {
    try {
      const ytInitialData = await readYtInitialDataFromPage(workPage);
      if (ytInitialData) {
        const batch = extractSearchRenderersFromJson(ytInitialData);
        if (batch.videos.length || batch.channels.length) {
          pushSearchJson(ytInitialData, { fromInitial: true });
          console.log(
            `[extractYoutubeSearch] ytInitialData 首屏: ${batch.videos.length} videos → ${channelMap.size} channels`
          );
        }
      }
    } catch (e) {
      console.warn(`[extractYoutubeSearch] ytInitialData 首屏失败: ${e.message}`);
    }
  }

  // P2：首屏 continuation 主动翻页
  await runContinuationPages("initial");

  await reportYtScreenshot(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    `YouTube 视频搜索: ${keyword}`,
    workPage
  );

  async function youtubeSearchScrollOnce() {
    if (channelMap.size >= maxChannels) return;
    await workPage.evaluate(() => {
      const step = Math.floor((window.innerHeight || 800) * 2.2);
      window.scrollBy(0, step);
    });
    const scrollBatches = await collector.waitFor("search", {
      timeoutMs: ytTiming.apiWaitMs,
    });
    for (const b of scrollBatches) {
      if (b.kind !== "search") continue;
      const batch = extractSearchRenderersFromJson(b.json);
      if (batch.videos.length || batch.channels.length) {
        pushSearchJson(b.json);
      }
    }
    if (ytTiming.scrollPostWaitMs > 0) {
      await workPage.waitForTimeout(ytTiming.scrollPostWaitMs);
    }
  }

  const scrollSnapshot = () =>
    `${channelMap.size}|${videosFlat.length}|${apiBatchCount}|${continuationPages}`;

  const channelsAfterContinuation = channelMap.size;
  const skipScroll =
    channelsAfterContinuation >= ytTiming.skipScrollMinChannels ||
    channelsAfterContinuation >= maxChannels;

  // continuation 已够多时跳过慢速滚动（主要耗时来源）
  if (skipScroll) {
    console.log(
      `[extractYoutubeSearch] 跳过滚动（channels=${channelsAfterContinuation} >= ${ytTiming.skipScrollMinChannels}）`
    );
  } else if (
    scrollUntilStuck &&
    !(typeof options.scrollRounds === "number" && options.scrollRounds > 0)
  ) {
    const apiBatchesBeforeScroll = apiBatchCount;
    const channelsBeforeScroll = channelMap.size;
    const scrollResult = await runYoutubeSearchScrollUntilStuck(workPage, {
      scrollOnce: youtubeSearchScrollOnce,
      getSnapshot: scrollSnapshot,
      minRounds: ytTiming.minScrollRounds,
      maxRounds: ytTiming.fastScrollMaxRounds,
      stagnantLimit: 2,
    });
    scrollRoundsDone = scrollResult.roundsDone;

    if (
      channelMap.size > channelsBeforeScroll ||
      apiBatchCount > apiBatchesBeforeScroll
    ) {
      const lastJson = capturedJson[capturedJson.length - 1];
      const tailToken = lastJson
        ? extractSearchContinuationToken(lastJson)
        : null;
      await runContinuationPages("post-scroll", { startToken: tailToken });
    }
  } else if (!skipScroll) {
    for (let i = 0; i < scrollRounds && channelMap.size < maxChannels; i++) {
      await youtubeSearchScrollOnce();
      scrollRoundsDone = i + 1;
      if (channelMap.size >= maxChannels) break;
    }
    const lastJson = capturedJson[capturedJson.length - 1];
    const tailToken = lastJson ? extractSearchContinuationToken(lastJson) : null;
    if (tailToken) await runContinuationPages("post-scroll", { startToken: tailToken });
  }

  // api_only 无数据时的最后回退
  if (
    extractMode === "api_only" &&
    channelMap.size === 0 &&
    channelMap.size < maxChannels
  ) {
    try {
      const ytInitialData = await readYtInitialDataFromPage(workPage);
      if (ytInitialData) {
        const batch = extractSearchRenderersFromJson(ytInitialData);
        console.log(
          `[extractYoutubeSearch] ytInitialData 回退: ${batch.videos.length} videos`
        );
        if (batch.videos.length || batch.channels.length) {
          pushSearchJson(ytInitialData, { fromInitial: true });
        }
      }
    } catch (e) {
      console.warn(`[extractYoutubeSearch] ytInitialData 回退失败: ${e.message}`);
    }
    await runContinuationPages("fallback");
  }

  collector.detach();

  const influencerRecords = Array.from(channelMap.values()).slice(0, maxChannels);
  const success = influencerRecords.length > 0;

  if (success) {
    await reportYtScreenshot(
      onStepUpdate,
      BROWSER_STEP_IDS.SEARCH_VIDEOS,
      `YouTube 搜索完成（${influencerRecords.length} 频道）`,
      workPage
    );
  }

  const source =
    apiBatchCount > 0 && !initialDataUsed
      ? "innertube_search_api"
      : apiBatchCount > 0 && initialDataUsed
        ? "innertube_search_api+ytInitialData"
        : initialDataUsed
          ? "ytInitialData"
          : "none";

  console.log(
    `[extractYoutubeSearch] 完成 channels=${influencerRecords.length} videos=${videosFlat.length} ` +
      `apiBatches=${apiBatchCount} continuationPages=${continuationPages} scrollRounds=${scrollRoundsDone} source=${source}`
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success
      ? `YouTube 搜索: ${influencerRecords.length} 频道 (${source})`
      : "未拦截到搜索数据，请确认 9222 Chrome 已登录 YouTube",
    {
      channels: influencerRecords.length,
      videos: videosFlat.length,
      apiBatches: apiBatchCount,
      continuationPages,
      scrollRounds: scrollRoundsDone,
      source,
    }
  );

  return {
    success,
    workPage,
    influencerRecords,
    videos: videosFlat,
    stats: {
      influencerCount: influencerRecords.length,
      videoCount: videosFlat.length,
      capturedBatches: captured.length,
      apiBatches: apiBatchCount,
      continuationPages,
      scrollRounds: scrollRoundsDone,
      extractionSource: source,
      extractMode,
    },
    searchUrl,
    error: success ? null : "no_youtube_search_results",
  };
}
