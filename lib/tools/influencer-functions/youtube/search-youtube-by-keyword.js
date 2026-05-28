/**
 * YouTube 关键词搜索（9222 CDP，需登录 Google/YouTube）
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { extractYoutubeSearchResultsFromPageCDP } from "./extract-youtube-search-results-cdp.js";
import { acquireYoutubeSearchPage } from "./cdp-page-utils.js";
import { connectCdp9222 } from "../../../cdp/connect-cdp-9222.js";

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

  let browser = null;

  sendStep("启动浏览器", "正在通过 CDP 连接浏览器（YouTube 搜索需已登录）...");

  if (USE_HEADLESS) {
    throw new Error("YouTube 搜索暂不支持无头模式，请使用 9222 CDP");
  }

  let connectError = null;
  for (let retry = 0; retry < 3; retry++) {
    try {
      browser = await connectCdp9222({ platform: "youtube", phase: "search" });
      break;
    } catch (e) {
      connectError = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!browser) {
    throw new Error(
      `CDP 连接失败: ${connectError?.message || "unknown"}（请启动 9222 并登录 YouTube）`
    );
  }

  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await acquireYoutubeSearchPage(context, {
    logPrefix: "[searchYoutubeByKeyword]",
  });

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
      }
    );

    if (
      !searchData.success ||
      searchData.influencerRecords.length === 0
    ) {
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
    if (browser) {
      try {
        if (typeof browser.disconnect === "function") {
          await browser.disconnect();
        } else {
          await browser.close();
        }
      } catch {
        /* ignore */
      }
    }
  }
}
