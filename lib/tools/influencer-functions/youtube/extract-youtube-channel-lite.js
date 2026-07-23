/**
 * YouTube Lite 频道 enrich v2：innertube API about → 国家门禁 → innertube 拉视频 → 可选 /videos 截图
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
import {
  countryMatchesPublishLocation,
  normalizeInfluencerCountryToIso,
} from "../../../influencer/campaign-country-codes.js";
import {
  fetchChannelVideosFirstPage,
  fetchChannelAboutViewModel,
  fetchBrowseContinuation,
  paginateViaContinuation,
  resolveBrowseTarget,
} from "./innertube-direct-fetch.js";
import { isLiteEnrichScreenshotsEnabled, resolveYtAllowAboutFallback } from "../../../scraper/resolve-scraper-mode.js";
import { reportYtScreenshot } from "./yt-cdp-screenshot.js";
import { readYtInitialDataFromPage } from "./cdp-innertube-collector.js";
import { inferIgCountryFromBio } from "../instagram/instagram-json-utils.js";
import { resolveUnknownCountryBioGate } from "../../../influencer/infer-bio-language.js";
import { enrichYoutubeVideosEngagement } from "./yt-video-engagement-enrich.js";

export const YOUTUBE_LITE_MIN_FOLLOWERS_FOR_ANALYSIS = 500;

export function shouldSkipYoutubeLiteLowFollowers(
  userInfo,
  minimumFollowers = YOUTUBE_LITE_MIN_FOLLOWERS_FOR_ANALYSIS
) {
  const rawCount = userInfo?.followers?.count;
  if (rawCount == null || rawCount === "") return false;
  const count = Number(rawCount);
  return Number.isFinite(count) && count >= 0 && count < minimumFollowers;
}

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
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  if (patch.followers?.count > 0) out.followers = patch.followers;
  if (
    patch.bio &&
    (!base?.bio || String(patch.bio).length > String(base.bio || "").length)
  ) {
    out.bio = patch.bio;
  }
  if (patch.country && !base?.country) out.country = patch.country;
  if (patch.email && !base?.email) out.email = patch.email;
  if (patch.aboutEmailSource && !base?.aboutEmailSource) {
    out.aboutEmailSource = patch.aboutEmailSource;
  }
  if (patch.aboutEmailSourceDetail && !base?.aboutEmailSourceDetail) {
    out.aboutEmailSourceDetail = patch.aboutEmailSourceDetail;
  }
  if (Array.isArray(patch.aboutLinks) && patch.aboutLinks.length > 0) {
    out.aboutLinks = patch.aboutLinks;
  }
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
  return resolveYtAllowAboutFallback();
}

/**
 * v2 核心：goto /@handle/about，从 ytInitialData 解析国家/bio/邮箱/订阅
 * @returns {Promise<{
 *   success: boolean,
 *   videoPublishCountry: string|null,
 *   countryRaw: string|null,
 *   countrySource: string|null,
 *   browseId: string|null,
 *   userInfo: object|null,
 *   handle: string,
 *   channelId: string|null,
 *   profileUrl: string|null,
 *   aboutUrl: string|null,
 * }>}
 */
