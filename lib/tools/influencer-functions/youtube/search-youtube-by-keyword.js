/**
 * YouTube 关键词搜索（9222 CDP，需登录 Google/YouTube）
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { extractYoutubeSearchResultsFromPageCDP } from "./extract-youtube-search-results-cdp.js";
import { extractYoutubeSearchLite } from "./extract-youtube-search-lite.js";
import { acquireYoutubeSearchPage } from "./cdp-page-utils.js";
import { withCdp9222PreparedSession } from "../../../cdp/connect-cdp-9222.js";
import { closeCdpTaskPage } from "../../../cdp/cdp-tab-utils.js";
import { isLiteScraperMode } from "../../../scraper/resolve-scraper-mode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {{ keywords?: { search_queries?: string[] }, campaignInfo?: object }} params
 * @param {{ onStepUpdate?: Function, searchOptions?: object }} [options]
 */
export async function searchYoutubeByKeyword(params = {}, options = {}) {
  const { keywords = {} } = params;
  const { onStepUpdate = null, searchOptions = {} } = options;

  const sendStep = (step, message) => {
    try {
      onStepUpdate?.({ step, message });
    } catch {
      /* ignore */
    }
  };

  const searchQueries = keywords.search_queries || [];
  if (!searchQueries.length) throw new Error("没有提供搜索关键词");

  const USE_HEADLESS = process.env.PLAYWRIGHT_HEADLESS === "true";
  if (USE_HEADLESS) {
    throw new Error("YouTube 搜索暂不支持无头模式，请使用 9222 CDP");
  }

  sendStep("启动浏览器", "正在通过 CDP 连接浏览器（YouTube 搜索需已登录）...");

  const liteMode = isLiteScraperMode();

  const runInContext = async (context) => {
      const firstKeyword = searchQueries[0];
      console.log(
        `[searchYoutubeByKeyword] 关键词: ${firstKeyword} mode=${liteMode ? "lite" : "standard"}`
      );

      let searchData;
      let liteSession = null;
      let page = null;

      try {
        if (liteMode) {
          searchData = await extractYoutubeSearchLite(context, firstKeyword, {
            onStepUpdate,
            maxChannels:
              searchOptions.maxChannels || searchOptions.maxInfluencers,
            scrollUntilStuck: searchOptions.scrollUntilStuck,
          });
          liteSession = searchData.session;
          page = searchData.workPage;
        } else {
          const acquired = await acquireYoutubeSearchPage(context, {
            logPrefix: "[searchYoutubeByKeyword]",
          });
          page = acquired.page;
          searchData = await extractYoutubeSearchResultsFromPageCDP(
            page,
            firstKeyword,
            {
              onStepUpdate,
              maxChannels: searchOptions.maxChannels,
              scrollRounds: searchOptions.scrollRounds,
              scrollUntilStuck: searchOptions.scrollUntilStuck,
            }
          );
          if (searchData.workPage && searchData.workPage !== page) {
            await closeCdpTaskPage(page);
            page = searchData.workPage;
          }
        }

        if (
          !searchData.success ||
          (searchData.videos.length === 0 && searchData.influencerRecords.length === 0)
        ) {
          sendStep("搜索无结果", `YouTube 关键词「${firstKeyword}」未搜索到频道，跳过 enrich`);
          return {
            influencerRecords: [],
            videos: [],
            stats: searchData.stats || {},
            success: false,
            error: "no_youtube_search_results",
            youtubeLiteSession: liteSession,
          };
        }

        sendStep(
          "搜索完成",
          `YouTube${liteMode ? " Lite" : ""}: ${searchData.influencerRecords.length} 频道`
        );

        try {
          const logsDir = path.join(__dirname, "../../../../logs");
          if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          fs.writeFileSync(
            path.join(logsDir, `search-youtube-${liteMode ? "lite-" : ""}${ts}.json`),
            JSON.stringify(
              {
                timestamp: new Date().toISOString(),
                keyword: firstKeyword,
                mode: liteMode ? "lite" : "standard",
                searchUrl: searchData.searchUrl,
                stats: searchData.stats,
                influencerRecords: searchData.influencerRecords,
              },
              null,
              2
            ),
            "utf-8"
          );
        } catch (e) {
          console.warn("[searchYoutubeByKeyword] 写日志失败:", e.message);
        }

        return {
          influencerRecords: searchData.influencerRecords,
          videos: searchData.videos,
          stats: {
            ...(searchData.stats || {}),
            totalTime: "0",
            videoCount: searchData.videos.length,
            influencerCount: searchData.influencerRecords.length,
            platform: "YouTube",
            scraperMode: liteMode ? "lite" : "standard",
          },
          /** Lite 搜索会话，enrich 阶段可复用同一 innertube 页（须在未断开 CDP 时使用） */
          youtubeLiteSession: liteSession,
        };
      } finally {
        if (!liteMode && page) {
          await closeCdpTaskPage(page);
        }
      }
  };

  if (options.context) {
    return runInContext(options.context);
  }

  return withCdp9222PreparedSession(
    { platform: "youtube", phase: liteMode ? "search-lite" : "search" },
    async ({ context }) => runInContext(context)
  );
}
