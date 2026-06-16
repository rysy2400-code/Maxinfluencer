/**
 * YouTube Lite 频道 enrich：国家 innertube 预筛 → 符合 campaign 再拉视频列表
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractVideosFromInnertubeJson,
  extractChannelHeaderFromInnertubeJson,
  computeYtVideoStatistics,
  mergeYtVideoIntoMap,
  sortYtVideosByRecency,
  buildChannelPublicUrl,
  extractSubscriberFromAboutViewModel,
  extractSubscriberCountFromInnertubeJson,
} from "./youtube-json-utils.js";
import { extractEmailFromBio } from "../../../influencer/extract-email-from-bio.js";
import { normalizeInfluencerCountryToIso } from "../../../influencer/campaign-country-codes.js";
import {
  fetchChannelVideosFirstPage,
  fetchChannelAbout,
  fetchBrowseContinuation,
  paginateViaContinuation,
  resolveBrowseTarget,
} from "./innertube-direct-fetch.js";
import { isLiteEnrichScreenshotsEnabled } from "../../../scraper/resolve-scraper-mode.js";
import { reportYtScreenshot } from "./yt-cdp-screenshot.js";
import { readYtInitialDataFromPage } from "./cdp-innertube-collector.js";
import { inferIgCountryFromBio } from "../instagram/instagram-json-utils.js";
import { enrichYoutubeVideosEngagement } from "./yt-video-engagement-enrich.js";

function reportStep(onStepUpdate, stepId, status, detail = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, null) });
  } catch {
    /* ignore */
  }
}

function mergeUserInfo(base, patch) {
  if (!patch) return base;
  const out = { ...(base || {}), ...patch };
  if (patch.followers?.count > 0) out.followers = patch.followers;
  if (patch.bio && !base?.bio) out.bio = patch.bio;
  if (patch.country && !base?.country) out.country = patch.country;
  if (patch.email && !base?.email) out.email = patch.email;
  if (patch.avatarUrl && !base?.avatarUrl) out.avatarUrl = patch.avatarUrl;
  return out;
}

function textFromRuns(runs) {
  if (!runs) return "";
  if (typeof runs === "string") return runs;
  if (runs.simpleText) return runs.simpleText;
  if (Array.isArray(runs)) return runs.map((r) => r.text || "").join("");
  if (runs.runs) return textFromRuns(runs.runs);
  return "";
}

function extractCountryFromAboutMeta(aboutMeta) {
  if (!aboutMeta) return null;
  const candidates = [
    typeof aboutMeta.country === "string" ? aboutMeta.country : null,
    aboutMeta?.country?.simpleText,
    textFromRuns(aboutMeta?.country?.runs || aboutMeta?.country),
    aboutMeta?.location?.country,
    aboutMeta?.businessAddress?.country,
    aboutMeta?.countryCode,
  ];
  for (const c of candidates) {
    const text = typeof c === "string" ? c : textFromRuns(c?.runs || c);
    const trimmed = String(text || "").trim();
    if (!trimmed) continue;
    const iso = normalizeInfluencerCountryToIso(trimmed);
    if (iso) return { raw: trimmed, iso };
  }
  return null;
}

function shouldAllowAboutFallback(options = {}) {
  if (options.allowAbout === false) return false;
  if (process.env.YT_SKIP_ABOUT_COUNTRY === "1") return false;
  if (process.env.YT_ALLOW_ABOUT_FALLBACK === "0") return false;
  return true;
}

async function resolveYoutubeAboutCountryFromPage(page, handle, channelId) {
  const profileUrl = buildChannelPublicUrl(handle, channelId);
  if (!profileUrl || typeof page.goto !== "function") return null;
  const aboutUrl = `${profileUrl.replace(/\/$/, "")}/about`;
  try {
    await page.goto(aboutUrl, { waitUntil: "commit", timeout: 45_000 });
    await page.waitForTimeout(1200);
    const data = await readYtInitialDataFromPage(page);
    if (!data) return null;
    const aboutMeta = walkAboutMeta(data);
    const hit = extractCountryFromAboutMeta(aboutMeta);
    if (hit) {
      return {
        countryRaw: hit.raw,
        videoPublishCountry: hit.iso,
        source: "about_page",
        userInfoPatch: parseAboutFromBrowseJson(data, handle),
      };
    }
    const hdr = extractChannelHeaderFromInnertubeJson(data, handle);
    if (hdr?.country) {
      const iso = normalizeInfluencerCountryToIso(hdr.country);
      if (iso) {
        return {
          countryRaw: hdr.country,
          videoPublishCountry: iso,
          source: "about_page_header",
          userInfoPatch: hdr,
        };
      }
    }
    const aboutPatch = parseAboutFromBrowseJson(data, handle);
    if (aboutPatch?.bio) {
      const bioHit = inferIgCountryFromBio(aboutPatch.bio);
      if (bioHit?.videoPublishCountry) {
        return {
          countryRaw: bioHit.countryRaw,
          videoPublishCountry: bioHit.videoPublishCountry,
          source: bioHit.source,
          userInfoPatch: aboutPatch,
        };
      }
    }
  } catch (e) {
    console.warn(
      `[resolveYoutubeLiteCountry] /about fallback skip @${handle}: ${e.message}`
    );
  }
  return null;
}

