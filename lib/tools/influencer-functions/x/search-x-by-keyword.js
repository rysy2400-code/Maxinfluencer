/**
 * X 关键词搜索（9222 CDP，需登录 X；香港 IP 直连，不走代理）。
 * v1 仅支持 Lite 模式：SearchTimeline GraphQL 直调，不打开搜索页、不滚动、不截图。
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { extractXSearchLite } from "./extract-x-search-lite.js";
import { withCdp9222PreparedSession } from "../../../cdp/connect-cdp-9222.js";
import { isLiteScraperMode } from "../../../scraper/resolve-scraper-mode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {{ keywords?: { search_queries?: string[] }, campaignInfo?: object }} params
 * @param {{ onStepUpdate?: Function, searchOptions?: object, context?: import('playwright').BrowserContext }} [options]
 */
export async function searchXByKeyword(params = {}, options = {}) {
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
    throw new Error("X 搜索暂不支持无头模式，请使用 9222 CDP（需已登录 X）");
  }

  const liteMode = isLiteScraperMode();
  if (!liteMode) {
    throw new Error("X 平台 v1 仅支持 Lite 模式，请设置 SCRAPER_MODE=lite");
  }

  sendStep("启动浏览器", "正在通过 CDP 连接浏览器（X 搜索需已登录，香港 IP 直连）...");

  const runInContext = async (context) => {
    const firstKeyword = searchQueries[0];
    console.log(`[searchXByKeyword] 关键词: ${firstKeyword} mode=lite`);

    const searchData = await extractXSearchLite(context, firstKeyword, {
      onStepUpdate,
      maxInfluencers:
        searchOptions.maxInfluencers || searchOptions.maxChannels,
    });

    if (!searchData.success || searchData.influencerRecords.length === 0) {
      sendStep("搜索无结果", `X 关键词「${firstKeyword}」未搜索到红人，跳过 enrich`);
      return {
        influencerRecords: [],
        videos: [],
        stats: searchData.stats || {},
        success: false,
        error: "no_x_search_results",
        xLiteSession: searchData.session,
      };
    }

    sendStep(
      "搜索完成",
      `X Lite: ${searchData.influencerRecords.length} 红人`
    );

    try {
      const logsDir = path.join(__dirname, "../../../../logs");
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.writeFileSync(
        path.join(logsDir, `search-x-lite-${ts}.json`),
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            keyword: firstKeyword,
            mode: "lite",
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
      console.warn("[searchXByKeyword] 写日志失败:", e.message);
    }

    return {
      influencerRecords: searchData.influencerRecords,
      videos: searchData.videos,
      stats: {
        ...(searchData.stats || {}),
        totalTime: "0",
        videoCount: searchData.videos.length,
        influencerCount: searchData.influencerRecords.length,
        platform: "X",
        scraperMode: "lite",
      },
      /** Lite 搜索会话，enrich 阶段可复用同一 x.com 页（须在未断开 CDP 时使用） */
      xLiteSession: searchData.session,
    };
  };

  if (options.context) {
    return runInContext(options.context);
  }

  return withCdp9222PreparedSession(
    { platform: "x", phase: "search-lite" },
    async ({ context }) => runInContext(context)
  );
}
