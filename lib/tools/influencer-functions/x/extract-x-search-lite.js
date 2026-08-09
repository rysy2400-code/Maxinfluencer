/**
 * X Lite 搜索：SearchTimeline GraphQL 直调（登录态 + txid），不打开搜索页、不滚动、不截图。
 * 红人 = 搜索推文作者 + People 独立用户，按出现顺序去重。
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
import { fetchSearchTimelinePage } from "./x-graphql.js";
import { resolveXLiteSearchMaxPages } from "../../../scraper/resolve-scraper-mode.js";

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
  let cursor = null;
  let emptyStreak = 0;
  let pages = 0;

  try {
    while (pages < maxPages && userMap.size < maxInfluencers) {
      const json = await fetchSearchTimelinePage(session, keyword, { cursor, product, count: 40 });
      if (!json) {
        emptyStreak += 1;
        if (emptyStreak >= 3) break;
        continue;
      }
      const { tweets, users } = extractSearchUsersFromJson(json);
      const hasContent = tweets.length > 0 || users.length > 0;
      if (hasContent) {
        ingestSearchBatch(json, userMap, videosFlat, maxInfluencers);
        apiBatchCount += 1;
        emptyStreak = 0;
      } else {
        emptyStreak += 1;
        if (emptyStreak >= 3) break;
      }
      const next = extractTimelineBottomCursor(json);
      if (!next) break;
      cursor = next;
      pages += 1;
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
        extractionSource: "x_graphql_search_direct",
        extractMode: "lite",
        scrollRounds: 0,
      },
      searchUrl: `(x-graphql) query=${keyword}`,
      error: success ? null : "no_x_search_results",
    };
  } catch (e) {
    try {
      await session.dispose();
    } catch {
      /* ignore */
    }
    throw e;
  }
}
