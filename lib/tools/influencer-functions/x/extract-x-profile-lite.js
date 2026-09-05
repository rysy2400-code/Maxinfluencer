/**
 * X Lite 主页 enrich：浏览器打开真实主页 + 拦截 UserByScreenName/UserTweets 响应，
 * 并以 DOM 兜底 followers/location/description/website（GraphQL 响应有时缺字段）。
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
import {
  attachXGraphqlCollector,
  parseProfileDom,
  xSpaNavigate,
} from "./x-browser-io.js";

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
    extractionSource: "x_profile_page_intercept",
    extractMode: "lite",
    dataIncomplete: skippedReason === "x_email_not_found",
  };
}

const WEBSITE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/** 从 t.co / 跳转落地页 HTML 里解析真实目标 URL（meta refresh / location.replace / title） */
function resolveRedirectTargetUrl(html) {
  const m =
    html.match(/<META[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*URL=([^"']+)/i) ||
    html.match(/location\.replace\(["']([^"']+)["']\)/i) ||
    html.match(/<title>([^<]{5,200})<\/title>/i);
  if (!m?.[1]) return null;
  const u = String(m[1]).replace(/\\\//g, "/").trim();
  return /^https?:\/\//i.test(u) ? u : null;
}

/** 单次抓取 URL 并返回清理后的文本（严格超时，内容截断；失败返回 null） */
async function fetchUrlText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": WEBSITE_UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const text = Buffer.from(buf).toString("utf8").slice(0, 300_000);
    return text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&#\d+;/g, " ");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 常见联系页路径（X 红人外链多为首页/聚合页，邮箱通常在 contact/about 子页） */
const WEBSITE_CONTACT_PATHS = ["/contact", "/contact-us", "/about", "/kontak", "/contact/"];

/**
 * 抓取 profile 外链提取邮箱：跟 t.co 跳转 → 首页 → 常见联系页。
 * X 红人习惯：邮箱主要直显 bio；外链首页多数不含邮箱，联系页命中率更高。
 */
async function fetchWebsiteEmail(url) {
  if (!/^https?:\/\//i.test(String(url || ""))) return null;
  let current = String(url);
  for (let hop = 0; hop < 3; hop += 1) {
    const text = await fetchUrlText(current);
    if (!text) return null;
    const email = extractEmailFromBio(text) || null;
    if (email) return email;
    // t.co 等落地页是 200 的 JS/meta 跳转页：解析真实 URL 再抓一次
    const next = resolveRedirectTargetUrl(text);
    if (next && next !== current && /^https?:\/\//i.test(next)) {
      current = next;
      continue;
    }
    break;
  }
  // 首页无邮箱：尝试常见联系页（最多 2 个，控制成本）
  const base = new URL(current);
  let tried = 0;
  for (const p of WEBSITE_CONTACT_PATHS) {
    if (tried >= 2) break;
    const pageUrl = new URL(p, base).toString();
    if (pageUrl === current) continue;
    const pageText = await fetchUrlText(pageUrl);
    if (!pageText) continue;
    const email = extractEmailFromBio(pageText) || null;
    if (email) return email;
    tried += 1;
  }
  return null;
}

/** 把 DOM 兜底字段合并进归一化 user（不覆盖已有非空值） */
function mergeDomFallback(userInfo, dom) {
  if (!dom || typeof dom !== "object") return userInfo;
  const merged = { ...userInfo };
  if ((!merged.followers || merged.followers?.count === 0) && Number(dom.followers) > 0) {
    merged.followers = { count: dom.followers, display: String(dom.followers) };
  }
  if (!merged.location && dom.location) merged.location = dom.location;
  if (!merged.bio && dom.description) merged.bio = dom.description;
  if (!merged.website && dom.website) merged.website = dom.website;
  if ((!merged.displayName || merged.displayName === merged.username) && dom.displayName) {
    merged.displayName = dom.displayName;
  }
  return merged;
}

/**
 * 从 /about 页 AboutAccountQuery 抓取账号归属国家（account_based_in，X 官方口径）。
 * 走 SPA 路由到 /about → 拦截响应 → 回主页路径，尽量不产生额外页面脚本流量。
 * @returns {Promise<{accountBasedIn: string}|null>}
 */
async function fetchAboutAccountCountry(page, collector, handle) {
  try {
    const backPath = `/${handle}`;
    const spaOk = await xSpaNavigate(page, `/${handle}/about`);
    if (!spaOk) return null;
    const batches = await collector.waitFor("AboutAccountQuery", { timeoutMs: 7000 });
    // 回到主页路径（后续推文采集需要在 timeline 页）
    await xSpaNavigate(page, backPath).catch(() => {});
    const hit = batches.find((b) => b.name === "AboutAccountQuery");
    const aboutProfile = hit?.json?.data?.user_result_by_screen_name?.result?.about_profile;
    const based = String(aboutProfile?.account_based_in || "").trim();
    return based ? { accountBasedIn: based } : null;
  } catch (e) {
    console.warn(`[extractXProfileLite] @${handle} About 国家获取失败: ${e?.message || e}`);
    return null;
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

  const { page } = session;
  let collector = null;
  try {
    collector = attachXGraphqlCollector(page, [
      "UserByScreenName",
      "AboutAccountQuery",
      "UserTweets",
      "UserByRestId",
      "UserOriginalsTimeline",
    ]);

    const profilePath = `/${handle}`;
    const profileUrl = `https://x.com${profilePath}`;
    // 优先 SPA 路由跳转（脚本不重载，仅 API 流量）；失败/无响应时回退整页加载
    const spaOk = await xSpaNavigate(page, profilePath);
    if (!spaOk) {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => {
        console.warn(`[extractXProfileLite] @${handle} 打开主页失败: ${e.message}（继续等待响应）`);
      });
    }

    // 等 UserByScreenName 响应；页面默认只发一次，必要时补一个 UI 等待
    let batches = await collector.waitFor("UserByScreenName", { timeoutMs: 30000 });
    if (!batches.length) {
      await page.waitForTimeout(1500);
      batches = collector.drain();
      if (!batches.length && spaOk) {
        // SPA 路由未触发 UserByScreenName：整页回退一次
        console.warn(`[extractXProfileLite] @${handle} SPA 跳转未触发，整页回退`);
        await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        batches = await collector.waitFor("UserByScreenName", { timeoutMs: 20000 });
      }
    }
    const userJsonBatch = batches.find((b) => b.name === "UserByScreenName");
    const user = userJsonBatch
      ? extractUserFromUserByScreenName(userJsonBatch.json)
      : null;
    if (!user) {
      console.warn(`[extractXProfileLite] @${handle} UserByScreenName 无结果`);
      return {
        success: false,
        error: "x_user_not_found",
        userInfo: null,
        videos: [],
        extractionSource: "x_profile_page_intercept",
        extractMode: "lite",
      };
    }

    let userInfo = {
      ...user,
      username: handle,
      profileUrl: `https://x.com/${handle}`,
    };

    // DOM 兜底：followers / location / description / website
    const dom = await parseProfileDom(page);
    userInfo = mergeDomFallback(userInfo, dom);

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
    userInfo.locationRaw = userInfo.location || null;

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

    // ---------- 粉丝门槛（对齐 IG/YT Lite：粉丝低于阈值跳过国家/推文/LLM，默认 500） ----------
    const minFollowers = Math.max(
      Number(process.env.X_LITE_MIN_FOLLOWERS ?? 500) || 0,
      0
    );
    const followerCount = Number(userInfo.followers?.count) || 0;
    // 对齐 ins/yt lite：0/未知也视为低于门槛（否则解析缺失时低粉账号漏过门禁）
    if (minFollowers > 0 && followerCount < minFollowers) {
      console.log(
        `[extractXProfileLite] @${handle} 粉丝 ${followerCount} < ${minFollowers}，跳过推文 enrich 和 LLM 分析`
      );
      reportStep(
        onStepUpdate,
        BROWSER_STEP_IDS.ENRICH_PROFILES,
        STEP_STATUS.COMPLETED,
        `X Lite @${handle} 粉丝 ${followerCount} < ${minFollowers}，跳过后续分析`
      );
      return buildSkipResult(userInfo, "followers_below_500", {
        followerThreshold: minFollowers,
      });
    }

    // ---------- 国家：Account based in（About 官方口径）→ location 解析 → bio 语言推断 ----------
    const about = await fetchAboutAccountCountry(page, collector, handle);
    if (about?.accountBasedIn) {
      userInfo.accountBasedIn = about.accountBasedIn;
    }
    const locationIso = normalizeInfluencerCountryToIso(userInfo.location) || null;
    const aboutIso = about?.accountBasedIn
      ? normalizeInfluencerCountryToIso(about.accountBasedIn) || null
      : null;
    let videoPublishCountry = aboutIso || locationIso;
    let countrySource = aboutIso
      ? "account_based_in"
      : locationIso
        ? "location"
        : null;
    let skippedReason = null;
    const gateCountries =
      Array.isArray(allowedCountriesIso) && allowedCountriesIso.length > 0
        ? allowedCountriesIso
        : null;

    if (gateCountries) {
      if (aboutIso || locationIso) {
        const countryIso = aboutIso || locationIso;
        if (!countryMatchesPublishLocation(countryIso, gateCountries)) {
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

    // ---------- 近期推文互动（供 LLM 画像分析；拦截不到时置空，不阻塞邮箱门槛） ----------
    let videos = [];
    let statistics = null;
    if (isXLiteFetchTweetsEnabled() && userInfo.userId) {
      try {
        const targetCount = Math.max(
          5,
          Math.min(Number(process.env.X_LITE_FETCH_TWEETS_MAX || 50) || 50, 200)
        );
        const tweetMap = new Map();
        const timelineNames = new Set(["UserTweets", "UserOriginalsTimeline", "UserVideoTimeline"]);
        const ingest = (batches) => {
          for (const b of batches) {
            if (!timelineNames.has(b.name)) continue;
            const tw = extractUserTweetsFromJson(b.json);
            for (const t of tw) {
              if (!tweetMap.has(t.tweetId)) tweetMap.set(t.tweetId, t);
            }
          }
        };
        // 先消化主页加载时已到达的 timeline 响应（首屏一般 20-25 条，含 views/likes/comments）
        ingest(collector.drain());
        // 若首屏不足，尝试滚 2-3 次（部分账号翻页可触发 UserOriginalsTimeline 增量）
        for (let round = 0; round < 3 && tweetMap.size < targetCount; round += 1) {
          const before = tweetMap.size;
          await page.mouse.wheel(0, 6000).catch(() => {});
          await page.waitForTimeout(1800);
          ingest(collector.drain());
          if (tweetMap.size === before) break;
        }
        // 仍不足且允许补充：切到 Media 页收集 UserVideoTimeline（图片/视频帖，同样带 views/likes/comments）
        if (
          tweetMap.size < targetCount &&
          String(process.env.X_LITE_FETCH_TWEETS_MEDIA_SUPPLEMENT ?? "1") !== "0"
        ) {
          try {
            const mediaPath = `/${handle}/media`;
            const spaOkMedia = await xSpaNavigate(page, mediaPath);
            if (!spaOkMedia) {
              await page.goto(`https://x.com${mediaPath}`, {
                waitUntil: "domcontentloaded",
                timeout: 45000,
              });
            }
            await page.waitForTimeout(2500);
            ingest(collector.drain());
            await page.mouse.wheel(0, 5000).catch(() => {});
            await page.waitForTimeout(1800);
            ingest(collector.drain());
            // 回主页路径，便于下一个红人继续 SPA 跳转（路由上下文更干净）
            await xSpaNavigate(page, `/${handle}`);
          } catch (e) {
            console.warn(`[extractXProfileLite] @${handle} Media 页补充失败: ${e.message}`);
          }
        }
        const tweets = [...tweetMap.values()].slice(0, targetCount);
        videos = tweets.map((t) => mapXTweetToSearchClip(t, userInfo)).filter(Boolean);
        statistics = computeXTweetStatistics(tweets);
        // 播放量门槛（可选，默认关）：近 N 条均播放低于阈值跳过（X views=曝光，需谨慎）
        const minAvgViews = Number(process.env.X_LITE_MIN_AVG_VIEWS) || 0;
        if (minAvgViews > 0 && statistics?.sampleCount > 0 && statistics.avgViews < minAvgViews) {
          console.log(
            `[extractXProfileLite] @${handle} 均播放 ${statistics.avgViews} < ${minAvgViews}，跳过 LLM 分析`
          );
          return buildSkipResult(userInfo, "views_below_threshold", {
            videoPublishCountry,
            countrySource,
          });
        }
      } catch (e) {
        console.warn(`[extractXProfileLite] @${handle} 推文统计失败: ${e.message}`);
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

    try {
      collector.detach();
    } catch {
      /* ignore */
    }

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
      extractionSource: "x_profile_page_intercept",
      extractMode: "lite",
      apiCalls: { userByScreenName: userJsonBatch ? 1 : 0, userTweets: videos.length ? 1 : 0 },
    };
  } catch (e) {
    try {
      collector?.detach();
    } catch {
      /* ignore */
    }
    throw e;
  }
}