export async function loadYoutubeChannelAboutFromPage(page, username, channelIdOpt = null) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const profileUrl =
    buildChannelPublicUrl(handle, channelIdOpt) ||
    (handle ? `https://www.youtube.com/@${encodeURIComponent(handle)}` : null);

  if (!profileUrl || typeof page?.goto !== "function") {
    return {
      success: false,
      videoPublishCountry: null,
      countryRaw: null,
      countrySource: null,
      browseId: channelIdOpt?.startsWith("UC") ? channelIdOpt : null,
      userInfo: null,
      handle,
      channelId: channelIdOpt,
      profileUrl,
      aboutUrl: null,
    };
  }

  const aboutUrl = `${profileUrl.replace(/\/$/, "")}/about`;
  let data = null;

  try {
    await page.goto(aboutUrl, { waitUntil: "commit", timeout: 45_000 });
    await page.waitForTimeout(1200);
    data = await readYtInitialDataFromPage(page);
  } catch (e) {
    console.warn(`[loadYoutubeChannelAboutFromPage] @${handle} goto /about failed: ${e.message}`);
    return {
      success: false,
      videoPublishCountry: null,
      countryRaw: null,
      countrySource: null,
      browseId: channelIdOpt?.startsWith("UC") ? channelIdOpt : null,
      userInfo: null,
      handle,
      channelId: channelIdOpt,
      profileUrl,
      aboutUrl,
    };
  }

  const hdr = extractChannelHeaderFromInnertubeJson(data, handle);
  const aboutPatch = parseAboutFromBrowseJson(data, handle);
  let userInfo = mergeUserInfo(hdr, aboutPatch);
  let browseId =
    channelIdOpt?.startsWith("UC")
      ? channelIdOpt
      : userInfo?.channelId || hdr?.channelId || null;

  let countryRaw = aboutPatch?.country || hdr?.country || null;
  let videoPublishCountry = countryRaw ? normalizeInfluencerCountryToIso(countryRaw) : null;
  let countrySource = aboutPatch?.country ? "about_page" : hdr?.country ? "about_page_header" : null;

  if (!videoPublishCountry && userInfo?.bio) {
    const bioHit = inferIgCountryFromBio(userInfo.bio);
    if (bioHit?.videoPublishCountry) {
      countryRaw = bioHit.countryRaw;
      videoPublishCountry = bioHit.videoPublishCountry;
      countrySource = bioHit.source;
    }
  }

  if (!browseId && handle) {
    browseId = await resolveBrowseTarget(page, { handle, browseId: null });
    if (browseId && userInfo) userInfo.channelId = browseId;
  }

  const resolvedChannelId = browseId || userInfo?.channelId || channelIdOpt;
  if (userInfo) {
    userInfo.profileUrl = profileUrl;
    userInfo.userId = resolvedChannelId || null;
    userInfo.username = handle || userInfo.username;
    if (countryRaw) userInfo.country = countryRaw;
    if (!userInfo.email) {
      const emailHit = resolveEmailFromAbout({
        description: userInfo.bio || "",
        links: userInfo.aboutLinks || [],
      });
      if (emailHit.email) {
        userInfo.email = emailHit.email;
        userInfo.aboutEmailSource = emailHit.source;
        userInfo.aboutEmailSourceDetail = emailHit.sourceDetail;
      }
    }
  }

  const linkCount = userInfo?.aboutLinks?.length || 0;
  const emailLog = userInfo?.email
    ? `email=${userInfo.email}(${userInfo.aboutEmailSource || "about"})`
    : "email=(空)";
  if (videoPublishCountry) {
    console.log(
      `[loadYoutubeChannelAboutFromPage] @${handle} country=${videoPublishCountry} source=${countrySource} bioLen=${userInfo?.bio?.length || 0} links=${linkCount} ${emailLog}`
    );
  } else {
    console.log(
      `[loadYoutubeChannelAboutFromPage] @${handle} country=(空) bioLen=${userInfo?.bio?.length || 0} links=${linkCount} ${emailLog}`
    );
  }

  return {
    success: !!videoPublishCountry,
    videoPublishCountry,
    countryRaw,
    countrySource,
    browseId: resolvedChannelId || null,
    userInfo,
    handle,
    channelId: resolvedChannelId || null,
    profileUrl,
    aboutUrl,
  };
}

/**
 * innertube 两步 browse 获取 aboutChannelViewModel（无 /about 页面导航）
 */
