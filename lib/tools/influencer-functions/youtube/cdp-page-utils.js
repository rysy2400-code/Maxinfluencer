/**
 * YouTube CDP 标签页策略：搜索与 enrich 分离，避免 /about、/videos 污染搜索 goto
 */
import { openCdpContextPage } from "../../../cdp/open-cdp-page.js";
import { guardedGoto } from "../../../cdp/cdp-tab-utils.js";

/**
 * @param {string} url
 */
export function isYoutubeSearchTabUrl(url) {
  const u = String(url || "");
  return u.includes("youtube.com") && u.includes("results?search_query=");
}

/**
 * enrich 专用页（/about、/videos、频道页等），不可用于关键词搜索 goto
 * @param {string} url
 */
export function isYoutubeEnrichTabUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u.includes("youtube.com")) return false;
  if (isYoutubeSearchTabUrl(u)) return false;
  if (u.includes("/about")) return true;
  if (/\/videos(\?|$|\/)/.test(u)) return true;
  if (u.includes("/shorts")) return true;
  if (u.includes("/watch")) return true;
  if (u.includes("/channel/")) return true;
  if (u.includes("/@") && !u.includes("results?")) return true;
  return false;
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ logPrefix?: string }} [opts]
 * @returns {Promise<{ page: import('playwright').Page, created: boolean }>}
 */
export async function acquireYoutubeSearchPage(context, opts = {}) {
  const logPrefix = opts.logPrefix || "[yt-cdp-search]";
  const pages = context.pages().filter((p) => !p.isClosed());

  let page = pages.find((p) => {
    try {
      return isYoutubeSearchTabUrl(p.url());
    } catch {
      return false;
    }
  });

  let created = false;
  if (!page) {
    page = await openCdpContextPage(context);
    created = true;
    console.log(`${logPrefix} 新建搜索标签页（任务结束将关闭）`);
  } else {
    console.log(`${logPrefix} 复用搜索标签: ${page.url().slice(0, 80)}`);
  }

  try {
    await page.bringToFront();
  } catch (e) {
    console.warn(`${logPrefix} bringToFront 失败:`, e.message);
  }

  return { page, created };
}

/**
 * enrich 阶段复用非搜索、非 about 的 youtube 标签，或新建
 * @param {import('playwright').BrowserContext} context
 * @param {{ logPrefix?: string }} [opts]
 * @returns {Promise<{ page: import('playwright').Page, created: boolean }>}
 */
export async function acquireVisibleCdpPage(context, opts = {}) {
  const logPrefix = opts.logPrefix || "[yt-cdp]";
  const pages = context.pages().filter((p) => !p.isClosed());

  let page =
    pages.find((p) => {
      try {
        const u = p.url();
        return u.includes("youtube.com") && !isYoutubeEnrichTabUrl(u);
      } catch {
        return false;
      }
    }) ||
    pages.find((p) => {
      try {
        const u = p.url();
        return (
          u.includes("youtube.com") &&
          !isYoutubeSearchTabUrl(u) &&
          !String(u).toLowerCase().includes("/about")
        );
      } catch {
        return false;
      }
    }) ||
    pages.find((p) => {
      try {
        const u = p.url();
        return u.startsWith("http") && !u.startsWith("chrome://");
      } catch {
        return false;
      }
    });

  let created = false;
  if (!page) {
    page = await openCdpContextPage(context);
    created = true;
    console.log(`${logPrefix} 新建标签页（任务结束将关闭）`);
  } else {
    console.log(`${logPrefix} 复用标签页: ${page.url().slice(0, 80)}`);
  }

  try {
    await page.bringToFront();
  } catch (e) {
    console.warn(`${logPrefix} bringToFront 失败:`, e.message);
  }

  return { page, created };
}

/**
 * 导航到搜索 URL；失败则关闭问题页并新开标签重试
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{ logPrefix?: string }} [opts]
 * @returns {Promise<import('playwright').Page>}
 */
export async function gotoYoutubeSearchUrl(page, url, opts = {}) {
  const logPrefix = opts.logPrefix || "[yt-cdp-search]";
  const context = page.context();
  const out = await guardedGoto(page, url, {
    label: `${logPrefix}_search`,
    budgetMs: 18_000,
    waitUntil: "domcontentloaded",
    retries: 1,
    createRetryPage: async () => openCdpContextPage(context),
  });
  if (out !== page) console.log(`${logPrefix} 新标签 goto 成功`);
  return out;
}

/**
 * enrich 完成后关闭 /about 等临时标签（若由调用方标记）
 * @param {import('playwright').Page|null} page
 * @param {{ force?: boolean }} [opts]
 */
export async function closeYoutubeEnrichTabIfNeeded(page, opts = {}) {
  if (!page || page.isClosed()) return;
  try {
    const u = page.url();
    if (opts.force || isYoutubeEnrichTabUrl(u)) {
      await page.close();
      console.log(`[yt-cdp] 已关闭 enrich 标签: ${u.slice(0, 72)}`);
    }
  } catch {
    /* ignore */
  }
}
