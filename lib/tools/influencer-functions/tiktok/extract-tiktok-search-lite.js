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
import { fetchWithPoolRetry } from "./tiktok-proxy-pool.js";

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

  // 获取 9222 会话失败（常见：base 组选中坏节点导致 tiktok 页加载失败）时，
  // 切换 base 组节点后重试获取，最多 6 次（池子大小兜底）。
  const { switchProxyGroupNode } = await import("./tiktok-proxy-pool.js");
  let session = null;
  for (let acquireAttempt = 0; acquireAttempt < 6; acquireAttempt += 1) {
    try {
      session = await acquireTiktokApiSession(context, {
        endpointKey: resolveTiktokLiteSearchEndpoint(),
      });
      break;
    } catch (e) {
      if (acquireAttempt >= 5) throw e;
      console.warn(
        `[tt-search] acquire 9222 failed (${e.message}); switch base node and retry ${acquireAttempt + 1}/5`
      );
      await switchProxyGroupNode().catch(() => null);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const { page } = session;

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    STEP_STATUS.RUNNING,
    `TikTok Lite 搜索: ${keyword}`
  );

  try {
    // 综合搜索（general/full）：无登录可用，不受账号 2484 视频搜索每日配额限制。
    const batches = await fetchWithPoolRetry({
      fn: async () => {
        const b = await fetchSearchGeneralFullAll(page, keyword, {
          maxPages: Math.min(
            Math.max(Number(process.env.TT_LITE_SEARCH_MAX_PAGES || 80), 2),
            80
          ),
        });
        const videos = b.reduce(
          (sum, j) =>
            sum + (Array.isArray(j?.data) ? j.data.filter((e) => e?.type === 1).length : 0),
          0
        );
        if (videos === 0) throw new Error(`general search empty keyword=${keyword}`);
        return b;
      },
      page,
      label: `search:${keyword}`,
      maxNodeSwitches: 8,
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