export async function loadYoutubeChannelAboutFromApi(page, username, channelIdOpt = null) {
  const handle = String(username || "").replace(/^@/, "").trim();
  const profileUrl =
    buildChannelPublicUrl(handle, channelIdOpt) ||
    (handle ? `https://www.youtube.com/@${encodeURIComponent(handle)}` : null);
  const aboutUrl = profileUrl ? `${profileUrl.replace(/\/$/, "")}/about` : null;

  if (!profileUrl) {
    return {
      success: false,
      videoPublishCountry: null,
      countryRaw: null,
      countrySource: null,
      browseId: channelIdOpt?.startsWith("UC") ? channelIdOpt : null,
      userInfo: null,
      handle,
      channelId: channelIdOpt,
      profileUrl,
      aboutUrl,
    };
  }

  const aboutResult = await fetchChannelAboutViewModel(page, {
    handle: handle || null,
    browseId: channelIdOpt?.startsWith("UC") ? channelIdOpt : null,
  });

  if (!aboutResult?.browseJson) {
    return {
      success: false,
      videoPublishCountry: null,
      countryRaw: null,
      countrySource: null,
      browseId: channelIdOpt?.startsWith("UC") ? channelIdOpt : null,
      userInfo: null,
      handle,
      channelId: channelIdOpt,
      profileUrl,
      aboutUrl,
    };
  }

  const hdr = extractChannelHeaderFromInnertubeJson(aboutResult.browseJson, handle);
  const aboutPatch = parseAboutFromBrowseJson(aboutResult.browseJson, handle);
  let userInfo = mergeUserInfo(hdr, aboutPatch);

  const vmCountry = aboutResult.viewModel
    ? extractCountryFromAboutMeta(aboutResult.viewModel)
    : null;
  let countryRaw =
    vmCountry?.raw || aboutPatch?.country || hdr?.country || null;
  let videoPublishCountry =
    vmCountry?.iso ||
    (countryRaw ? normalizeInfluencerCountryToIso(countryRaw) : null);
  let countrySource = vmCountry
    ? aboutResult.source
    : aboutPatch?.country
      ? "innertube_about_api"
      : hdr?.country
        ? "browse_header"
        : null;

  if (!videoPublishCountry && userInfo?.bio) {
    const bioHit = inferIgCountryFromBio(userInfo.bio);
    if (bioHit?.videoPublishCountry) {
      countryRaw = bioHit.countryRaw;
      videoPublishCountry = bioHit.videoPublishCountry;
      countrySource = bioHit.source;
    }
  }

  let browseId =
    channelIdOpt?.startsWith("UC")
      ? channelIdOpt
      : userInfo?.channelId || hdr?.channelId || null;
  if (!browseId && handle) {
    browseId = await resolveBrowseTarget(page, { handle, browseId: null });
  }

  const resolvedChannelId = browseId || userInfo?.channelId || channelIdOpt;
  if (userInfo) {
    userInfo.profileUrl = profileUrl;
    userInfo.userId = resolvedChannelId || null;
    userInfo.username = handle || userInfo.username;
    if (countryRaw) userInfo.country = countryRaw;
    if (!userInfo.email) {
      const emailHit = resolveEmailFromAbout({
        description: userInfo.bio || "",
        links: userInfo.aboutLinks || [],
      });
      if (emailHit.email) {
        userInfo.email = emailHit.email;
        userInfo.aboutEmailSource = emailHit.source;
        userInfo.aboutEmailSourceDetail = emailHit.sourceDetail;
      }
    }
  }

  if (videoPublishCountry) {
    console.log(
      `[loadYoutubeChannelAboutFromApi] @${handle} country=${videoPublishCountry} source=${countrySource}`
    );
  } else {
    console.log(`[loadYoutubeChannelAboutFromApi] @${handle} country=(空)`);
  }

  return {
    success: !!videoPublishCountry,
    videoPublishCountry,
    countryRaw,
    countrySource,
    browseId: resolvedChannelId || null,
    userInfo,
    handle,
    channelId: resolvedChannelId || null,
    profileUrl,
    aboutUrl,
  };
}

async function loadYoutubeChannelAbout(page, username, channelIdOpt = null) {
  if (process.env.YT_LITE_ABOUT_PAGE_NAV === "1") {
    return loadYoutubeChannelAboutFromPage(page, username, channelIdOpt);
  }
  const apiCtx = await loadYoutubeChannelAboutFromApi(page, username, channelIdOpt);
  if (apiCtx.success || !shouldAllowAboutFallback()) {
    return apiCtx;
  }
  return loadYoutubeChannelAboutFromPage(page, username, channelIdOpt);
}

