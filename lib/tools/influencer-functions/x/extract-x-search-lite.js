/**
 * X Lite 搜索：浏览器打开真实搜索页 + 拦截 SearchTimeline 网络响应。
 * 背景：X 边缘 WAF 会拒绝 Node 自组 txid 的 GraphQL 直调（403 HTML），而页面自身发起的
 * SearchTimeline 请求天然带正确签名/cookie。红人 = 搜索推文作者 + People 独立用户。
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractSearchUsersFromJson,
  extractTimelineBottomCursor,
  mapXTweetToSearchClip,
} from "./x-json-utils.js";
import { acquireXSession } from "./x-session.js";
import { resolveXLiteSearchMaxPages } from "../../../scraper/resolve-scraper-mode.js";
import { attachXGraphqlCollector, waitForUiElements } from "./x-browser-io.js";

function reportStep(onStepUpdate, stepId, status, detail = null, stats = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, stats) });
  } catch {
    /* ignore */
  }
}

function ingestSearchBatch(json, userMap, videosFlat, maxInfluencers) {
  const { users, tweets } = extractSearchUsersFromJson(json);
  const userKey = (u) => String(u.userId || u.username).toLowerCase();
  for (const u of users) {
    const key = userKey(u);
    if (!userMap.has(key)) {
      if (userMap.size >= maxInfluencers) continue;
      userMap.set(key, {
        ...u,
        platform: "X",
        search_video_data: [],
      });
    }
  }
  // 推文作者已并入 userMap；这里把推文本身记录为 search_video_data（挂在作者上）
  for (const t of tweets) {
    if (!t.author) continue;
    const rec = userMap.get(userKey(t.author));
    if (!rec) continue;
    const clip = mapXTweetToSearchClip(t, t.author);
    if (clip && !rec.search_video_data.some((v) => v.videoId === clip.videoId)) {
      rec.search_video_data.push(clip);
      videosFlat.push(clip);
    }
  }
  return tweets.length > 0 || users.length > 0;
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} keyword
 * @param {{ onStepUpdate?: Function, maxInfluencers?: number }} [options]
 */
export async function extractXSearchLite(context, keyword, options = {}) {
  const { onStepUpdate = null } = options;
  const maxInfluencers = Math.min(
    Math.max(Number(options.maxInfluencers || process.env.X_SEARCH_MAX_INFLUENCERS || 80), 1),
    1000
  );
  const product = process.env.X_LITE_SEARCH_PRODUCT || "Latest";
  const maxPages = resolveXLiteSearchMaxPages();
  // X 搜索 Tab 映射：Top→top / Latest→live / People→user / Media→media / List→list
  const PRODUCT_TAB = {
    top: "top",
    latest: "live",
    live: "live",
    people: "user",
    user: "user",
    media: "media",
    list: "list",
  };
  const searchF = PRODUCT_TAB[String(product).toLowerCase()] || "live";

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    STEP_STATUS.RUNNING,
    `X Lite 搜索: ${keyword}`
  );

  const session = await acquireXSession(context, { onStepUpdate, logPrefix: "[x-search-lite]" });
  const { page } = session;
  const userMap = new Map();
  const videosFlat = [];
  let apiBatchCount = 0;
  let pages = 0;
  let collector = null;

  try {
    collector = attachXGraphqlCollector(page, ["SearchTimeline"]);

    const searchUrl = `https://x.com/search?q=${encodeURIComponent(keyword)}&f=${searchF}`;
    console.log(`[extractXSearchLite] 打开搜索页 ${searchUrl} product=${product}`);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => {
      console.warn(`[extractXSearchLite] 打开搜索页失败: ${e.message}（继续等待响应）`);
    });

    // 等待第一批 SearchTimeline 响应或 UI 结果栅格
    const firstBatches = await collector.waitFor("SearchTimeline", { timeoutMs: 30000 });
    if (firstBatches.length === 0) {
      await waitForUiElements(page, '[data-testid="cellInnerDiv"]', { timeoutMs: 15000 });
    }

    let emptyStreak = 0;
    while (pages < maxPages && userMap.size < maxInfluencers) {
      const drained = collector.drain();
      const currentBatches = drained.length ? drained : firstBatches;
      let sawNew = false;
      for (const batch of currentBatches) {
        const before = userMap.size;
        const hasContent = ingestSearchBatch(batch.json, userMap, videosFlat, maxInfluencers);
        if (hasContent) apiBatchCount += 1;
        if (userMap.size > before) sawNew = true;
        if (!extractTimelineBottomCursor(batch.json)) pages = maxPages; // 无 cursor：不再翻页
      }
      if (currentBatches.length > 0) {
        pages += 1;
      }
      if (currentBatches.length === 0) {
        emptyStreak += 1;
        if (emptyStreak >= 3) break; // 搜索页始终无 SearchTimeline 响应（限流/无结果），避免死循环
      } else {
        emptyStreak = 0;
      }
      if (userMap.size >= maxInfluencers) break;
      if (pages >= maxPages) break;

      // 滚动到底部触发下一次 SearchTimeline（X 搜索无限滚动）
      await page.mouse.wheel(0, 6000).catch(() => {});
      await page.waitForTimeout(2500);
      const more = await collector.waitFor("SearchTimeline", { timeoutMs: 10000 });
      if (!more.length) {
        // UI 兜底：点“加载更多”按钮（若有）
        const btn = page.locator('[data-testid="loadMoreButton"]').first();
        const visible = await btn.isVisible().catch(() => false);
        if (visible) await btn.click().catch(() => {});
        await page.waitForTimeout(2500);
      }
      if (!more.length && !sawNew && currentBatches.length > 0) break;
    }

    const influencerRecords = Array.from(userMap.values()).slice(0, maxInfluencers);
    const success = influencerRecords.length > 0;

    console.log(
      `[extractXSearchLite] 完成 users=${influencerRecords.length} clips=${videosFlat.length} ` +
        `apiBatches=${apiBatchCount} pages=${pages}`
    );

    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.SEARCH_VIDEOS,
      success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
      success ? `X Lite: ${influencerRecords.length} 红人` : "X Lite 搜索无结果",
      { channels: influencerRecords.length, apiBatches: apiBatchCount }
    );

    try {
      collector.detach();
    } catch {
      /* ignore */
    }

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
        continuationPages: pages,
        extractionSource: "x_search_page_intercept",
        extractMode: "lite",
        scrollRounds: pages,
      },
      searchUrl: `(x-search-page) ${searchUrl}`,
      error: success ? null : "no_x_search_results",
    };
  } catch (e) {
    try {
      collector?.detach();
    } catch {
      /* ignore */
    }
    try {
      await session.dispose();
    } catch {
      /* ignore */
    }
    throw e;
  }
}
