/**
 * CDP：优先复用已打开的 YouTube 标签页
 */

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ logPrefix?: string }} [opts]
 */
export async function acquireVisibleCdpPage(context, opts = {}) {
  const logPrefix = opts.logPrefix || "[yt-cdp]";
  const pages = context.pages().filter((p) => !p.isClosed());

  let page =
    pages.find((p) => {
      try {
        return p.url().includes("youtube.com");
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

  if (!page) {
    page = await context.newPage();
    console.log(`${logPrefix} 新建标签页`);
  } else {
    console.log(`${logPrefix} 复用标签页: ${page.url().slice(0, 80)}`);
  }

  try {
    await page.bringToFront();
  } catch (e) {
    console.warn(`${logPrefix} bringToFront 失败:`, e.message);
  }

  return page;
}