function walkAboutMeta(obj, d = 0) {
  if (d > 22 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const found = walkAboutMeta(x, d + 1);
      if (found) return found;
    }
    return null;
  }
  if (obj.channelAboutFullMetadataRenderer || obj.aboutChannelViewModel) {
    return obj.channelAboutFullMetadataRenderer || obj.aboutChannelViewModel;
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v) {
      const found = walkAboutMeta(v, d + 1);
      if (found) return found;
    }
  }
  return null;
}

function parseAboutFromBrowseJson(json, handle) {
  const aboutMeta = walkAboutMeta(json);
  if (!aboutMeta) return null;

  const countryHit = extractCountryFromAboutMeta(aboutMeta);
  const countryText = countryHit?.raw || null;
  const desc =
    (typeof aboutMeta.description === "string" ? aboutMeta.description : null) ||
    aboutMeta?.description?.simpleText ||
    (aboutMeta?.description?.runs || []).map((r) => r.text || "").join("") ||
    "";
  const emailFromAbout = extractEmailFromBio(desc) || null;
  const subs = extractSubscriberFromAboutViewModel(aboutMeta);

  return {
    country: countryText ? String(countryText).trim() : null,
    bio: desc || "",
    email: emailFromAbout,
    followers: subs?.count > 0 ? subs : null,
  };
}

function resolveMaxVideos() {
  return Math.min(
    Math.max(Number(process.env.YT_CHANNEL_MAX_VIDEOS || 50) || 50, 1),
    80
  );
}

function buildTarget(handle, channelIdOpt) {
  return {
    browseId: channelIdOpt?.startsWith("UC") ? channelIdOpt : null,
    handle: handle || null,
  };
}

/**
 * 轻量国家解析：innertube /about API（不打开 /about 页面）
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {{ channelId?: string }} [options]
 */
