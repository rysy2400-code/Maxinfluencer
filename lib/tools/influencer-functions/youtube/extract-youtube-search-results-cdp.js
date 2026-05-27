/**
 * YouTube 关键词搜索（视频 Tab）
 * 默认纯 innertube API（/youtubei/v1/search）；YT_EXTRACT_MODE=api_first 时可回退 ytInitialData
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
import {
  attachInnertubeCollector,
  readYtInitialDataFromPage,
  resolveYtExtractMode,
} from "./cdp-innertube-collector.js";

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

function ingestSearchBatches(captured, channelMap, videosFlat, maxChannels) {
  let apiVideos = 0;
  for (const batch of captured) {
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
      if (clip) {
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
  const maxChannels = Math.min(
    Math.max(
      Number(options.maxChannels || process.env.YT_SEARCH_MAX_CHANNELS || 20),
      1
    ),
    40
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
  let apiBatchCount = 0;
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
    workPage = afterGoto;
    collector = attachInnertubeCollector(workPage);
  }
  await workPage.waitForTimeout(2000);

  // goto 阶段偶发 search API；先 drain
  let batches = collector.drain();
  for (const b of batches) {
    if (b.kind === "search") {
      const batch = extractSearchRenderersFromJson(b.json);
      if (batch.videos.length || batch.channels.length) {
        captured.push(batch);
        apiBatchCount += 1;
      }
    }
  }

  await reportYtScreenshot(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    `YouTube 视频搜索: ${keyword}`,
    workPage
  );

  const channelMap = new Map();
  const videosFlat = [];

  const syncIngest = () =>
    ingestSearchBatches(captured, channelMap, videosFlat, maxChannels);

  syncIngest();

  // API：滚动触发 /youtubei/v1/search（首屏常无 search XHR，需滚动）
  for (let i = 0; i < scrollRounds && channelMap.size < maxChannels; i++) {
    await workPage.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    const scrollBatches = await collector.waitFor("search", {
      timeoutMs: Number(process.env.YT_API_WAIT_MS || 12000),
    });
    for (const b of scrollBatches) {
      if (b.kind !== "search") continue;
      const batch = extractSearchRenderersFromJson(b.json);
      if (batch.videos.length || batch.channels.length) {
        captured.push(batch);
        apiBatchCount += 1;
        console.log(
          `[extractYoutubeSearch] API /search batch: ${batch.videos.length} videos`
        );
      }
    }
    syncIngest();
    if (channelMap.size >= maxChannels) break;
    await workPage.waitForTimeout(800);
  }

  // 回退 ytInitialData（api_first / initial_only）
  const needFallback =
    extractMode !== "api_only" &&
    (channelMap.size === 0 || extractMode === "initial_only");
  if (needFallback && channelMap.size < maxChannels) {
    try {
      const ytInitialData = await readYtInitialDataFromPage(workPage);
      if (ytInitialData) {
        const batch = extractSearchRenderersFromJson(ytInitialData);
        console.log(
          `[extractYoutubeSearch] ytInitialData 回退: ${batch.videos.length} videos`
        );
        if (batch.videos.length || batch.channels.length) {
          captured.push(batch);
          initialDataUsed = true;
          syncIngest();
        }
      }
    } catch (e) {
      console.warn(`[extractYoutubeSearch] ytInitialData 回退失败: ${e.message}`);
    }
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
    `[extractYoutubeSearch] 完成 channels=${influencerRecords.length} apiBatches=${apiBatchCount} source=${source}`
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
      source,
    }
  );

  return {
    success,
    influencerRecords,
    videos: videosFlat,
    stats: {
      influencerCount: influencerRecords.length,
      videoCount: videosFlat.length,
      capturedBatches: captured.length,
      apiBatches: apiBatchCount,
      extractionSource: source,
      extractMode,
    },
    searchUrl,
    error: success ? null : "no_youtube_search_results",
  };
}
