/**
 * TikTok Lite 搜索：9222 登录态 bootstrap + API 翻页，避免滚动/截图
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractVideosFromSearchAPI,
  extractVideosFromGeneralSearchAPI,
  extractInfluencersFromVideos,
} from "../extract-search-results-cdp.js";
import {
  acquireTiktokApiSession,
  fetchSearchGeneralFullAll,
  // 旧视频搜索（search/item/full）：保留代码，后续可能复用
  // fetchSearchItemFullAll,
  resolveTiktokLiteSearchEndpoint,
} from "./tiktok-direct-fetch.js";
import { isLiteScreenshotsDisabled } from "../../../scraper/resolve-scraper-mode.js";

function reportStep(onStepUpdate, stepId, status, detail = null, stats = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, stats) });
  } catch {
    /* ignore */
  }
}

function dedupeVideos(videos) {
  const out = [];
  const seen = new Set();
  for (const v of videos) {
    const key = v.videoId || v.videoUrl;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} keyword
 * @param {{ onStepUpdate?: Function, maxInfluencers?: number }} [options]
 */
export async function extractTiktokSearchLite(context, keyword, options = {}) {
  const { onStepUpdate = null } = options;
  const maxInfluencers = Math.min(
    Math.max(Number(options.maxInfluencers || process.env.TT_SEARCH_MAX_INFLUENCERS || 500), 1),
    2000
  );

  // 每次任务搜索强制开新 tab：轮换后旧 tab 网络栈可能已断（Failed to fetch），
  // 新 tab 可保证干净的页面状态；多余 tab 由任务边界 cleanup 收敛。
  const session = await acquireTiktokApiSession(context, {
    endpointKey: resolveTiktokLiteSearchEndpoint(),
    forceNewTab: true,
  });
  const { page } = session;

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    STEP_STATUS.RUNNING,
    `TikTok Lite 搜索: ${keyword}`
  );

  try {
    // 综合搜索（general/full）：无登录可用，不受账号 2484 视频搜索每日配额限制。
    const batches = await fetchSearchGeneralFullAll(page, keyword, {
      maxPages: Math.min(
        Math.max(Number(process.env.TT_LITE_SEARCH_MAX_PAGES || 80), 2),
        80
      ),
    });

    const allVideos = [];
    for (const json of batches) {
      allVideos.push(...extractVideosFromGeneralSearchAPI(json));
    }
    // ============ 旧视频搜索（search/item/full）保留 ============
    // const batches = await fetchSearchItemFullAll(page, keyword, {
    //   maxPages: Math.min(
    //     Math.max(Number(process.env.TT_LITE_SEARCH_MAX_PAGES || 80), 2),
    //     80
    //   ),
    // });
    // const allVideos = [];
    // for (const json of batches) {
    //   allVideos.push(...extractVideosFromSearchAPI(json));
    // }
    // ============ /旧视频搜索 ============
    const uniqueVideos = dedupeVideos(allVideos);
    const influencerRecords = extractInfluencersFromVideos(uniqueVideos).slice(
      0,
      maxInfluencers
    );
    const success = influencerRecords.length > 0;

    console.log(
      `[extractTiktokSearchLite] 完成 influencers=${influencerRecords.length} videos=${uniqueVideos.length} apiBatches=${batches.length}`
    );

    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.SEARCH_VIDEOS,
      success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
      success
        ? `TikTok Lite: ${influencerRecords.length} 红人, ${uniqueVideos.length} 视频`
        : "Lite 搜索无结果",
      { influencers: influencerRecords.length, apiBatches: batches.length }
    );

    return {
      success,
      workPage: page,
      session,
      influencerRecords,
      videos: uniqueVideos,
      stats: {
        influencerCount: influencerRecords.length,
        videoCount: uniqueVideos.length,
        apiBatches: batches.length,
        extractionSource: "tiktok_search_general_full_direct",
        extractMode: "lite",
        scrollRounds: 0,
        screenshotsDisabled: isLiteScreenshotsDisabled(),
      },
      searchUrl: `(lite-api) q=${keyword}`,
      error: success ? null : "no_tiktok_search_results",
    };
  } catch (e) {
    await session.dispose();
    throw e;
  }
}
