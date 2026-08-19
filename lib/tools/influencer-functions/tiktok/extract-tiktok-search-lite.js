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

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    STEP_STATUS.RUNNING,
    `TikTok Lite 搜索: ${keyword}`
  );

  // 搜索执行一次（强制新 tab）：轮换后旧 tab 网络栈可能已断（Failed to fetch），
  // 新 tab 保证干净页面；失败由外层重试一次。
  const maxPages = Math.min(
    Math.max(Number(process.env.TT_LITE_SEARCH_MAX_PAGES || 80), 2),
    80
  );
  let session = null;
  let page = null;
  let batches = [];
  let allVideos = [];
  const searchOnce = async () => {
    const s2 = await acquireTiktokApiSession(context, {
      endpointKey: resolveTiktokLiteSearchEndpoint(),
      forceNewTab: true,
    });
    session = s2;
    page = s2.page;
    // 综合搜索（general/full）：无登录可用，不受账号 2484 视频搜索每日配额限制。
    const b2 = await fetchSearchGeneralFullAll(page, keyword, { maxPages });
    const v2 = [];
    for (const json of b2) {
      v2.push(...extractVideosFromGeneralSearchAPI(json));
    }
    return { batches: b2, allVideos: v2 };
  };
  try {
    const r = await searchOnce();
    batches = r.batches;
    allVideos = r.allVideos;
  } catch (e) {
    console.warn(`[extractTiktokSearchLite] 首次搜索失败，换新 tab 重试: ${e.message}`);
    try { await session?.dispose?.(); } catch { /* ignore */ }
    await new Promise((r2) => setTimeout(r2, 3000));
    try {
      const r = await searchOnce();
      batches = r.batches;
      allVideos = r.allVideos;
    } catch (e2) {
      console.warn(`[extractTiktokSearchLite] 重试搜索仍失败: ${e2.message}`);
      throw e2;
    }
  }

  try {
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
