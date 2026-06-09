/**
 * YouTube 关键词搜索（9222 CDP，需登录 Google/YouTube）
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { extractYoutubeSearchResultsFromPageCDP } from "./extract-youtube-search-results-cdp.js";
import { acquireYoutubeSearchPage } from "./cdp-page-utils.js";
import { withCdp9222PreparedSession } from "../../../cdp/connect-cdp-9222.js";
import { closeCdpTaskPage } from "../../../cdp/cdp-tab-utils.js";

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

  return withCdp9222PreparedSession(
    { platform: "youtube", phase: "search" },
    async ({ context }) => {
      const acquired = await acquireYoutubeSearchPage(context, {
        logPrefix: "[searchYoutubeByKeyword]",
      });
      let page = acquired.page;

      try {
        const firstKeyword = searchQueries[0];
        console.log(`[searchYoutubeByKeyword] 关键词: ${firstKeyword}`);

        const searchData = await extractYoutubeSearchResultsFromPageCDP(
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
          if (searchData.workPage !== page) {
            await closeCdpTaskPage(page);
          }
          page = searchData.workPage;
        }

        if (!searchData.success || searchData.influencerRecords.length === 0) {
          throw new Error(
            `YouTube API 未获取到频道: ${searchData.influencerRecords.length} 频道`
          );
        }

        sendStep(
          "搜索完成",
          `YouTube: ${searchData.influencerRecords.length} 频道`
        );

        try {
          const logsDir = path.join(__dirname, "../../../../logs");
          if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          fs.writeFileSync(
            path.join(logsDir, `search-youtube-${ts}.json`),
            JSON.stringify(
              {
                timestamp: new Date().toISOString(),
                keyword: firstKeyword,
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
            totalTime: "0",
            videoCount: searchData.videos.length,
            influencerCount: searchData.influencerRecords.length,
            platform: "YouTube",
          },
        };
      } finally {
        await closeCdpTaskPage(page);
      }
    }
  );
}
