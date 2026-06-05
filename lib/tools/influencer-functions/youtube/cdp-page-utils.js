/**
 * YouTube CDP 标签页：不复用历史 tab，统一从 about:blank 新建。
 */
import { openCdpContextPage } from "../../../cdp/open-cdp-page.js";
import { guardedGoto, openCdpTaskPage, isDisposableCdpTabUrl } from "../../../cdp/cdp-tab-utils.js";

/**
 * @param {string} url
 */
export function isYoutubeSearchTabUrl(url) {
  const u = String(url || "");
  return u.includes("youtube.com") && u.includes("results?search_query=");
}

/**
 * enrich 专用页（/about、/videos、频道页等）
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
  const page = await openCdpTaskPage(context);
  console.log(`${logPrefix} 新建搜索标签页（about:blank，任务结束将关闭）`);
  return { page, created: true };
}

/**
 * @deprecated 使用 acquireYoutubeSearchPage / openCdpTaskPage
 */
export async function acquireVisibleCdpPage(context, opts = {}) {
  return acquireYoutubeSearchPage(context, opts);
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
 * enrich 完成后关闭临时标签
 * @param {import('playwright').Page|null} page
 * @param {{ force?: boolean }} [opts]
 */
export async function closeYoutubeEnrichTabIfNeeded(page, opts = {}) {
  if (!page || page.isClosed()) return;
  try {
    const u = page.url();
    if (opts.force || isYoutubeEnrichTabUrl(u) || isDisposableCdpTabUrl(u)) {
      await page.close();
      console.log(`[yt-cdp] 已关闭 enrich 标签: ${u.slice(0, 72)}`);
    }
  } catch {
    /* ignore */
  }
}
