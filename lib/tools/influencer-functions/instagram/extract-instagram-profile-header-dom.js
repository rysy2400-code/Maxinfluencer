/**
 * Instagram Reels / 主页 header：DOM + 内嵌 JSON 轻量补全 bio / userId / 粉丝数（不点 About）
 */

import { extractEmailFromBio } from "../../../influencer/extract-email-from-bio.js";
import {
  buildIgProfileStatsBundle,
  parseIgProfileStatsFromHeaderText,
  parseIgProfileStatsFromOgDescription,
} from "./instagram-json-utils.js";

const IG_ACCOUNT_TYPE_LINE_RE =
  /^(digital creator|blogger|artist|personal blog|reel creator|comedian|model|public figure|entrepreneur|product\/service)$/i;

/** header.innerText 多行噪声（含账号类型行）常被误当 biography */
export function isLikelyIgPollutedHeaderDomBio(bio, username = "") {
  const t = String(bio || "").trim();
  if (!t || t.length < 24) return false;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  if (lines.some((l) => IG_ACCOUNT_TYPE_LINE_RE.test(l))) return true;
  const handle = String(username || "").replace(/^@/, "").toLowerCase();
  if (
    handle &&
    lines[0] &&
    !lines[0].toLowerCase().includes(handle) &&
    lines[0].length < 48 &&
    !/@|https?:\/\//i.test(lines[0])
  ) {
    return true;
  }
  return false;
}

function normalizeMailtoHref(href) {
  const raw = String(href || "")
    .replace(/^mailto:/i, "")
    .split("?")[0]
    .trim()
    .toLowerCase();
  return raw.includes("@") ? raw : null;
}

/** 从 header.innerText 提取 biography 行（去掉用户名/统计/按钮噪声） */
function extractBioLinesFromHeaderText(headerText, username) {
  const handle = String(username || "").replace(/^@/, "").toLowerCase();
  const lines = String(headerText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const isStatsLine = (text) =>
    /^[\d,.]+[km万]?(?:帖子|posts?|post|followers?|following|粉丝|关注|关注者)$/i.test(
      String(text || "").trim()
    );
  const isNoise = (text) => {
    const t = String(text || "").trim();
    if (!t) return true;
    if (t.replace(/^@/, "").toLowerCase() === handle) return true;
    if (isStatsLine(t)) return true;
    if (/^(follow|message|发消息|分享|分享主页|联系|联系方式|关注|更多|more)$/i.test(t)) {
      return true;
    }
    return false;
  };

  let seenStats = false;
  const bioLines = [];
  for (const line of lines) {
    if (isStatsLine(line)) {
      seenStats = true;
      continue;
    }
    if (isNoise(line)) continue;
    if (
      seenStats ||
      line.includes("@") ||
      line.includes("http") ||
      /\.(com|net|au|co)/i.test(line) ||
      /📧|💌|email|business|collab/i.test(line) ||
      line.split(/\s+/).length >= 2
    ) {
      bioLines.push(line);
    }
  }
  const joined = bioLines.join("\n").trim();
  return joined || null;
}

function resolveHeaderContactEmail(raw) {
  const candidates = [
    normalizeMailtoHref(raw.mailtoEmail),
    raw.publicEmail ? String(raw.publicEmail).trim().toLowerCase() : null,
    raw.businessEmail ? String(raw.businessEmail).trim().toLowerCase() : null,
    extractEmailFromBio(raw.bio),
    extractEmailFromBio(raw.headerText),
  ].filter(Boolean);
  return candidates[0] || null;
}

/**
 * 等待 profile header / og 中出现粉丝统计（中文/英文 UI）
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {{ maxWaitMs?: number }} [options]
 */
export async function waitForInstagramProfileStats(page, username, options = {}) {
  if (!page || typeof page.evaluate !== "function") return false;
  const handle = String(username || "").replace(/^@/, "").trim().toLowerCase();
  if (!handle) return false;

  const maxWait = Math.min(
    Math.max(Number(options.maxWaitMs || process.env.IG_PROFILE_STATS_WAIT_MS || 8000), 1500),
    15_000
  );
  const step = 500;

  for (let waited = 0; waited < maxWait; waited += step) {
    const ready = await page.evaluate((expectedHandle) => {
      const url = String(location.href || "").toLowerCase();
      if (!url.includes(`instagram.com/${expectedHandle}`)) return false;
      const og =
        document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
        "";
      const header = document.querySelector("header")?.innerText || "";
      const blob = `${og}\n${header}`;
      return /粉丝|followers/i.test(blob) && /[\d,.]+/.test(blob);
    }, handle);
    if (ready) return true;
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(step);
    }
  }
  return false;
}

