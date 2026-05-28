/**
 * CDP 连接后让自动化标签页在前台可见（避免用户看到 9222 窗口停在 newtab 无动作）
 */
import { openCdpContextPage } from "../../../cdp/open-cdp-page.js";

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ reuseInstagramTab?: boolean, logPrefix?: string }} [opts]
 * @returns {Promise<{ page: import('playwright').Page, created: boolean }>}
 */
export async function acquireVisibleCdpPage(context, opts = {}) {
  const logPrefix = opts.logPrefix || "[ig-cdp]";
  const pages = context.pages().filter((p) => !p.isClosed());

  let page = null;
  if (opts.reuseInstagramTab) {
    page = pages.find((p) => {
      try {
        return p.url().includes("instagram.com");
      } catch {
        return false;
      }
    });
  }

  if (!page && pages.length > 0 && !opts.reuseInstagramTab) {
    page = pages.find((p) => {
      try {
        const u = p.url();
        return u.startsWith("http") && !u.startsWith("chrome://");
      } catch {
        return false;
      }
    });
  }

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