function buildCountrySkipLiteResult(aboutCtx, skippedReason) {
  return {
    success: true,
    skippedReason,
    error: null,
    userInfo: aboutCtx.userInfo,
    videos: [],
    statistics: null,
    profileUrl: aboutCtx.profileUrl,
    videosUrl: aboutCtx.profileUrl ? `${aboutCtx.profileUrl.replace(/\/$/, "")}/videos` : null,
    videoPublishCountry: aboutCtx.videoPublishCountry || null,
    countrySource: aboutCtx.countrySource || null,
    extractionSource: "innertube_browse_direct",
    extractMode: "lite",
  };
}

function buildLowFollowersSkipLiteResult(aboutCtx) {
  return {
    ...buildCountrySkipLiteResult(aboutCtx, "followers_below_500"),
    followerThreshold: YOUTUBE_LITE_MIN_FOLLOWERS_FOR_ANALYSIS,
  };
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

function walkAboutChannelViewModel(obj, d = 0) {
  if (d > 22 || !obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const found = walkAboutChannelViewModel(x, d + 1);
      if (found) return found;
    }
    return null;
  }
  if (obj.aboutChannelViewModel) return obj.aboutChannelViewModel;
  for (const v of Object.values(obj)) {
    if (typeof v === "object" && v) {
      const found = walkAboutChannelViewModel(v, d + 1);
      if (found) return found;
    }
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

function normalizeExternalUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^mailto:/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^\/\//, "")}`;
}

function extractDescriptionFromAboutMeta(aboutMeta) {
  if (!aboutMeta) return "";
  return (
    (typeof aboutMeta.description === "string" ? aboutMeta.description : null) ||
    aboutMeta?.description?.content ||
    aboutMeta?.description?.simpleText ||
    textFromRuns(aboutMeta?.description?.runs || aboutMeta?.description) ||
    ""
  );
}

function extractAboutLinksFromMeta(aboutMeta, aboutJson = null) {
  const out = [];
  const seen = new Set();

  const push = (title, url) => {
    const normalized = normalizeExternalUrl(url);
    if (!normalized || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    out.push({ title: String(title || "").trim(), url: normalized });
  };

  const parseLinkItem = (item) => {
    const vm =
      item?.channelExternalLinkViewModel ||
      item?.aboutChannelExternalLinkViewModel ||
      item;
    const title =
      vm?.title?.content ||
      textFromRuns(vm?.title?.runs || vm?.title) ||
      vm?.title?.simpleText ||
      vm?.title?.text ||
      vm?.name?.simpleText ||
      "";
    const linkText =
      vm?.link?.content ||
      vm?.link?.commandRuns?.[0]?.onTap?.innertubeCommand?.urlEndpoint?.url ||
      textFromRuns(vm?.link?.runs || vm?.link) ||
      vm?.link?.simpleText ||
      vm?.link?.text ||
      vm?.url ||
      vm?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ||
      "";
    push(title, linkText);
  };

  const metas = [aboutMeta, walkAboutChannelViewModel(aboutJson)].filter(Boolean);
  for (const meta of metas) {
    for (const arr of [
      meta.links,
      meta.primaryLinks,
      meta.featuredLinks,
      meta.externalLinks,
    ].filter(Array.isArray)) {
      for (const item of arr) parseLinkItem(item);
    }
  }

  return out;
}

/**
 * 从 About Description 与外链解析邮箱（description 优先，其次 mailto / 外链 URL）
 * @returns {{ email: string|null, source: string|null, sourceDetail: string|null }}
 */
function resolveEmailFromAbout({ description = "", links = [] } = {}) {
  const fromDesc = extractEmailFromBio(description);
  if (fromDesc) {
    return {
      email: fromDesc,
      source: "about_description",
      sourceDetail: "YouTube /about 频道简介正文",
    };
  }

  for (const link of links) {
    const url = String(link?.url || "");
    if (/^mailto:/i.test(url)) {
      const mail = url.replace(/^mailto:/i, "").split("?")[0].trim();
      if (mail) {
        return {
          email: mail,
          source: "about_mailto_link",
          sourceDetail: link?.title || url,
        };
      }
    }
    const fromUrl = extractEmailFromBio(url);
    if (fromUrl) {
      return {
        email: fromUrl,
        source: "about_external_link",
        sourceDetail: link?.title || url,
      };
    }
  }

  return { email: null, source: null, sourceDetail: null };
}

function parseAboutFromBrowseJson(json, handle) {
  const aboutMeta = walkAboutMeta(json);
  if (!aboutMeta) return null;

  const countryHit = extractCountryFromAboutMeta(aboutMeta);
  const countryText = countryHit?.raw || null;
  const desc = extractDescriptionFromAboutMeta(aboutMeta);
  const aboutLinks = extractAboutLinksFromMeta(aboutMeta, json);
  const emailHit = resolveEmailFromAbout({ description: desc, links: aboutLinks });
  const subs = extractSubscriberFromAboutViewModel(aboutMeta);

  return {
    country: countryText ? String(countryText).trim() : null,
    bio: desc || "",
    aboutLinks,
    email: emailHit.email,
    aboutEmailSource: emailHit.source,
    aboutEmailSourceDetail: emailHit.sourceDetail,
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

  const aboutResult = await fetchChannelAboutViewModel(page, {
    browseId,
    handle: handle || null,
  });
  if (aboutResult?.browseJson) {
    const aboutPatch = parseAboutFromBrowseJson(aboutResult.browseJson, handle);
    const hdr = extractChannelHeaderFromInnertubeJson(aboutResult.browseJson, handle);
    userInfo = mergeUserInfo(hdr, aboutPatch);
    const vmCountry = aboutResult.viewModel
      ? extractCountryFromAboutMeta(aboutResult.viewModel)
      : null;
    const countryCandidate =
      vmCountry?.raw || aboutPatch?.country || hdr?.country || null;
    if (countryCandidate) {
      countryRaw = countryCandidate;
      videoPublishCountry =
        vmCountry?.iso || normalizeInfluencerCountryToIso(countryRaw);
      countrySource = vmCountry
        ? aboutResult.source
        : aboutPatch?.country
          ? "innertube_about_api"
          : "browse_header";
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
 * @param {{
 *   onStepUpdate?: Function,
 *   channelId?: string,
 *   countryOnly?: boolean,
 *   allowedCountriesIso?: string[],
 * }} [options]
 */
export async function extractYoutubeChannelLite(page, username, options = {}) {
  const { onStepUpdate = null, allowedCountriesIso = null } = options;
  const handle = String(username || "").replace(/^@/, "").trim();
  const channelIdOpt = options.channelId || null;
  const maxVideos = resolveMaxVideos();

  if (!handle && !channelIdOpt) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  if (options.countryOnly) {
    const aboutCtx = await loadYoutubeChannelAbout(page, handle, channelIdOpt);
    return {
      success: aboutCtx.success,
      error: aboutCtx.success ? null : "country_unknown",
      userInfo: aboutCtx.userInfo,
      videos: [],
      videoPublishCountry: aboutCtx.videoPublishCountry,
      countrySource: aboutCtx.countrySource,
      extractionSource: "innertube_browse_direct",
      extractMode: "lite",
      countryOnly: true,
    };
  }

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `YouTube Lite v2 @${handle || channelIdOpt}`
  );

  const aboutCtx = await loadYoutubeChannelAbout(page, handle, channelIdOpt);
  if (shouldSkipYoutubeLiteLowFollowers(aboutCtx.userInfo)) {
    const followerCount = Number(aboutCtx.userInfo.followers.count);
    console.log(
      `[extractYoutubeChannelLite] @${handle || channelIdOpt} followers=${followerCount} < ${YOUTUBE_LITE_MIN_FOLLOWERS_FOR_ANALYSIS}, skip videos and LLM analysis`
    );
    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      STEP_STATUS.COMPLETED,
      `YouTube Lite @${handle || channelIdOpt} 粉丝 ${followerCount}，跳过后续分析`
    );
    return buildLowFollowersSkipLiteResult(aboutCtx);
  }
  const gateCountries =
    Array.isArray(allowedCountriesIso) && allowedCountriesIso.length > 0
      ? allowedCountriesIso
      : null;

  if (gateCountries) {
    const pubIso = aboutCtx.videoPublishCountry || null;
    if (!pubIso) {
      const bioGate = resolveUnknownCountryBioGate(aboutCtx.userInfo?.bio, gateCountries);
      if (!bioGate.proceed) {
        return buildCountrySkipLiteResult(aboutCtx, bioGate.skippedReason);
      }
      if (bioGate.countrySource) {
        aboutCtx.countrySource = bioGate.countrySource;
      }
    } else if (!countryMatchesPublishLocation(pubIso, gateCountries)) {
      return buildCountrySkipLiteResult(aboutCtx, "country_mismatch");
    }
  }

  const target = {
    browseId: aboutCtx.browseId || channelIdOpt,
    handle: handle || null,
  };

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
      userInfo: aboutCtx.userInfo || null,
      videos: [],
      videoPublishCountry: aboutCtx.videoPublishCountry || null,
      countrySource: aboutCtx.countrySource || null,
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

  let userInfo = aboutCtx.userInfo || null;
  for (const json of browseJsonForHeader) {
    userInfo = mergeUserInfo(userInfo, extractChannelHeaderFromInnertubeJson(json, handle));
    if (userInfo?.channelId && !target.browseId) {
      target.browseId = userInfo.channelId;
    }
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

  if (!userInfo) {
    userInfo = {
      username: handle || channelIdOpt,
      displayName: handle || channelIdOpt,
      channelId: channelIdOpt,
      bio: "",
      email: null,
      country: aboutCtx.countryRaw || null,
      avatarUrl: "",
      verified: false,
      followers: { count: 0, display: "0" },
    };
  }

  const resolvedChannelId = userInfo.channelId || channelIdOpt || target.browseId;
  const profileUrl =
    aboutCtx.profileUrl ||
    buildChannelPublicUrl(handle, resolvedChannelId) ||
    `https://www.youtube.com/@${handle}`;
  userInfo.profileUrl = profileUrl;
  userInfo.userId = resolvedChannelId || null;

  const videosRaw = sortYtVideosByRecency(Array.from(videoMap.values())).slice(0, maxVideos);
  const videos = await enrichYoutubeVideosEngagement(page, videosRaw, { maxVideos });
  const statistics = computeYtVideoStatistics(videos);
  const success = videos.length > 0 || !!resolvedChannelId;
  const videoPublishCountry =
    aboutCtx.videoPublishCountry ||
    normalizeInfluencerCountryToIso(userInfo.country) ||
    null;

  const videosUrl = `${profileUrl.replace(/\/$/, "")}/videos`;

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

  const linkCount = userInfo?.aboutLinks?.length || 0;
  const emailLog = userInfo?.email
    ? `email=${userInfo.email}(${userInfo.aboutEmailSource || "about"})`
    : "email=(空)";
  console.log(
    `[extractYoutubeChannelLite] @${handle} videos=${videos.length} country=${videoPublishCountry || "(空)"} bioLen=${userInfo?.bio?.length || 0} links=${linkCount} ${emailLog} apiBatches=${apiBatchCount} avgLikes=${statistics.avgLikes ?? "n/a"} avgComments=${statistics.avgComments ?? "n/a"}`
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    success ? STEP_STATUS.COMPLETED : STEP_STATUS.FAILED,
    success ? `Lite v2 @${handle} ${videos.length} 条视频` : `Lite 未获取到 @${handle} 视频`
  );

  return {
    success,
    error: success ? null : "youtube_videos_not_found",
    skippedReason: null,
    userInfo,
    videos,
    statistics,
    profileUrl,
    videosUrl,
    videoPublishCountry,
    countrySource: aboutCtx.countrySource || null,
    extractionSource: "innertube_browse_direct",
    extractMode: "lite",
    interceptedCounts: {
      browseBatches: apiBatchCount,
      videosKept: videos.length,
      scrollRoundsUsed: 0,
      initialDataUsed: true,
    },
  };
}
