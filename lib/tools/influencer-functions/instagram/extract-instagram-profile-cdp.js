/**
 * Instagram 红人 Reels 页：CDP 拦截 GraphQL，近 50 条 Reels + 播放/互动统计
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractMediaNodesFromJson,
  extractUserNodesFromJson,
  mapIgUserToUserInfo,
  computeIgVideoStatistics,
  mergeIgReelIntoMap,
  extractReelsPaginationHints,
  sortIgVideosByPkDesc,
} from "./instagram-json-utils.js";
import { reportIgScreenshot } from "./ig-cdp-screenshot.js";
import { guardedGoto } from "../../../cdp/cdp-tab-utils.js";

const DEFAULT_MAX_REELS = 50;
const DEFAULT_SCROLL_ROUNDS = 15;
const DEFAULT_MAX_STALE_ROUNDS = 3;

function reportStep(onStepUpdate, stepId, status, detail = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, null) });
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

function resolveMaxReels() {
  return Math.min(
    Math.max(
      Number(process.env.IG_REELS_MAX_VIDEOS || DEFAULT_MAX_REELS) || DEFAULT_MAX_REELS,
      1
    ),
    80
  );
}

function resolveScrollRounds() {
  return Math.min(
    Math.max(
      Number(process.env.IG_REELS_SCROLL_ROUNDS || DEFAULT_SCROLL_ROUNDS) ||
        DEFAULT_SCROLL_ROUNDS,
      3
    ),
    40
  );
}

function resolveMaxStaleRounds() {
  return Math.min(
    Math.max(
      Number(process.env.IG_REELS_MAX_STALE_ROUNDS || DEFAULT_MAX_STALE_ROUNDS) ||
        DEFAULT_MAX_STALE_ROUNDS,
      1
    ),
    8
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {{ onStepUpdate?: Function, humanLikeBehavior?: boolean }} [options]
 */
