/**
 * Instagram 关键词搜索页：explore/search/keyword + GraphQL/API 拦截
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

function buildKeywordSearchUrl(keyword) {
  const q = String(keyword || "").trim();
  return `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`;
}

function reportStep(onStepUpdate, stepId, status, detail = null, stats = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, stats) });
  } catch {
    /* ignore */
  }
}

function isInstagramApiUrl(url) {
  return (
    url.includes("instagram.com") &&
    (url.includes("/graphql") ||
      url.includes("/api/") ||
      url.includes("i.instagram.com"))
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {string} keyword
 * @param {{ onStepUpdate?: Function, maxInfluencers?: number, scrollRounds?: number }} [options]
 */
export async function extractInstagramSearchResultsFromPageCDP(
  page,
  keyword,
  options = {}
) {
  const { onStepUpdate = null } = options;
  const maxInfluencers = Math.min(
    Math.max(Number(options.maxInfluencers || 40), 1),
    80
  );
  const scrollRounds = Math.min(
    Math.max(Number(options.scrollRounds || process.env.IG_SEARCH_SCROLL_ROUNDS || 8), 2),
    20
  );

  const captured = [];
  const handler = async (response) => {
    const url = response.url();
    if (!isInstagramApiUrl(url)) return;
    try {
      const text = await response.text();
      if (!text || (text[0] !== "{" && text[0] !== "[")) return;
      const json = JSON.parse(text);
      const posts = extractMediaNodesFromJson(json);
      if (posts.length) {
        captured.push({ posts });
      }
    } catch {
      /* ignore */
    }
  };

  const searchUrl = buildKeywordSearchUrl(keyword);
  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    STEP_STATUS.RUNNING,
    `Instagram 关键词搜索: ${keyword}`
  );

  page.on("response", handler);

  console.log(`[extractInstagramSearch] goto ${searchUrl}`);
  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  try {
    await page.goto(searchUrl, { waitUntil: "commit", timeout: 90000 });
    console.log(`[extractInstagramSearch] 当前 URL: ${page.url()}`);
  } catch (e) {
    console.warn(`[extractInstagramSearch] goto 警告: ${e.message}`);
  }
  await page.waitForTimeout(3000);

  for (let i = 0; i < scrollRounds; i++) {
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollBy(0, 600));
  }
  await page.waitForTimeout(3000);
  page.off("response", handler);

  const postsByUser = new Map();
  const postsFlat = [];

  for (const batch of captured) {
    for (const raw of batch.posts) {
      const mapped = mapIgMediaToSearchPost(raw);
      if (!mapped.username || !mapped.postCode) continue;
      postsFlat.push(mapped);
      const u = mapped.username.replace(/^@/, "");
      if (!postsByUser.has(u)) {
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
      if (postsByUser.size >= maxInfluencers) break;
    }
    if (postsByUser.size >= maxInfluencers) break;
  }

  const influencerRecords = Array.from(postsByUser.values()).slice(
    0,
    maxInfluencers
  );

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

  const success = influencerRecords.length > 0;

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.SEARCH_VIDEOS,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success
      ? `Instagram 搜索完成: ${influencerRecords.length} 红人, ${videos.length} 帖子`
      : "未拦截到帖子数据，请确认 9222 Chrome 已登录 Instagram",
    { influencers: influencerRecords.length, videos: videos.length }
  );

  return {
    success,
    influencerRecords,
    videos,
    stats: {
      influencerCount: influencerRecords.length,
      videoCount: videos.length,
      capturedBatches: captured.length,
    },
    searchUrl,
    error: success ? null : "no_instagram_search_results",
  };
}
