/**
 * YouTube /about 补全：parallel 9222 下默认跳过（易触发整窗无响应，拖死 IG/TikTok）。
 */

import { guardedGoto, runWithHardTimeout } from "../../../cdp/cdp-tab-utils.js";
import { readYtInitialDataFromPage } from "./cdp-innertube-collector.js";
import {
  extractEmailFromBio,
} from "../../../influencer/extract-email-from-bio.js";
import { extractSubscriberFromAboutViewModel } from "./youtube-json-utils.js";

export function isYtAboutEnrichEnabled() {
  const raw = String(process.env.YT_SKIP_ABOUT_ENRICH || "").trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return false;
  return true;
}

export function resolveYtAboutBudgetMs() {
  const n = Number(process.env.YT_ABOUT_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 60_000) : 18_000;
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

/**
 * 在同一标签页打开 /about（不 newPage），避免额外标签拖死整窗
 * @param {import('playwright').Page} page
 * @param {string} aboutUrl
 * @param {string} videosUrl
 * @param {object} userInfo
 * @param {string} handle
 */
export async function enrichUserInfoFromAboutPage(
  page,
  aboutUrl,
  videosUrl,
  userInfo,
  handle
) {
  if (!isYtAboutEnrichEnabled()) {
    console.log(
      `[extractYoutubeChannel] skip /about @${handle} (YT_SKIP_ABOUT_ENRICH=true)`
    );
    return userInfo;
  }

  const budgetMs = resolveYtAboutBudgetMs();
  const logPrefix = `[extractYoutubeChannel] @${handle}`;

  let workPage = page;
  try {
    await runWithHardTimeout(
      async () => {
        workPage = await guardedGoto(workPage, aboutUrl, {
          label: "yt_about_goto",
          budgetMs,
          waitUntil: "commit",
          retries: 1,
          createRetryPage: async () => workPage.context().newPage(),
        });
        await workPage.waitForTimeout(1200);
        const aboutData = await readYtInitialDataFromPage(workPage);
        const aboutMeta = aboutData ? walkAboutMeta(aboutData) : null;
        if (!aboutMeta) return;

        const countryText =
          (typeof aboutMeta.country === "string" ? aboutMeta.country : null) ||
          aboutMeta?.country?.simpleText ||
          null;
        if (countryText && !userInfo.country) userInfo.country = countryText;

        const desc =
          (typeof aboutMeta.description === "string"
            ? aboutMeta.description
            : null) ||
          aboutMeta?.description?.simpleText ||
          (aboutMeta?.description?.runs || []).map((r) => r.text || "").join("") ||
          "";
        if (desc && !userInfo.bio) userInfo.bio = desc;

        const emailFromAbout = extractEmailFromBio(desc) || null;
        if (emailFromAbout && !userInfo.email) userInfo.email = emailFromAbout;

        const subs = extractSubscriberFromAboutViewModel(aboutMeta);
        if (subs?.count > 0) userInfo.followers = subs;

        console.log(
          `${logPrefix} /about country=${countryText || "(空)"} subs=${subs?.display || "(无)"} email=${emailFromAbout || "(无)"}`
        );
      },
      budgetMs,
      "yt_about_enrich"
    );
  } catch (e) {
    console.warn(`${logPrefix} /about 跳过: ${e.message}`);
  } finally {
    try {
      workPage = await guardedGoto(workPage, videosUrl, {
        label: "yt_back_to_videos",
        budgetMs: 18_000,
        waitUntil: "commit",
        retries: 1,
        createRetryPage: async () => workPage.context().newPage(),
      });
    } catch {
      /* ignore */
    }
  }

  return userInfo;
}
