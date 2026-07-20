/**
 * Instagram 关键词搜索（9222 CDP，需登录）
 */

import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { extractInstagramSearchResultsFromPageCDP } from "./extract-instagram-search-results-cdp.js";
import { extractInstagramSearchLite } from "./extract-instagram-search-lite.js";
import { acquireVisibleCdpPage } from "./cdp-page-utils.js";
import { withCdp9222PreparedSession } from "../../../cdp/connect-cdp-9222.js";
import { closeCdpTaskPage } from "../../../cdp/cdp-tab-utils.js";
import { isLiteScraperMode } from "../../../scraper/resolve-scraper-mode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getUserDataDir() {
  return path.join(__dirname, "../../../../.instagram-user-data");
}

/**
 * @param {{ keywords?: { search_queries?: string[] }, campaignInfo?: object }} params
 * @param {{ onStepUpdate?: Function, searchOptions?: object, context?: import('playwright').BrowserContext }} [options]
 */
export async function searchInstagramByKeyword(params = {}, options = {}) {
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
    `正在通过 CDP 连接浏览器（Instagram 搜索需已登录）${liteMode ? " [Lite]" : ""}...`
  );

  const runInContext = async (context, pageOverride = null) => {
    const firstKeyword = searchQueries[0];
    console.log(
      `[searchInstagramByKeyword] 关键词: ${firstKeyword} mode=${liteMode ? "lite" : "standard"}`
    );

    let searchData;
    let liteSession = null;
    let page = pageOverride;

    try {
      if (liteMode) {
        searchData = await extractInstagramSearchLite(context, firstKeyword, {
          onStepUpdate,
          maxInfluencers: searchOptions.maxInfluencers || searchOptions.maxChannels,
          scrollUntilStuck: searchOptions.scrollUntilStuck,
        });
        liteSession = searchData.session;
        page = searchData.workPage;
      } else {
        if (!page) {
          const acquired = await acquireVisibleCdpPage(context, {
            logPrefix: "[searchInstagramByKeyword]",
          });
          page = acquired.page;
        }
        searchData = await extractInstagramSearchResultsFromPageCDP(page, firstKeyword, {
          onStepUpdate,
          maxInfluencers: searchOptions.maxInfluencers,
          scrollRounds: searchOptions.scrollRounds,
          scrollUntilStuck: searchOptions.scrollUntilStuck,
        });
      }

      if (
        !searchData.success ||
        (searchData.videos.length === 0 && searchData.influencerRecords.length === 0)
      ) {
        sendStep("搜索无结果", `Instagram 关键词「${firstKeyword}」未搜索到红人，跳过 enrich`);
        return {
          influencerRecords: [],
          videos: [],
          stats: {
            ...(searchData.stats || {}),
            totalTime: "0",
            videoCount: 0,
            influencerCount: 0,
            platform: "Instagram",
            scraperMode: liteMode ? "lite" : "standard",
            emptySearch: true,
          },
          instagramLiteSession: liteSession,
          emptySearch: true,
        };
      }

      sendStep(
        "搜索完成",
        `Instagram${liteMode ? " Lite" : ""}: ${searchData.influencerRecords.length} 红人, ${searchData.videos.length} 帖子`
      );

      try {
        const logsDir = path.join(__dirname, "../../../../logs");
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(
          path.join(logsDir, `search-instagram-${liteMode ? "lite-" : ""}${ts}.json`),
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
        console.warn("[searchInstagramByKeyword] 写日志失败:", e.message);
      }

      return {
        influencerRecords: searchData.influencerRecords,
        videos: searchData.videos,
        stats: {
          ...(searchData.stats || {}),
          totalTime: "0",
          videoCount: searchData.videos.length,
          influencerCount: searchData.influencerRecords.length,
          platform: "Instagram",
          scraperMode: liteMode ? "lite" : "standard",
        },
        instagramLiteSession: liteSession,
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
    const page = await browser.newPage();
    try {
      return await runInContext(browser, page);
    } finally {
      await closeCdpTaskPage(page);
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }

  if (liteMode) {
    return runInContext(null);
  }

  return withCdp9222PreparedSession(
    { platform: "instagram", phase: liteMode ? "search-lite" : "search" },
    async ({ context }) => {
      const acquired = await acquireVisibleCdpPage(context, {
        logPrefix: "[searchInstagramByKeyword]",
      });
      return runInContext(context, acquired.page);
    }
  );
}
