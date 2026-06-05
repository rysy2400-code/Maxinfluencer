/**
 * Instagram CDP 任务页：不复用历史 tab，统一从 about:blank 新建。
 */
import { openCdpTaskPage } from "../../../cdp/cdp-tab-utils.js";

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ logPrefix?: string }} [opts]
 * @returns {Promise<{ page: import('playwright').Page, created: boolean }>}
 */
export async function acquireVisibleCdpPage(context, opts = {}) {
  const logPrefix = opts.logPrefix || "[ig-cdp]";
  const page = await openCdpTaskPage(context);
  console.log(`${logPrefix} 新建任务标签页（about:blank，任务结束将关闭）`);
  return { page, created: true };
}
