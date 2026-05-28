/**
 * Instagram 关键词搜索（9222 CDP，需登录）
 */

import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { extractInstagramSearchResultsFromPageCDP } from "./extract-instagram-search-results-cdp.js";
import { acquireVisibleCdpPage } from "./cdp-page-utils.js";
import { connectCdp9222 } from "../../../cdp/connect-cdp-9222.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getUserDataDir() {
  return path.join(__dirname, "../../../../.instagram-user-data");
}

/**
 * @param {{ keywords?: { search_queries?: string[] }, campaignInfo?: object }} params
 * @param {{ onStepUpdate?: Function, searchOptions?: object }} [options]
 */
export async function searchInstagramByKeyword(params = {}, options = {}) {
  const { keywords = {}, campaignInfo = {} } = params;
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
  const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";

  let browser = null;
  let page = null;

  sendStep("启动浏览器", "正在通过 CDP 连接浏览器（Instagram 搜索需已登录）...");

  if (USE_HEADLESS) {
    const userDataDir = getUserDataDir();
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1920, height: 1080 },
    });
    page = await browser.newPage();
  } else {
    let connectError = null;
    for (let retry = 0; retry < 3; retry++) {
      try {
        browser = await connectCdp9222({
          platform: "instagram",
          phase: "search",
        });
        break;
      } catch (e) {
        connectError = e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!browser) {
      throw new Error(
        `CDP 连接失败: ${connectError?.message || "unknown"}（请启动 9222 并登录 Instagram）`
      );
    }
    const context = browser.contexts()[0] || (await browser.newContext());
    page = await acquireVisibleCdpPage(context, {
      reuseInstagramTab: true,
      logPrefix: "[searchInstagramByKeyword]",
    });
    console.log(
      `[searchInstagramByKeyword] CDP 当前页: ${page.url()}（将导航到 Instagram 搜索）`
    );
  }

  try {
    const firstKeyword = searchQueries[0];
    console.log(`[searchInstagramByKeyword] 关键词: ${firstKeyword}`);

    const searchData = await extractInstagramSearchResultsFromPageCDP(
      page,
      firstKeyword,
      {
        onStepUpdate,
        maxInfluencers: searchOptions.maxInfluencers,
        scrollRounds: searchOptions.scrollRounds,
      }
    );

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
  } finally {
    // 不断开用户 9222 窗口中的标签页，仅断开 Playwright（与 TikTok 搜索一致）
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
