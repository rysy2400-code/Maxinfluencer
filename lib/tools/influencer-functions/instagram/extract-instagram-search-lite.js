/**
 * Instagram Lite 搜索：API 直调，不打开搜索页、不滚动、不截图
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractMediaNodesFromJson,
  mapIgMediaToSearchPost,
} from "./instagram-json-utils.js";
import {
  acquireInstagramApiSession,
  fetchKeywordSearchAll,
} from "./instagram-direct-fetch.js";
import { isLiteScreenshotsDisabled } from "../../../scraper/resolve-scraper-mode.js";
import { reportIgScreenshot } from "./ig-cdp-screenshot.js";

function reportStep(onStepUpdate, stepId, status, detail = null, stats = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, stats) });
  } catch {
    /* ignore */
  }
}

function resolveIgLiteSearchMaxPages(maxInfluencers, scrollUntilStuck = true) {
  const target = Math.max(Number(maxInfluencers) || 120, 40);
  const envPages = Number(process.env.IG_LITE_SEARCH_MAX_PAGES);
  const estimated = Math.ceil(target / 8);
  const base = envPages > 0 ? envPages : scrollUntilStuck !== false ? Math.max(12, estimated) : Math.max(6, estimated);
  return Math.min(Math.max(base, 2), 30);
}

function ingestSearchBatch(posts, postsByUser, postsFlat, maxInfluencers) {
  for (const raw of posts) {
    const mapped = mapIgMediaToSearchPost(raw);
    if (!mapped.username || !mapped.postCode) continue;
    postsFlat.push(mapped);
    const u = mapped.username.replace(/^@/, "");
    if (!postsByUser.has(u)) {
      if (postsByUser.size >= maxInfluencers) continue;
      postsByUser.set(u, {
        username: u,
        displayName: raw.user?.full_name || raw.owner?.full_name || u,
        profileUrl: `https://www.instagram.com/${u}/`,
        avatarUrl:
          raw.user?.profile_pic_url ||
          raw.owner?.profile_pic_url ||
          "",
        followers: { count: 0, display: "0" },
        bio: "",
        verified: !!(raw.user?.is_verified || raw.owner?.is_verified),
        platform: "Instagram",
        userId: raw.user?.pk || raw.owner?.pk || null,
        search_video_data: [],
      });
    }
    const rec = postsByUser.get(u);
    if (!rec) continue;
    rec.search_video_data.push({
      videoId: mapped.pk || mapped.postCode,
      videoUrl: mapped.postUrl,
      postCode: mapped.postCode,
      mediaType: mapped.mediaType,
      likes: mapped.likes,
      comments: mapped.comments,
      description: mapped.description,
      thumbnail: mapped.thumbnail,
    });
  }
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} keyword
 * @param {{ onStepUpdate?: Function, maxInfluencers?: number }} [options]
 */
export async function extractInstagramSearchLite(context, keyword, options = {}) {
  const { onStepUpdate = null } = options;
  const maxInfluencers = Math.min(
    Math.max(
      Number(options.maxInfluencers || process.env.IG_SEARCH_MAX_INFLUENCERS || 120),
      1
    ),
    2000
  );

  const session = await acquireInstagramApiSession(context);
  const { page } = session;

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    STEP_STATUS.RUNNING,
    `Instagram Lite 搜索: ${keyword}`
  );

  const postsByUser = new Map();
  const postsFlat = [];
  let apiBatchCount = 0;

  try {
    const batches = await fetchKeywordSearchAll(page, keyword, {
      maxPages: resolveIgLiteSearchMaxPages(
        maxInfluencers,
        options.scrollUntilStuck
      ),
    });

    for (const json of batches) {
      const posts = extractMediaNodesFromJson(json);
      if (!posts.length) continue;
      apiBatchCount += 1;
      ingestSearchBatch(posts, postsByUser, postsFlat, maxInfluencers);
    }

    const influencerRecords = Array.from(postsByUser.values()).slice(
      0,
      maxInfluencers
    );
    const success = influencerRecords.length > 0;

    const videos = postsFlat.map((p) => ({
      videoId: p.pk || p.postCode,
      videoUrl: p.postUrl,
      username: p.username,
      profileUrl: `https://www.instagram.com/${p.username}/`,
      likes: p.likes,
      description: p.description,
      mediaType: p.mediaType,
      platform: "Instagram",
    }));

    if (success && !isLiteScreenshotsDisabled()) {
      await reportIgScreenshot(
        onStepUpdate,
        BROWSER_STEP_IDS.SEARCH_VIDEOS,
        `Instagram Lite 搜索完成（${influencerRecords.length} 红人）`,
        page
      );
    }

    console.log(
      `[extractInstagramSearchLite] 完成 influencers=${influencerRecords.length} posts=${videos.length} apiBatches=${apiBatchCount}`
    );

    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.SEARCH_VIDEOS,
      success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
      success
        ? `Instagram Lite: ${influencerRecords.length} 红人, ${videos.length} 帖子`
        : "Lite 搜索无结果",
      { influencers: influencerRecords.length, apiBatches: apiBatchCount }
    );

    return {
      success,
      workPage: page,
      session,
      influencerRecords,
      videos,
      stats: {
        influencerCount: influencerRecords.length,
        videoCount: videos.length,
        apiBatches: apiBatchCount,
        extractionSource: "instagram_fbsearch_direct",
        extractMode: "lite",
        scrollRounds: 0,
      },
      searchUrl: `(lite-api) query=${keyword}`,
      error: success ? null : "no_instagram_search_results",
    };
  } catch (e) {
    await session.dispose();
    throw e;
  }
}
