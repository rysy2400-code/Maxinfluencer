/**
 * 单进程多 platform loop 并行时：每个 loop 只登记并操作自己 newPage 的 Tab。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const cdpLoopAls = new AsyncLocalStorage();

/**
 * @returns {{ platform?: string, taskId?: number, workerId?: string, ownedPages: Set<import('playwright').Page> }|undefined}
 */
export function getCdpLoopStore() {
  return cdpLoopAls.getStore();
}

/**
 * @param {object} meta
 * @param {() => Promise<unknown>} fn
 */
export async function runInCdpLoop(meta, fn) {
  const ownedPages = new Set();
  return cdpLoopAls.run({ ...meta, ownedPages }, async () => {
    try {
      return await fn();
    } finally {
      await closeAllLoopPages();
    }
  });
}

/**
 * @param {import('playwright').BrowserContext} context
 */
export async function newLoopPage(context) {
  const page = await context.newPage();
  const store = getCdpLoopStore();
  if (store) store.ownedPages.add(page);
  return page;
}

export async function closeAllLoopPages() {
  const store = getCdpLoopStore();
  if (!store?.ownedPages?.size) return;
  for (const page of store.ownedPages) {
    try {
      if (page && !page.isClosed()) await page.close();
    } catch {
      /* ignore */
    }
  }
  store.ownedPages.clear();
}
