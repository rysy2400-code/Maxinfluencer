import { getCdpLoopStore, newLoopPage } from "./cdp-loop-context.js";

/**
 * 并行 loop 下登记 Tab；否则普通 newPage。
 * @param {import('playwright').BrowserContext} context
 */
export async function openCdpContextPage(context) {
  if (getCdpLoopStore()) {
    return newLoopPage(context);
  }
  return context.newPage();
}
