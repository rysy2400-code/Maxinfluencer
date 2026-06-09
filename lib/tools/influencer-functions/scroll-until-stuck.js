/**
 * 搜索页滚动：持续下滑直到连续多轮无新内容 / 无法继续滚动。
 */

export function resolveSearchScrollConfig() {
  return {
    maxRounds: Math.min(
      Math.max(Number(process.env.SEARCH_SCROLL_MAX_ROUNDS || 80), 5),
      200
    ),
    stagnantLimit: Math.min(
      Math.max(Number(process.env.SEARCH_SCROLL_STAGNANT_ROUNDS || 3), 2),
      10
    ),
    waitMs: Math.min(
      Math.max(Number(process.env.SEARCH_SCROLL_WAIT_MS || 1500), 500),
      5000
    ),
  };
}

/** @param {import('playwright').Page} page */
export async function readScrollState(page) {
  return page.evaluate(() => {
    const selectors = [
      '[data-e2e="search-result-list"]',
      '[data-e2e="search_video-item-list"]',
      '[class*="SearchResult"]',
      '[class*="search-result"]',
      "main",
      '[role="main"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 32) {
        return {
          type: "container",
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
      }
    }
    const scrollTop =
      window.pageYOffset || document.documentElement.scrollTop || 0;
    const scrollHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const clientHeight =
      window.innerHeight || document.documentElement.clientHeight || 800;
    return { type: "window", scrollTop, scrollHeight, clientHeight };
  });
}

export function isScrollAtBottom(state, tolerance = 48) {
  if (!state) return false;
  return state.scrollTop + state.clientHeight >= state.scrollHeight - tolerance;
}

/**
 * @param {import('playwright').Page} page
 * @param {{
 *   maxRounds?: number,
 *   stagnantLimit?: number,
 *   waitMs?: number,
 *   scrollOnce: (page: import('playwright').Page, round: number) => Promise<void>,
 *   getProgress?: () => number,
 *   onRound?: (round: number, meta: object) => Promise<void> | void,
 * }} options
 */
export async function runScrollUntilStuck(page, options) {
  const cfg = resolveSearchScrollConfig();
  const maxRounds = options.maxRounds ?? cfg.maxRounds;
  const stagnantLimit = options.stagnantLimit ?? cfg.stagnantLimit;
  const waitMs = options.waitMs ?? cfg.waitMs;

  let stagnant = 0;
  let prevProgress = options.getProgress ? options.getProgress() : null;
  let prevScroll = await readScrollState(page);

  for (let round = 0; round < maxRounds; round++) {
    await options.scrollOnce(page, round);
    await page.waitForTimeout(waitMs);

    const progress = options.getProgress ? options.getProgress() : null;
    const scrollState = await readScrollState(page);
    const atBottom = isScrollAtBottom(scrollState);
    const scrollMoved =
      Math.abs((scrollState?.scrollTop || 0) - (prevScroll?.scrollTop || 0)) > 8;
    prevScroll = scrollState;

    if (options.getProgress) {
      if (progress <= prevProgress) stagnant++;
      else stagnant = 0;
      prevProgress = progress;
    } else if (!scrollMoved && atBottom) {
      stagnant++;
    } else if (!scrollMoved) {
      stagnant++;
    } else {
      stagnant = 0;
    }

    if (options.onRound) {
      await options.onRound(round, { progress, stagnant, atBottom, scrollMoved });
    }
    if (stagnant >= stagnantLimit) break;
  }
}
