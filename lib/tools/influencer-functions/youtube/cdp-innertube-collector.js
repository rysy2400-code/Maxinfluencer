/**
 * YouTube innertube 数据 API 拦截（仅 search / browse / next）
 */

/** @typedef {"search"|"browse"|"next"} InnertubeKind */

/**
 * @param {string} url
 * @returns {InnertubeKind|null}
 */
export function innertubeEndpointKind(url) {
  const u = String(url || "");
  if (!u.includes("youtube.com") || !u.includes("/youtubei/v1/")) return null;
  if (u.includes("/youtubei/v1/search")) return "search";
  if (u.includes("/youtubei/v1/browse")) return "browse";
  if (u.includes("/youtubei/v1/next")) return "next";
  return null;
}

export function isYoutubeDataInnertubeUrl(url) {
  return innertubeEndpointKind(url) != null;
}

/**
 * api_only | api_first | initial_only（默认 api_first：API 无数据时回退 ytInitialData）
 */
export function resolveYtExtractMode() {
  const m = String(process.env.YT_EXTRACT_MODE || "api_first")
    .trim()
    .toLowerCase();
  if (m === "api_first" || m === "api-first") return "api_first";
  if (m === "initial_only" || m === "ytinitial_only") return "initial_only";
  return "api_only";
}

/**
 * @param {import('playwright').Page} page
 */
export function attachInnertubeCollector(page) {
  /** @type {{ kind: InnertubeKind, json: object, url: string }[]} */
  const pending = [];
  let totalResponses = 0;

  const handler = async (response) => {
    const kind = innertubeEndpointKind(response.url());
    if (!kind) return;
    try {
      const text = await response.text();
      if (!text || text[0] !== "{") return;
      const json = JSON.parse(text);
      pending.push({ kind, json, url: response.url() });
      totalResponses += 1;
    } catch {
      /* ignore */
    }
  };

  page.on("response", handler);

  return {
    /** @returns {{ kind: InnertubeKind, json: object, url: string }[]} */
    drain() {
      return pending.splice(0, pending.length);
    },

    /**
     * 等待至少一条数据 API 响应（滚动后调用）
     * @param {InnertubeKind|InnertubeKind[]|null} kinds
     * @param {{ timeoutMs?: number }} [opts]
     */
    async waitFor(kinds = null, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 12000;
      const want = kinds
        ? Array.isArray(kinds)
          ? kinds
          : [kinds]
        : ["search", "browse", "next"];
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pending.some((b) => want.includes(b.kind))) {
          return this.drain();
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return this.drain();
    },

    stats() {
      return { totalResponses, pending: pending.length };
    },

    detach() {
      page.off("response", handler);
    },
  };
}

/**
 * @param {import('playwright').Page} page
 */
export async function readYtInitialDataFromPage(page) {
  try {
    return await page.evaluate(() => {
      for (const s of Array.from(document.querySelectorAll("script"))) {
        if (s.textContent && s.textContent.includes("ytInitialData")) {
          const m = s.textContent.match(/var ytInitialData = (\{.+\});/s);
          if (m) {
            try {
              return JSON.parse(m[1]);
            } catch {
              return null;
            }
          }
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}
