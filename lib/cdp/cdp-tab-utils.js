/**
 * 9222 CDP 自动化标签页清理：避免 about:blank 无限堆积
 */

/**
 * @param {string} [url]
 */
export function isDisposableCdpTabUrl(url) {
  const u = String(url || "").trim();
  return (
    !u ||
    u === "about:blank" ||
    u.startsWith("chrome://newtab") ||
    u === "chrome://new-tab-page/"
  );
}

/**
 * @param {import('playwright').Page|null|undefined} page
 */
export async function safeCloseCdpPage(page) {
  if (!page) return;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return;
    await page.close();
  } catch {
    /* ignore */
  }
}

/**
 * 仅关闭本次任务新建、或明显为空白/失败导航的临时标签
 * @param {import('playwright').Page|null|undefined} page
 * @param {{ created?: boolean, force?: boolean }} [opts]
 */
export async function closeDisposableCdpPage(page, opts = {}) {
  if (!page) return;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return;
    const url = page.url();
    if (opts.force || opts.created || isDisposableCdpTabUrl(url)) {
      await page.close();
    }
  } catch {
    /* ignore */
  }
}
