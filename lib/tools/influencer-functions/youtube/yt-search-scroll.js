/**
 * YouTube 搜索页滚动：在 API 延迟场景下避免过早停止
 */

import { readScrollState, isScrollAtBottom, resolveSearchScrollConfig } from "../scroll-until-stuck.js";

export function resolveYtSearchScrollConfig() {
  return {
    skipScrollMinChannels: Math.max(
      Number(process.env.YT_SEARCH_SKIP_SCROLL_MIN_CHANNELS || 120),
      20
    ),
    fastScrollMaxRounds: Math.min(
      Math.max(Number(process.env.YT_SEARCH_FAST_SCROLL_ROUNDS || 6), 2),
      20
    ),
    minScrollRounds: Math.min(
      Math.max(Number(process.env.YT_SEARCH_MIN_SCROLL_ROUNDS || 3), 1),
      10
    ),
    apiWaitMs: Math.min(
      Math.max(Number(process.env.YT_API_WAIT_MS || 3500), 1500),
      15000
    ),
    scrollPostWaitMs: Math.min(
      Math.max(Number(process.env.YT_SEARCH_SCROLL_POST_MS || 150), 0),
      2000
    ),
    gotoSettleMs: Math.min(
      Math.max(Number(process.env.YT_SEARCH_GOTO_SETTLE_MS || 1000), 500),
      5000
    ),
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {{
 *   scrollOnce: () => Promise<void>,
 *   getSnapshot: () => string,
 *   minRounds?: number,
 *   maxRounds?: number,
 *   stagnantLimit?: number,
 *   onRound?: (round: number, meta: object) => void,
 * }} options
 */
export async function runYoutubeSearchScrollUntilStuck(page, options) {
  const cfg = resolveSearchScrollConfig();
  const maxRounds = Math.min(
    Math.max(
      Number(options.maxRounds ?? process.env.YT_SEARCH_MAX_SCROLL_ROUNDS ?? cfg.maxRounds),
      5
    ),
    200
  );
  const ytCfg = resolveYtSearchScrollConfig();
  const minRounds = Math.min(
    Math.max(
      Number(options.minRounds ?? ytCfg.minScrollRounds),
      1
    ),
    maxRounds
  );
  const stagnantLimit = Math.min(
    Math.max(
      Number(options.stagnantLimit ?? process.env.SEARCH_SCROLL_STAGNANT_ROUNDS ?? cfg.stagnantLimit),
      2
    ),
    15
  );
  const waitMs = cfg.waitMs;

  let stagnant = 0;
  let prevSnapshot = options.getSnapshot();
  let roundsDone = 0;

  for (let round = 0; round < maxRounds; round++) {
    roundsDone = round + 1;
    await options.scrollOnce();
    await page.waitForTimeout(waitMs);

    const snapshot = options.getSnapshot();
    const scrollState = await readScrollState(page);
    const atBottom = isScrollAtBottom(scrollState);

    if (round + 1 < minRounds) {
      stagnant = 0;
    } else if (snapshot === prevSnapshot) {
      stagnant += 1;
    } else {
      stagnant = 0;
    }
    prevSnapshot = snapshot;

    if (options.onRound) {
      await options.onRound(round, { snapshot, stagnant, atBottom });
    }

    if (round + 1 >= minRounds && stagnant >= stagnantLimit) {
      break;
    }
  }

  return { roundsDone, stagnant };
}
