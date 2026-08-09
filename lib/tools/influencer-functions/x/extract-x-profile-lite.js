/**
 * X Lite 主页 enrich：UserByScreenName API 直调（无需打开主页页）。
 * 国家：profile.location 精确匹配 → bio 语言推断（未知语言符合则继续）；
 * 邮箱：bio 文本 / profile 外链 / 外链网页（可选，默认开，邮箱门槛的主要来源）；
 * 互动：UserTweets 近期推文统计（可选，默认开，供 LLM 画像分析）。
 * 风控节奏对齐 Instagram Lite（串行、请求间隔、限流冷却）。
 */

import {
  BROWSER_STEP_IDS,
  STEP_STATUS,
  createStep,
} from "../../../utils/browser-steps.js";
import {
  extractUserFromUserByScreenName,
  extractUserTweetsFromJson,
  computeXTweetStatistics,
  mapXTweetToSearchClip,
} from "./x-json-utils.js";
import { fetchUserByScreenName, fetchUserTweetsPage } from "./x-graphql.js";
import { extractEmailFromBio, normalizeBioForEmailExtraction } from "../../../influencer/extract-email-from-bio.js";
import {
  normalizeInfluencerCountryToIso,
  countryMatchesPublishLocation,
} from "../../../influencer/campaign-country-codes.js";
import { resolveUnknownCountryBioGate } from "../../../influencer/infer-bio-language.js";
import {
  isXLiteEmailGateEnabled,
  isXLiteEmailFetchWebsiteEnabled,
  isXLiteFetchTweetsEnabled,
} from "../../../scraper/resolve-scraper-mode.js";

function reportStep(onStepUpdate, stepId, status, detail = null) {
  if (!onStepUpdate) return;
  try {
    onStepUpdate({ type: "step", step: createStep(stepId, status, detail, null) });
  } catch {
    /* ignore */
  }
}

function buildSkipResult(userInfo, skippedReason, extra = {}) {
  return {
    success: true,
    skippedReason,
    error: null,
    userInfo,
    videos: [],
    statistics: null,
    profileUrl: userInfo?.profileUrl || null,
    videoPublishCountry: extra.videoPublishCountry || null,
    countrySource: extra.countrySource || null,
    extractionSource: "x_graphql_direct",
    extractMode: "lite",
    dataIncomplete: skippedReason === "x_email_not_found",
  };
}

/** 抓取 profile 外链网页提取邮箱（严格超时，仅 https，内容截断） */
async function fetchWebsiteEmail(url) {
  if (!/^https:\/\//i.test(String(url || ""))) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      },
    });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const text = Buffer.from(buf).toString("utf8").slice(0, 200_000);
    const clean = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&#\d+;/g, " ");
    return extractEmailFromBio(clean) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} session x-session（已登录 x.com）
 * @param {string} username
 * @param {{ onStepUpdate?: Function, allowedCountriesIso?: string[]|null, maxTweets?: number }} [options]
 */