export async function extractInstagramProfileFromPageCDP(
  page,
  username,
  options = {}
) {
  const { onStepUpdate = null, humanLikeBehavior = true } = options;
  const handle = String(username || "").replace(/^@/, "");
  const maxReels = resolveMaxReels();
  const scrollRounds = resolveScrollRounds();
  const maxStaleRounds = resolveMaxStaleRounds();

  if (!handle) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  const intercepted = { users: [], medias: [] };
  const videoMap = new Map();
  let lastPagination = { moreAvailable: null, maxId: null };

  const responseHandler = async (response) => {
    const url = response.url();
    if (!isInstagramApiUrl(url)) return;
    try {
      const text = await response.text();
      if (!text || (text[0] !== "{" && text[0] !== "[")) return;
      const json = JSON.parse(text);
      const user = extractUserNodesFromJson(json, handle);
      if (user) intercepted.users.push(user);
      const pageInfo = extractReelsPaginationHints(json);
      if (pageInfo.moreAvailable != null || pageInfo.maxId != null) {
        lastPagination = pageInfo;
      }
      const medias = extractMediaNodesFromJson(json);
      for (const m of medias) {
        intercepted.medias.push(m);
        mergeIgReelIntoMap(videoMap, m, handle);
      }
    } catch {
      /* ignore */
    }
  };

  page.on("response", responseHandler);

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `正在提取 @${handle} 的 Reels（目标 ${maxReels} 条，最多滚 ${scrollRounds} 轮）`
  );

  const profileUrl = `https://www.instagram.com/${handle}/`;
  const reelsUrl = `https://www.instagram.com/${handle}/reels/`;

  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }

  try {
    page = await guardedGoto(page, profileUrl, {
      label: "ig_profile_home",
      budgetMs: 30_000,
      waitUntil: "domcontentloaded",
      retries: 1,
      createRetryPage: async () => page.context().newPage(),
    });
    await page.waitForTimeout(humanLikeBehavior ? 2500 : 2000);
  } catch (e) {
    console.warn(`[extractInstagramProfile] profile goto: ${e.message}`);
  }

  console.log(`[extractInstagramProfile] goto Reels ${reelsUrl}`);
  try {
    page = await guardedGoto(page, reelsUrl, {
      label: "ig_profile_reels",
      budgetMs: 30_000,
      waitUntil: "domcontentloaded",
      retries: 1,
      createRetryPage: async () => page.context().newPage(),
    });
  } catch (e) {
    console.warn(`[extractInstagramProfile] reels goto: ${e.message}`);
  }

  const initialWait = humanLikeBehavior ? 2500 + Math.floor(Math.random() * 1500) : 3000;
  await page.waitForTimeout(initialWait);
  await reportIgScreenshot(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    `Instagram Reels @${handle}`,
    page
  );

  let staleRounds = 0;
  let round = 0;
  while (round < scrollRounds && videoMap.size < maxReels) {
    const sizeBefore = videoMap.size;
    if (humanLikeBehavior) {
      await page.evaluate(() => {
        window.scrollTo({
          top: document.body.scrollHeight,
          behavior: "smooth",
        });
      });
    } else {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    }
    await page.waitForTimeout(
      humanLikeBehavior ? 1400 + Math.floor(Math.random() * 900) : 1600
    );
    round += 1;

    if (videoMap.size === sizeBefore) {
      staleRounds += 1;
    } else {
      staleRounds = 0;
    }

    if (staleRounds >= maxStaleRounds) {
      console.log(
        `[extractInstagramProfile] @${handle} 连续 ${maxStaleRounds} 轮无新 Reels，停止滚动（已有 ${videoMap.size} 条）`
      );
      break;
    }

    if (lastPagination.moreAvailable === false && videoMap.size >= sizeBefore) {
      console.log(
        `[extractInstagramProfile] @${handle} API 指示无更多页 more_available=false`
      );
      break;
    }
  }

  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    /* ok */
  }
  await page.waitForTimeout(2000);
  page.off("response", responseHandler);

  const rawUser = intercepted.users[intercepted.users.length - 1] || null;
  let userInfo = mapIgUserToUserInfo(rawUser);
  if (userInfo) {
    userInfo.profileUrl = profileUrl;
  } else {
    userInfo = {
      username: handle,
      displayName: handle,
      avatarUrl: "",
      bio: "",
      email: null,
      userId: null,
      verified: false,
      followers: { count: 0, display: "0" },
      following: { count: 0, display: "0" },
      postsCount: { count: 0, display: "0" },
      profileUrl,
    };
  }

  const videos = sortIgVideosByPkDesc(Array.from(videoMap.values())).slice(
    0,
    maxReels
  );
  const statistics = computeIgVideoStatistics(videos);
  const success = videos.length > 0 || !!rawUser;

  const zeroPlayAtHead = videos
    .slice(0, 10)
    .filter((v) => !(v.views?.count > 0)).length;

  console.log(
    `[extractInstagramProfile] @${handle} reels=${videos.length} scrollRounds=${round} ` +
      `avgViews=${statistics.avgViews ?? "n/a"}(仅含播放量>0) ` +
      `withPlayCount=${statistics.videosWithPlayCount}/${videos.length} ` +
      `zeroPlayInTop10=${zeroPlayAtHead} more_available=${lastPagination.moreAvailable}`
  );

  await reportIgScreenshot(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    `Reels 提取完成 @${handle}（${videos.length} 条）`,
    page
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success
      ? `@${handle} Reels ${videos.length} 条，均播 ${statistics.avgViews ?? "—"}`
      : `未获取到 @${handle} 的 Reels 数据`
  );

  return {
    success,
    error: success ? null : "instagram_reels_not_found",
    userInfo,
    videos,
    statistics,
    profileUrl,
    reelsUrl,
    extractionSource: "instagram_reels",
    interceptedCounts: {
      users: intercepted.users.length,
      medias: intercepted.medias.length,
      reelsKept: videos.length,
      scrollRoundsUsed: round,
    },
    pagination: lastPagination,
  };
}
