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
  return Math.min(Math.max(base, 2), 60);
}

function ingestSearchBatch(posts, postsByUser, postsFlat, maxInfluencers) {
  let newUsers = 0;
  let newPosts = 0;
  for (const raw of posts) {
    const mapped = mapIgMediaToSearchPost(raw);
    if (!mapped.username || !mapped.postCode) continue;
    postsFlat.push(mapped);
    newPosts += 1;
    const u = mapped.username.replace(/^@/, "");
    if (!postsByUser.has(u)) {
      if (postsByUser.size >= maxInfluencers) continue;
      newUsers += 1;
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
      views: mapped.views,
      description: mapped.description,
      thumbnail: mapped.thumbnail,
    });
  }
  return { newUsers, newPosts };
}

function resolveIgLiteSearchMaxInfluencers(options = {}) {
  const requested = Number(
    options.maxInfluencers ??
      process.env.IG_SEARCH_MAX_INFLUENCERS ??
      process.env.SEARCH_MAX_POOL_SIZE ??
      500
  );
  const hardMax = Number(process.env.IG_LITE_SEARCH_HARD_MAX_INFLUENCERS ?? 500);
  return Math.min(
    Math.max(Number.isFinite(requested) && requested > 0 ? requested : 500, 1),
    Math.max(Number.isFinite(hardMax) && hardMax > 0 ? hardMax : 500, 1),
    2000
  );
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} keyword
 * @param {{ onStepUpdate?: Function, maxInfluencers?: number }} [options]
 */
export async function extractInstagramSearchLite(context, keyword, options = {}) {
  const { onStepUpdate = null } = options;
  const maxInfluencers = resolveIgLiteSearchMaxInfluencers(options);
  const maxZeroNewPages = Math.min(
    Math.max(Number(process.env.IG_LITE_SEARCH_ZERO_NEW_STOP_PAGES || 3), 1),
    10
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
  let zeroNewPages = 0;
  const pageStats = [];

  try {
    await fetchKeywordSearchAll(page, keyword, {
      maxPages: resolveIgLiteSearchMaxPages(
        maxInfluencers,
        options.scrollUntilStuck
      ),
      onBatch: (json, meta) => {
        const posts = extractMediaNodesFromJson(json);
        const { newUsers, newPosts } = ingestSearchBatch(
          posts,
          postsByUser,
          postsFlat,
          maxInfluencers
        );
        if (posts.length) apiBatchCount += 1;
        zeroNewPages = newUsers > 0 ? 0 : zeroNewPages + 1;
        pageStats.push({
          page: meta.pageNumber,
          durationMs: meta.durationMs,
          rawPosts: posts.length,
          newPosts,
          newUsers,
          totalUsers: postsByUser.size,
          totalPosts: postsFlat.length,
          hasMore: meta.hasMore,
        });
        if (process.env.IG_LITE_DEBUG_SEARCH === "1") {
          console.log(
            `[extractInstagramSearchLite] page=${meta.pageNumber} rawPosts=${posts.length} newUsers=${newUsers} totalUsers=${postsByUser.size}`
          );
        }
        return (
          postsByUser.size < maxInfluencers &&
          zeroNewPages < maxZeroNewPages
        );
      },
    });

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
      comments: p.comments,
      views: p.views,
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
      `[extractInstagramSearchLite] 完成 influencers=${influencerRecords.length} posts=${videos.length} apiBatches=${apiBatchCount} zeroNewPages=${zeroNewPages}`
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
        zeroNewPages,
        pageStats,
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