export async function resolveYoutubeLiteCountry(page, username, options = {}) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const channelIdOpt = options.channelId || null;
  const target = buildTarget(handle, channelIdOpt);

  let browseId = target.browseId;
  if (!browseId && handle) {
    browseId = await resolveBrowseTarget(page, target);
  }

  let userInfo = null;
  let countryRaw = null;
  let videoPublishCountry = null;
  let countrySource = null;

  const aboutJson = await fetchChannelAbout(page, {
    browseId,
    handle: handle || null,
  });
  if (aboutJson) {
    const aboutPatch = parseAboutFromBrowseJson(aboutJson, handle);
    const hdr = extractChannelHeaderFromInnertubeJson(aboutJson, handle);
    userInfo = mergeUserInfo(hdr, aboutPatch);
    const countryCandidate = aboutPatch?.country || hdr?.country || null;
    if (countryCandidate) {
      countryRaw = countryCandidate;
      videoPublishCountry = normalizeInfluencerCountryToIso(countryRaw);
      countrySource = aboutPatch?.country ? "innertube_about_api" : "browse_header";
    }
    if (!browseId && userInfo?.channelId) browseId = userInfo.channelId;
  }

  if (!videoPublishCountry && userInfo?.bio) {
    const bioHit = inferIgCountryFromBio(userInfo.bio);
    if (bioHit?.videoPublishCountry) {
      countryRaw = bioHit.countryRaw;
      videoPublishCountry = bioHit.videoPublishCountry;
      countrySource = bioHit.source;
    }
  }

  if (!videoPublishCountry && browseId) {
    const firstVideos = await fetchChannelVideosFirstPage(page, {
      browseId,
      handle: handle || null,
    });
    if (firstVideos) {
      const hdr = extractChannelHeaderFromInnertubeJson(firstVideos, handle);
      userInfo = mergeUserInfo(userInfo, hdr);
      const hdrCountry = hdr?.country ? normalizeInfluencerCountryToIso(hdr.country) : null;
      if (hdrCountry) {
        countryRaw = hdr.country;
        videoPublishCountry = hdrCountry;
        countrySource = "browse_header";
      }
    }
  }

  if (!videoPublishCountry && shouldAllowAboutFallback(options)) {
    const aboutHit = await resolveYoutubeAboutCountryFromPage(
      page,
      handle,
      browseId || userInfo?.channelId || channelIdOpt
    );
    if (aboutHit?.videoPublishCountry) {
      countryRaw = aboutHit.countryRaw;
      videoPublishCountry = aboutHit.videoPublishCountry;
      countrySource = aboutHit.source;
      userInfo = mergeUserInfo(userInfo, aboutHit.userInfoPatch);
    }
  }

  if (videoPublishCountry) {
    console.log(
      `[resolveYoutubeLiteCountry] @${handle || browseId} country=${videoPublishCountry} source=${countrySource}`
    );
  } else {
    console.log(`[resolveYoutubeLiteCountry] @${handle || browseId} country=(空)`);
  }

  return {
    success: !!videoPublishCountry,
    videoPublishCountry,
    countryRaw,
    countrySource,
    browseId,
    userInfo,
    handle,
    channelId: browseId || userInfo?.channelId || channelIdOpt || null,
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {{ onStepUpdate?: Function, channelId?: string, knownCountry?: object, countryOnly?: boolean }} [options]
 */
export async function extractYoutubeChannelLite(page, username, options = {}) {
  const { onStepUpdate = null } = options;
  const handle = String(username || "").replace(/^@/, "").trim();
  const channelIdOpt = options.channelId || null;
  const maxVideos = resolveMaxVideos();

  if (!handle && !channelIdOpt) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  if (options.countryOnly) {
    const countryCtx = await resolveYoutubeLiteCountry(page, handle, { channelId: channelIdOpt });
    return {
      success: countryCtx.success,
      error: countryCtx.success ? null : "country_unknown",
      userInfo: countryCtx.userInfo,
      videos: [],
      videoPublishCountry: countryCtx.videoPublishCountry,
      countrySource: countryCtx.countrySource,
      extractionSource: "innertube_browse_direct",
      extractMode: "lite",
      countryOnly: true,
    };
  }

  const countryCtx =
    options.knownCountry ||
    (await resolveYoutubeLiteCountry(page, handle, { channelId: channelIdOpt }));

  const target = {
    browseId: countryCtx.browseId || countryCtx.channelId || channelIdOpt,
    handle: handle || null,
  };

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `YouTube Lite enrich @${handle || channelIdOpt}`
  );

  const videoMap = new Map();
  const browseJsonForHeader = [];
  let apiBatchCount = 0;

  const ingestBrowseJson = (json) => {
    const vids = extractVideosFromInnertubeJson(json);
    const before = videoMap.size;
    for (const v of vids) mergeYtVideoIntoMap(videoMap, v, maxVideos);
    if (vids.length || extractChannelHeaderFromInnertubeJson(json, handle)) {
      browseJsonForHeader.push(json);
      apiBatchCount += 1;
    }
    return videoMap.size - before;
  };

  const first = await fetchChannelVideosFirstPage(page, target);
  if (!first) {
    return {
      success: false,
      error: "innertube_browse_failed",
      userInfo: countryCtx.userInfo || null,
      videos: [],
      videoPublishCountry: countryCtx.videoPublishCountry || null,
      extractionSource: "innertube_browse_direct",
      extractMode: "lite",
    };
  }

  const addedFirst = ingestBrowseJson(first);
  console.log(
    `[extractYoutubeChannelLite] @${handle || channelIdOpt} 首屏 +${addedFirst} videos`
  );

  await paginateViaContinuation(page, browseJsonForHeader, ingestBrowseJson, {
    fetchPage: fetchBrowseContinuation,
    getProgress: () => String(videoMap.size),
    maxPages: Math.min(
      Math.max(Number(process.env.YT_LITE_CHANNEL_MAX_PAGES || 12), 2),
      40
    ),
  });

  let userInfo = countryCtx.userInfo || null;
  for (const json of browseJsonForHeader) {
    userInfo = mergeUserInfo(userInfo, extractChannelHeaderFromInnertubeJson(json, handle));
    if (userInfo?.channelId && !target.browseId) {
      target.browseId = userInfo.channelId;
    }
  }

  const needAboutMeta =
    !userInfo?.country ||
    !userInfo?.email ||
    !(userInfo?.followers?.count > 0);
  const needSubscriberFromAbout = !(userInfo?.followers?.count > 0);
  if (needAboutMeta || needSubscriberFromAbout) {
    const aboutJson = await fetchChannelAbout(page, {
      browseId: target.browseId || userInfo?.channelId || channelIdOpt,
      handle: handle || null,
    });
    if (aboutJson) {
      const aboutPatch = parseAboutFromBrowseJson(aboutJson, handle);
      if (aboutPatch) {
        userInfo = mergeUserInfo(userInfo, aboutPatch);
        const hdr = extractChannelHeaderFromInnertubeJson(aboutJson, handle);
        userInfo = mergeUserInfo(userInfo, hdr);
      }
    }
  }

  if (!userInfo) {
    userInfo = {
      username: handle || channelIdOpt,
      displayName: handle || channelIdOpt,
      channelId: channelIdOpt,
      bio: "",
      email: null,
      country: countryCtx.countryRaw || null,
      avatarUrl: "",
      verified: false,
      followers: { count: 0, display: "0" },
    };
  }

  if (!(userInfo?.followers?.count > 0)) {
    for (const json of browseJsonForHeader) {
      const subs = extractSubscriberCountFromInnertubeJson(json);
      if (subs?.count > 0) {
        userInfo = mergeUserInfo(userInfo, { followers: subs });
        break;
      }
    }
  }

  const resolvedChannelId = userInfo.channelId || channelIdOpt || target.browseId;
  const profileUrl =
    buildChannelPublicUrl(handle, resolvedChannelId) ||
    `https://www.youtube.com/@${handle}`;
  userInfo.profileUrl = profileUrl;
  userInfo.userId = resolvedChannelId || null;

  if (!(userInfo?.followers?.count > 0) && typeof page.goto === "function") {
    const videosUrl = `${profileUrl.replace(/\/$/, "")}/videos`;
    try {
      await page.goto(videosUrl, { waitUntil: "commit", timeout: 45_000 });
      await page.waitForTimeout(1200);
      const pageData = await readYtInitialDataFromPage(page);
      const hdr = extractChannelHeaderFromInnertubeJson(pageData, handle);
      if (hdr?.followers?.count > 0) {
        userInfo = mergeUserInfo(userInfo, hdr);
      } else {
        const subs = extractSubscriberCountFromInnertubeJson(pageData);
        if (subs?.count > 0) {
          userInfo = mergeUserInfo(userInfo, { followers: subs });
        }
      }
    } catch (e) {
      console.warn(
        `[extractYoutubeChannelLite] /videos header fallback skip @${handle}: ${e.message}`
      );
    }
  }

  const videosRaw = sortYtVideosByRecency(Array.from(videoMap.values())).slice(0, maxVideos);
  const videos = await enrichYoutubeVideosEngagement(page, videosRaw, { maxVideos });
  const statistics = computeYtVideoStatistics(videos);
  const success = videos.length > 0 || !!resolvedChannelId;
  const videoPublishCountry =
    countryCtx.videoPublishCountry ||
    normalizeInfluencerCountryToIso(userInfo.country) ||
    null;

  const videosUrl = `${profileUrl.replace(/\/$/, "")}/videos`;
  const aboutUrl = `${profileUrl.replace(/\/$/, "")}/about`;
  const needsAboutPage =
    !userInfo?.email || !String(userInfo?.bio || "").trim();
  if (needsAboutPage && typeof page.goto === "function") {
    try {
      const { enrichUserInfoFromAboutPage } = await import("./yt-about-enrich.js");
      userInfo = await enrichUserInfoFromAboutPage(
        page,
        aboutUrl,
        videosUrl,
        userInfo,
        handle
      );
      if (userInfo?.bio && !userInfo?.email) {
        userInfo.email = extractEmailFromBio(userInfo.bio) || userInfo.email;
      }
      console.log(
        `[extractYoutubeChannelLite] @${handle} /about page bio=${userInfo?.bio ? "yes" : "no"} email=${userInfo?.email || "(无)"}`
      );
    } catch (e) {
      console.warn(
        `[extractYoutubeChannelLite] /about page enrich skip @${handle}: ${e.message}`
      );
    }
  }

  if (success && isLiteEnrichScreenshotsEnabled()) {
    if (typeof page.goto === "function") {
      await page.goto(videosUrl, { waitUntil: "commit", timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await reportYtScreenshot(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      `YouTube Videos @${handle}`,
      page
    );
  }

  console.log(
    `[extractYoutubeChannelLite] @${handle} videos=${videos.length} country=${videoPublishCountry || "(空)"} apiBatches=${apiBatchCount} avgLikes=${statistics.avgLikes ?? "n/a"} avgComments=${statistics.avgComments ?? "n/a"}`
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success ? `Lite @${handle} ${videos.length} 条视频` : `Lite 未获取到 @${handle} 视频`
  );

  return {
    success,
    error: success ? null : "youtube_videos_not_found",
    userInfo,
    videos,
    statistics,
    profileUrl,
    videosUrl: `${profileUrl}/videos`,
    videoPublishCountry,
    countrySource: countryCtx.countrySource || null,
    extractionSource: "innertube_browse_direct",
    extractMode: "lite",
    interceptedCounts: {
      browseBatches: apiBatchCount,
      videosKept: videos.length,
      scrollRoundsUsed: 0,
      initialDataUsed: false,
    },
  };
}
