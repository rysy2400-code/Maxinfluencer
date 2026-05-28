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

/**
 * 页面无响应时 page.close() 可能永久挂起；用 CDP stopLoading + 有界等待强制关页
 * @param {import('playwright').Page|null|undefined} page
 * @param {{ maxWaitMs?: number }} [opts]
 */
export async function forceCloseCdpPage(page, opts = {}) {
  if (!page) return;
  const maxWaitMs = opts.maxWaitMs ?? 4000;
  if (typeof page.isClosed === "function" && page.isClosed()) return;

  const work = async () => {
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.stopLoading");
    } catch {
      /* ignore */
    }
    try {
      await page.close({ runBeforeUnload: false });
    } catch {
      await safeCloseCdpPage(page);
    }
  };

  await Promise.race([
    work(),
    new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
  ]);
}

/**
 * @param {() => Promise<T>} fn
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 * @template T
 */
export function runWithHardTimeout(fn, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}_hard_timeout after ${ms}ms`));
    }, ms);
    fn()
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/**
 * 导航保护：硬超时 + stopLoading 强制关页 + 1 次重试（默认）。
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{
 *   label?: string,
 *   budgetMs?: number,
 *   waitUntil?: "load"|"domcontentloaded"|"networkidle"|"commit",
 *   retries?: number,
 *   createRetryPage?: ((failedPage: import('playwright').Page) => Promise<import('playwright').Page>)
 * }} [opts]
 * @returns {Promise<import('playwright').Page>}
 */
export async function guardedGoto(page, url, opts = {}) {
  const label = opts.label || "goto";
  const budgetMs = Number(opts.budgetMs || 18_000);
  const waitUntil = opts.waitUntil || "domcontentloaded";
  const retries = Math.max(0, Number(opts.retries ?? 1));
  let currentPage = page;
  let attempt = 0;

  while (attempt <= retries) {
    try {
      await runWithHardTimeout(
        () =>
          currentPage.goto(url, {
            waitUntil,
            timeout: budgetMs,
          }),
        budgetMs,
        label
      );
      return currentPage;
    } catch (e) {
      const isLast = attempt >= retries;
      try {
        await forceCloseCdpPage(currentPage, { maxWaitMs: Math.min(5000, budgetMs) });
      } catch {
        /* ignore */
      }
      if (isLast) throw e;
      if (typeof opts.createRetryPage === "function") {
        currentPage = await opts.createRetryPage(currentPage);
      } else {
        currentPage = await currentPage.context().newPage();
      }
    }
    attempt += 1;
  }
  return currentPage;
}
