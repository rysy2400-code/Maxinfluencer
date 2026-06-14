/**
 * TikTok 关键词搜索（9222 CDP，登录态；Lite 模式 API 直调）
 */

import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { extractSearchResultsFromPageCDP } from "../extract-search-results-cdp.js";
import { extractTiktokSearchLite } from "./extract-tiktok-search-lite.js";
import { withCdp9222PreparedSession } from "../../../cdp/connect-cdp-9222.js";
import { openCdpTaskPage, closeCdpTaskPage } from "../../../cdp/cdp-tab-utils.js";
import { isLiteScraperMode } from "../../../scraper/resolve-scraper-mode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getUserDataDir() {
  return path.join(__dirname, "../../../../.tiktok-user-data");
}

/**
 * @param {{ keywords?: { search_queries?: string[] }, campaignInfo?: object }} params
 * @param {{ onStepUpdate?: Function, searchOptions?: object, context?: import('playwright').BrowserContext }} [options]
 */
export async function searchTiktokByKeyword(params = {}, options = {}) {
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
  const liteMode = isLiteScraperMode();

  sendStep(
    "启动浏览器",
    `正在通过 CDP 连接浏览器（TikTok 搜索需 9222 登录态）${liteMode ? " [Lite]" : ""}...`
  );

  const runInContext = async (context) => {
    const firstKeyword = searchQueries[0];
    console.log(
      `[searchTiktokByKeyword] 关键词: ${firstKeyword} mode=${liteMode ? "lite" : "standard"}`
    );

    let searchData;
    let liteSession = null;
    let page = null;

    try {
      if (liteMode) {
        searchData = await extractTiktokSearchLite(context, firstKeyword, {
          onStepUpdate,
          maxInfluencers: searchOptions.maxInfluencers || searchOptions.maxChannels,
        });
        liteSession = searchData.session;
        page = searchData.workPage;
      } else {
        page = await openCdpTaskPage(context);
        const standard = await extractSearchResultsFromPageCDP(page, firstKeyword, {
          onStepUpdate,
          maxInfluencers: searchOptions.maxInfluencers,
          scrollRounds: searchOptions.scrollRounds,
          scrollUntilStuck: searchOptions.scrollUntilStuck,
        });
        searchData = {
          success: standard.success,
          influencerRecords: standard.influencers || [],
          videos: standard.videos || [],
          stats: standard.interceptedApis || {},
          searchUrl: `https://www.tiktok.com/search/video?q=${encodeURIComponent(firstKeyword)}`,
        };
      }

      if (
        !searchData.success &&
        searchData.influencerRecords.length === 0 &&
        searchData.videos.length === 0
      ) {
        throw new Error(
          `TikTok API 未获取到数据: ${searchData.influencerRecords.length} 红人, ${searchData.videos.length} 视频`
        );
      }

      sendStep(
        "搜索完成",
        `TikTok${liteMode ? " Lite" : ""}: ${searchData.influencerRecords.length} 红人, ${searchData.videos.length} 视频`
      );

      try {
        const logsDir = path.join(__dirname, "../../../../logs");
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(
          path.join(logsDir, `search-tiktok-${liteMode ? "lite-" : ""}${ts}.json`),
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
        console.warn("[searchTiktokByKeyword] 写日志失败:", e.message);
      }

      return {
        influencerRecords: searchData.influencerRecords,
        videos: searchData.videos,
        stats: {
          ...(searchData.stats || {}),
          totalTime: "0",
          videoCount: searchData.videos.length,
          influencerCount: searchData.influencerRecords.length,
          platform: "TikTok",
          scraperMode: liteMode ? "lite" : "standard",
        },
        tiktokLiteSession: liteSession,
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

  if (USE_HEADLESS) {
    const userDataDir = getUserDataDir();
    const browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1920, height: 1080 },
    });
    try {
      return await runInContext(browser);
    } finally {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }

  return withCdp9222PreparedSession(
    { platform: "tiktok", phase: liteMode ? "search-lite" : "search" },
    async ({ context }) => runInContext(context)
  );
}
