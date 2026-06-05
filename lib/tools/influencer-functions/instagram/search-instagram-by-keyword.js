/**
 * Instagram 关键词搜索（9222 CDP，需登录）
 */

import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { extractInstagramSearchResultsFromPageCDP } from "./extract-instagram-search-results-cdp.js";
import { acquireVisibleCdpPage } from "./cdp-page-utils.js";
import { withCdp9222PreparedSession } from "../../../cdp/connect-cdp-9222.js";
import { closeCdpTaskPage } from "../../../cdp/cdp-tab-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getUserDataDir() {
  return path.join(__dirname, "../../../../.instagram-user-data");
}

/**
 * @param {{ keywords?: { search_queries?: string[] }, campaignInfo?: object }} params
 * @param {{ onStepUpdate?: Function, searchOptions?: object }} [options]
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

  sendStep("启动浏览器", "正在通过 CDP 连接浏览器（Instagram 搜索需已登录）...");

  if (USE_HEADLESS) {
    const userDataDir = getUserDataDir();
    const browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1920, height: 1080 },
    });
    const page = await browser.newPage();
    try {
      return await runInstagramSearch(page, searchQueries[0], {
        sendStep,
        onStepUpdate,
        searchOptions,
      });
    } finally {
      await closeCdpTaskPage(page);
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }

  return withCdp9222PreparedSession(
    { platform: "instagram", phase: "search" },
    async ({ context }) => {
      const acquired = await acquireVisibleCdpPage(context, {
        logPrefix: "[searchInstagramByKeyword]",
      });
      const page = acquired.page;
      try {
        return await runInstagramSearch(page, searchQueries[0], {
          sendStep,
          onStepUpdate,
          searchOptions,
        });
      } finally {
        await closeCdpTaskPage(page);
      }
    }
  );
}

async function runInstagramSearch(page, firstKeyword, { sendStep, onStepUpdate, searchOptions }) {
  console.log(`[searchInstagramByKeyword] 关键词: ${firstKeyword}`);

  const searchData = await extractInstagramSearchResultsFromPageCDP(page, firstKeyword, {
    onStepUpdate,
    maxInfluencers: searchOptions.maxInfluencers,
    scrollRounds: searchOptions.scrollRounds,
  });

  if (
    !searchData.success ||
    (searchData.videos.length === 0 && searchData.influencerRecords.length === 0)
  ) {
    throw new Error(
      `Instagram API 未获取到数据: ${searchData.influencerRecords.length} 红人, ${searchData.videos.length} 帖子`
    );
  }

  sendStep(
    "搜索完成",
    `Instagram: ${searchData.influencerRecords.length} 红人, ${searchData.videos.length} 帖子`
  );

  try {
    const logsDir = path.join(__dirname, "../../../../logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(
      path.join(logsDir, `search-instagram-${ts}.json`),
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
    console.warn("[searchInstagramByKeyword] 写日志失败:", e.message);
  }

  return {
    influencerRecords: searchData.influencerRecords,
    videos: searchData.videos,
    stats: {
      totalTime: "0",
      videoCount: searchData.videos.length,
      influencerCount: searchData.influencerRecords.length,
      platform: "Instagram",
    },
  };
}