export async function extractXProfileLite(session, username, options = {}) {
  const { onStepUpdate = null, allowedCountriesIso = null, maxTweets = 20 } = options;
  const handle = String(username || "").replace(/^@/, "").trim();
  if (!handle) {
    return { success: false, error: "missing_username", userInfo: null, videos: [] };
  }

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.RUNNING,
    `X Lite @${handle}`
  );

  const json = await fetchUserByScreenName(session, handle);
  const user = json ? extractUserFromUserByScreenName(json) : null;
  if (!user) {
    console.warn(`[extractXProfileLite] @${handle} UserByScreenName 无结果`);
    return {
      success: false,
      error: "x_user_not_found",
      userInfo: null,
      videos: [],
      extractionSource: "x_graphql_direct",
      extractMode: "lite",
    };
  }

  const userInfo = {
    ...user,
    username: handle,
    profileUrl: `https://x.com/${handle}`,
  };

  // ---------- 邮箱（bio → 外链 URL → 外链网页） ----------
  let email = extractEmailFromBio(normalizeBioForEmailExtraction(userInfo.bio)) || null;
  let emailSource = email ? "bio" : null;
  const website = userInfo.website || null;
  if (!email && website && isXLiteEmailFetchWebsiteEnabled()) {
    const siteEmail = await fetchWebsiteEmail(website);
    if (siteEmail) {
      email = siteEmail;
      emailSource = "website";
    }
  }
  userInfo.email = email;
  userInfo.aboutEmailSource = emailSource;

  if (isXLiteEmailGateEnabled() && !email) {
    console.log(
      `[extractXProfileLite] @${handle} 未识别到邮箱，跳过推文 enrich 和 LLM 分析`
    );
    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      STEP_STATUS.COMPLETED,
      `X Lite @${handle} 无邮箱，跳过后续分析`
    );
    return buildSkipResult(userInfo, "x_email_not_found");
  }

  // ---------- 国家：location 精确匹配 → bio 语言推断 ----------
  const locationIso = normalizeInfluencerCountryToIso(userInfo.location) || null;
  let videoPublishCountry = locationIso;
  let countrySource = locationIso ? "location" : null;
  let skippedReason = null;
  const gateCountries =
    Array.isArray(allowedCountriesIso) && allowedCountriesIso.length > 0
      ? allowedCountriesIso
      : null;

  if (gateCountries) {
    if (locationIso) {
      if (!countryMatchesPublishLocation(locationIso, gateCountries)) {
        skippedReason = "country_mismatch";
      }
    } else {
      const bioGate = resolveUnknownCountryBioGate(userInfo.bio, gateCountries);
      if (!bioGate.proceed) {
        skippedReason = bioGate.skippedReason || "country_unknown";
      } else if (bioGate.countrySource) {
        countrySource = bioGate.countrySource;
      }
    }
  }

  if (skippedReason) {
    console.log(
      `[extractXProfileLite] @${handle} 国家跳过: ${skippedReason} country=${videoPublishCountry || "(空)"}`
    );
    reportStep(
      onStepUpdate,
      BROWSER_STEP_IDS.ENRICH_PROFILES,
      STEP_STATUS.COMPLETED,
      `X Lite @${handle} ${skippedReason}`
    );
    return buildSkipResult(userInfo, skippedReason, { videoPublishCountry, countrySource });
  }

  // ---------- 近期推文互动（供 LLM 画像分析） ----------
  let videos = [];
  let statistics = null;
  if (isXLiteFetchTweetsEnabled() && userInfo.userId) {
    try {
      const tweetsJson = await fetchUserTweetsPage(session, userInfo.userId, {
        count: Math.max(5, Math.min(Number(maxTweets) || 20, 40)),
      });
      if (tweetsJson) {
        const tweets = extractUserTweetsFromJson(tweetsJson);
        videos = tweets
          .map((t) => mapXTweetToSearchClip(t, userInfo))
          .filter(Boolean);
        statistics = computeXTweetStatistics(tweets);
      }
    } catch (e) {
      console.warn(`[extractXProfileLite] @${handle} UserTweets 失败: ${e.message}`);
    }
  }

  const success = true;
  const emailLog = userInfo.email
    ? `email=${userInfo.email}(${emailSource})`
    : "email=(空)";
  console.log(
    `[extractXProfileLite] @${handle} followers=${userInfo.followers?.count || 0} ` +
      `country=${videoPublishCountry || "(空)"} source=${countrySource || "(空)"} ` +
      `tweets=${videos.length} avgLikes=${statistics?.avgLikes ?? "n/a"} ${emailLog}`
  );

  reportStep(
    onStepUpdate,
    BROWSER_STEP_IDS.ENRICH_PROFILES,
    STEP_STATUS.COMPLETED,
    `X Lite @${handle} ${videos.length} 条推文`
  );

  return {
    success,
    error: null,
    skippedReason: null,
    userInfo,
    videos,
    statistics,
    profileUrl: userInfo.profileUrl,
    videoPublishCountry,
    countrySource,
    extractionSource: "x_graphql_direct",
    extractMode: "lite",
    apiCalls: { userByScreenName: 1, userTweets: videos.length ? 1 : 0 },
  };
}