/**
 * 展开 IG 简介「更多 / more」，否则 Business/📧 邮箱常被截断为 ...
 * @param {import('playwright').Page} page
 */
export async function expandInstagramProfileBio(page) {
  if (!page || typeof page.evaluate !== "function") return false;
  try {
    return await page.evaluate(() => {
      const header = document.querySelector("header");
      if (!header) return false;
      let clicked = false;
      const tryClick = (el) => {
        if (!el || clicked) return;
        try {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          el.click?.();
          clicked = true;
        } catch {
          /* ignore */
        }
      };
      for (const el of header.querySelectorAll("span, button, div, a")) {
        const t = (el.innerText || el.textContent || "").trim();
        if (t === "更多" || /^more$/i.test(t)) {
          tryClick(el);
        }
      }
      if (!clicked) {
        for (const el of header.querySelectorAll("span, button, div")) {
          const t = (el.innerText || el.textContent || "").trim();
          if (/^(\.\.\.|…|\.{2,}|more)$/i.test(t) || /^\.\.\.$/.test(t)) {
            tryClick(el);
            if (clicked) break;
          }
        }
      }
      return clicked;
    });
  } catch {
    return false;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} username
 * @returns {Promise<{
 *   bio?: string,
 *   userId?: string,
 *   displayName?: string,
 *   followers?: { count: number, display: string },
 *   following?: { count: number, display: string },
 *   postsCount?: { count: number, display: string },
 *   email?: string,
 *   source?: string
 * }|null>}
 */
export async function extractInstagramProfileHeaderFromPage(page, username) {
  if (!page || typeof page.evaluate !== "function") return null;
  const handle = String(username || "").replace(/^@/, "").trim().toLowerCase();
  if (!handle) return null;

  await waitForInstagramProfileStats(page, handle).catch(() => false);
  await expandInstagramProfileBio(page).catch(() => false);
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(800);
  }

  try {
    const raw = await page.evaluate((expectedHandle) => {
      /** @type {{
       *   bio: string|null,
       *   userId: string|null,
       *   displayName: string|null,
       *   ogDesc: string|null,
       *   headerText: string|null,
       *   publicEmail: string|null,
       *   businessEmail: string|null,
       *   mailtoEmail: string|null,
       *   source: string|null
       * }} */
      const result = {
        bio: null,
        userId: null,
        displayName: null,
        ogDesc: null,
        headerText: null,
        publicEmail: null,
        businessEmail: null,
        mailtoEmail: null,
        source: null,
      };

      const url = String(location.href || "").toLowerCase();
      if (!url.includes(`instagram.com/${expectedHandle}`)) {
        return { mismatchUrl: url };
      }

      const isUsernameLine = (text) =>
        String(text || "")
          .trim()
          .replace(/^@/, "")
          .toLowerCase() === expectedHandle;

      const isStatsLine = (text) => {
        const t = String(text || "").trim();
        return /^[\d,.]+[km万]?(?:帖子|posts?|post|followers?|following|粉丝|关注|关注者)$/i.test(
          t
        );
      };

      const isNoiseLine = (text) => {
        const t = String(text || "").trim();
        if (!t || t.length > 600) return true;
        const lower = t.toLowerCase();
        if (isUsernameLine(t)) return true;
        if (isStatsLine(t)) return true;
        if (/^[\d,.]+[km万]?$/.test(lower)) return true;
        if (/^(posts|post|followers|following|reels|tagged|帖子|粉丝|关注|已关注|关注者)$/i.test(t)) {
          return true;
        }
        if (/^(follow|message|发消息|分享|分享主页|联系|联系方式|关注|更多)$/i.test(t)) return true;
        if (t.length <= 2) return true;
        return false;
      };

      const walkJson = (obj, depth = 0) => {
        if (depth > 14 || !obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          for (const x of obj) walkJson(x, depth + 1);
          return;
        }
        const uname = obj.username ? String(obj.username).replace(/^@/, "").toLowerCase() : null;
        if (uname === expectedHandle) {
          if (obj.biography && !result.bio) {
            result.bio = String(obj.biography).trim();
            result.source = "embedded_json";
          }
          if (obj.public_email && !result.publicEmail) {
            result.publicEmail = String(obj.public_email).trim();
          }
          if (obj.business_email && !result.businessEmail) {
            result.businessEmail = String(obj.business_email).trim();
          }
          const pk = obj.pk || obj.id;
          if (pk && !result.userId) result.userId = String(pk);
          if (obj.full_name && !result.displayName) {
            result.displayName = String(obj.full_name).trim();
          }
        }
        for (const v of Object.values(obj)) {
          if (typeof v === "object" && v) walkJson(v, depth + 1);
        }
      };

      for (const script of document.querySelectorAll('script[type="application/json"]')) {
        const text = script.textContent || "";
        if (!text.includes("biography") && !text.includes('"username"')) continue;
        try {
          walkJson(JSON.parse(text));
        } catch {
          /* ignore */
        }
      }

      result.ogDesc =
        document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
        null;

      const header = document.querySelector("header");
      if (header) {
        result.headerText = header.innerText || "";

        for (const a of header.querySelectorAll("a[href^='mailto:'], a[href^='MAILTO:']")) {
          const href = a.getAttribute("href") || "";
          if (href && !result.mailtoEmail) {
            result.mailtoEmail = href;
            result.source = result.source || "mailto_link";
          }
        }

        for (const a of header.querySelectorAll("a[href*='/followers']")) {
          const href = (a.getAttribute("href") || "").toLowerCase();
          if (!href.includes(`/${expectedHandle}/`) && !href.includes(`/${expectedHandle}`)) continue;
          const txt = (a.innerText || a.textContent || "").trim();
          const num = txt.match(/^([\d,.]+[km万]?)/i)?.[1];
          if (num) {
            result.source = result.source || "header_link";
            break;
          }
        }

        if (!result.bio) {
          const testBio = header.querySelector('[data-testid="user-bio"]');
          if (testBio) {
            const t = (testBio.innerText || testBio.textContent || "").trim();
            if (t && !isNoiseLine(t)) {
              result.bio = t;
              result.source = result.source || "header_dom";
            }
          }
        }

        if (!result.bio) {
          const headerText = (header.innerText || "").trim();
          if (headerText) {
            const lines = headerText
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            let seenStats = false;
            const bioLines = [];
            for (const line of lines) {
              if (isStatsLine(line)) {
                seenStats = true;
                continue;
              }
              if (isNoiseLine(line)) continue;
              if (
                seenStats ||
                line.includes("@") ||
                line.includes("http") ||
                line.includes(".com") ||
                line.split(/\s+/).length >= 2
              ) {
                bioLines.push(line);
              }
            }
            if (bioLines.length) {
              result.bio = bioLines.join("\n");
              result.source = result.source || "header_dom";
            }
          }
        }
      }

      return result;
    }, handle);

    if (!raw || raw.mismatchUrl) {
      if (raw?.mismatchUrl) {
        console.warn(
          `[extractInstagramProfileHeaderFromPage] @${handle} url mismatch: ${raw.mismatchUrl}`
        );
      }
      return null;
    }

    const ogStats = raw.ogDesc ? parseIgProfileStatsFromOgDescription(raw.ogDesc) : null;
    const headerStats = raw.headerText
      ? parseIgProfileStatsFromHeaderText(raw.headerText)
      : null;
    const merged = {
      followers: Math.max(ogStats?.followers || 0, headerStats?.followers || 0),
      following: Math.max(ogStats?.following || 0, headerStats?.following || 0),
      posts: Math.max(ogStats?.posts || 0, headerStats?.posts || 0),
    };
    const statsBundle = buildIgProfileStatsBundle(
      merged,
      ogStats?.followers ? "og_description" : "header_dom"
    );

    if (!raw.bio && !raw.userId && !statsBundle?.followers && !resolveHeaderContactEmail(raw)) {
      return null;
    }

    const email = resolveHeaderContactEmail(raw);
    let bio = raw.bio || undefined;
    const embeddedBio =
      raw.source === "embedded_json" && bio ? bio : null;
    if (
      bio &&
      !embeddedBio &&
      isLikelyIgPollutedHeaderDomBio(bio, handle)
    ) {
      const fromHeader = extractBioLinesFromHeaderText(raw.headerText, handle);
      bio = fromHeader || bio;
    }

    return {
      bio,
      email: email || undefined,
      userId: raw.userId || undefined,
      displayName: raw.displayName || undefined,
      followers: statsBundle?.followers,
      following: statsBundle?.following,
      postsCount: statsBundle?.postsCount,
      source: statsBundle?.source || raw.source || undefined,
    };
  } catch (e) {
    console.warn(
      `[extractInstagramProfileHeaderFromPage] @${handle}: ${e?.message || e}`
    );
    return null;
  }
}
