/**
 * YouTube 搜索 continuation 翻页（innertube /youtubei/v1/search）
 */

export function resolveYtSearchContinuationConfig() {
  return {
    maxPages: Math.min(
      Math.max(Number(process.env.YT_SEARCH_MAX_CONTINUATION_PAGES || 45), 5),
      80
    ),
    delayMs: Math.min(
      Math.max(Number(process.env.YT_SEARCH_CONTINUATION_DELAY_MS || 60), 0),
      500
    ),
    minChannelGrowthPerPage: Math.max(
      Number(process.env.YT_SEARCH_CONT_GROWTH_MIN || 2),
      0
    ),
    stallPages: Math.max(Number(process.env.YT_SEARCH_CONT_STALL_PAGES || 2), 1),
  };
}

/** 从 search / ytInitialData JSON 提取下一页 continuation token */
export function extractSearchContinuationToken(json) {
  if (!json || typeof json !== "object") return null;
  let token = null;
  const walk = (obj, depth = 0) => {
    if (token || depth > 28 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const x of obj) walk(x, depth + 1);
      return;
    }
    if (obj.continuationItemRenderer) {
      const ep = obj.continuationItemRenderer.continuationEndpoint;
      token =
        ep?.continuationCommand?.token ||
        ep?.nextContinuationData?.continuation ||
        token;
    }
    if (!token && obj.nextContinuationData?.continuation) {
      token = obj.nextContinuationData.continuation;
    }
    if (!token && Array.isArray(obj.continuations) && obj.continuations[0]) {
      const c0 = obj.continuations[0];
      token =
        c0.nextContinuationData?.continuation ||
        c0.reloadContinuationData?.continuation ||
        token;
    }
    for (const v of Object.values(obj)) {
      if (!token && typeof v === "object" && v) walk(v, depth + 1);
    }
  };
  walk(json);
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

/**
 * 在已登录的 YouTube 页面上下文内 POST continuation
 * @param {import('playwright').Page} page
 * @param {string} continuationToken
 */
export async function fetchSearchContinuationJson(page, continuationToken) {
  if (!continuationToken) return null;
  try {
    const json = await page.evaluate(async (token) => {
      const ytcfg = window.ytcfg?.data_ || {};
      const apiKey =
        ytcfg.INNERTUBE_API_KEY ||
        (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_API_KEY") : null);
      const ctx =
        ytcfg.INNERTUBE_CONTEXT ||
        (typeof ytcfg.get === "function" ? ytcfg.get("INNERTUBE_CONTEXT") : null);
      if (!apiKey || !ctx) return { __error: "missing_ytcfg" };
      const url = `/youtubei/v1/search?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ context: ctx, continuation: token }),
      });
      if (!res.ok) return { __error: `http_${res.status}` };
      return res.json();
    }, continuationToken);
    if (!json || json.__error) {
      console.warn(
        `[yt-search-pagination] continuation fetch failed: ${json?.__error || "empty"}`
      );
      return null;
    }
    return json;
  } catch (e) {
    console.warn(`[yt-search-pagination] continuation evaluate: ${e.message}`);
    return null;
  }
}

/**
 * 主动 continuation 翻页，直到无 token 或达到频道上限
 * @param {import('playwright').Page} page
 * @param {object[]} jsonSources 已捕获的原始 JSON（从新到旧扫描 token）
 * @param {(json: object) => void} onJson
 */
export async function paginateSearchViaContinuation(
  page,
  jsonSources,
  onJson,
  options = {}
) {
  const cfg = resolveYtSearchContinuationConfig();
  const maxPages = options.maxPages ?? cfg.maxPages;
  const maxChannels = options.maxChannels ?? 500;
  const delayMs = options.delayMs ?? cfg.delayMs;
  const minGrowth = options.minChannelGrowthPerPage ?? cfg.minChannelGrowthPerPage;
  const stallLimit = options.stallPages ?? cfg.stallPages;

  let token = options.startToken ?? null;
  if (!token && Array.isArray(jsonSources)) {
    for (let i = jsonSources.length - 1; i >= 0 && !token; i--) {
      token = extractSearchContinuationToken(jsonSources[i]);
    }
  }
  if (!token) return { pages: 0, lastToken: null };

  let pages = 0;
  let channelsBefore = options.getChannelCount?.() ?? 0;
  let videosBefore = options.getVideoCount?.() ?? 0;
  let stallPages = 0;

  while (token && pages < maxPages) {
    const json = await fetchSearchContinuationJson(page, token);
    if (!json) break;
    onJson(json);
    pages += 1;
    const channelsNow = options.getChannelCount?.() ?? 0;
    const videosNow = options.getVideoCount?.() ?? 0;
    if (channelsNow >= maxChannels) break;

    const channelGrowth = channelsNow - channelsBefore;
    const videoGrowth = videosNow - videosBefore;
    if (channelGrowth <= 0 && videoGrowth <= 0) {
      stallPages += 1;
      if (stallPages >= stallLimit) break;
    } else if (minGrowth > 0 && channelGrowth < minGrowth) {
      stallPages += 1;
      if (stallPages >= stallLimit) break;
    } else {
      stallPages = 0;
    }

    channelsBefore = channelsNow;
    videosBefore = videosNow;
    token = extractSearchContinuationToken(json);
    if (delayMs > 0) await page.waitForTimeout(delayMs);
  }

  return { pages, lastToken: token };
}
