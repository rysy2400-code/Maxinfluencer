#!/usr/bin/env node
/**
 * 根据关键词从 TikTok 搜索页抓取视频数据，并导出为 CSV。
 * - 依赖项目内已有的 searchInfluencersByKeyword（红人画像确认 agent 中的搜索函数）
 * - 默认关键词为「#roboticpoolcleaner」，可通过命令行参数覆盖
 * - 会尝试获取尽量多的视频，并导出前 1000 条到 CSV 文件
 *
 * 使用方式（建议先在 .env/.env.local 里配置好 TikTok 登录用的用户数据目录/CDP）:
 *   # 建议使用 headless（自动启动浏览器，需要 PLAYWRIGHT_HEADLESS=true）
 *   PLAYWRIGHT_HEADLESS=true node scripts/export-tiktok-search-to-csv.js "#roboticpoolcleaner"
 *
 *   # 或者使用已手动启动、已登录 TikTok 的 Chrome（见项目中现有脚本说明）
 *   CDP_ENDPOINT=http://localhost:9222 node scripts/export-tiktok-search-to-csv.js "#roboticpoolcleaner"
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// 复用红人画像确认 agent 中的搜索函数
import { searchInfluencersByKeyword } from "../lib/tools/influencer-functions/search-and-extract-influencers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// 加载环境变量（与项目内其他脚本保持一致）
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

// ========== 工具函数 ==========

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSVRows(videos) {
  const header = [
    "videoId",
    "videoUrl",
    "username",
    "profileUrl",
    "viewsCount",
    "viewsDisplay",
    "likesCount",
    "likesDisplay",
    "commentsCount",
    "sharesCount",
    "favoritesCount",
    "caption",
    "description",
    "hashtags",
    "mentions",
    "musicTitle",
    "musicAuthor",
    "postedTime",
  ];

  const lines = [header.map(csvEscape).join(",")];

  for (const v of videos) {
    const viewsCount = v.views?.count ?? "";
    const viewsDisplay = v.views?.display ?? "";
    const likesCount = v.likes?.count ?? "";
    const likesDisplay = v.likes?.display ?? "";
    const commentsCount = v.comments?.count ?? "";
    const sharesCount = v.shares?.count ?? "";
    const favoritesCount = v.favorites?.count ?? "";

    const hashtags = Array.isArray(v.hashtags) ? v.hashtags.join(";") : "";
    const mentions = Array.isArray(v.mentions) ? v.mentions.join(";") : "";
    const musicTitle = v.music?.title ?? "";
    const musicAuthor = v.music?.author ?? "";

    const row = [
      v.videoId ?? "",
      v.videoUrl ?? "",
      v.username ?? "",
      v.profileUrl ?? "",
      viewsCount,
      viewsDisplay,
      likesCount,
      likesDisplay,
      commentsCount,
      sharesCount,
      favoritesCount,
      v.caption ?? "",
      v.description ?? "",
      hashtags,
      mentions,
      musicTitle,
      musicAuthor,
      v.postedTime ?? "",
    ];

    lines.push(row.map(csvEscape).join(","));
  }

  return lines.join("\n");
}

// ========== 主流程 ==========

async function main() {
  const keywordFromCli = process.argv[2];
  const keyword = keywordFromCli && keywordFromCli.trim().length > 0 ? keywordFromCli.trim() : "#roboticpoolcleaner";

  console.log(`🔍 即将搜索 TikTok 关键词: "${keyword}"`);

  // 构造与 agent 相同结构的参数
  const params = {
    keywords: {
      search_queries: [keyword],
    },
    platforms: ["tiktok"],
    countries: [],
    productInfo: {},
    campaignInfo: {},
    influencerProfile: null,
  };

  // 这里不做画像分析和主页补充，只用搜索页返回的视频数据
  const options = {
    onStepUpdate: (info) => {
      if (!info) return;
      if (info.type === "step" && info.step) {
        console.log(`[STEP] ${info.step.stepId} - ${info.step.status} - ${info.step.detail ?? ""}`);
      } else if (info.step && info.message) {
        console.log(`[STEP] ${info.step}: ${info.message}`);
      } else if (info.message) {
        console.log(`[INFO] ${info.message}`);
      }
    },
    // 让搜索阶段多滚几轮，尽量多触发搜索 API
    // 注意：滚动过多可能增加风控风险，可按需要调整
    searchOptions: {
      scrollRounds: 40, // 默认滚 40 轮，比原来的 5-8 轮多很多
    },
  };

  try {
    const result = await searchInfluencersByKeyword(params, options);

    if (!result || !Array.isArray(result.videos)) {
      console.error("❌ 搜索结果结构异常，未获取到 videos 字段。");
      process.exit(1);
    }

    const allVideos = result.videos;
    console.log(`✅ 共获取到 ${allVideos.length} 条视频记录。`);

    if (allVideos.length === 0) {
      console.warn("⚠️ 未获取到任何视频，请检查是否已登录 TikTok、CDP/Headless 配置是否正确。");
      process.exit(1);
    }

    // 取前 1000 条（如果不足 1000 条，就导出全部）
    const MAX_COUNT = 1000;
    const selectedVideos = allVideos.slice(0, MAX_COUNT);

    if (allVideos.length < MAX_COUNT) {
      console.warn(`⚠️ 仅获取到 ${allVideos.length} 条视频，少于目标 ${MAX_COUNT} 条，将全部导出。`);
    } else {
      console.log(`ℹ️ 将导出前 ${MAX_COUNT} 条视频数据。`);
    }

    const csvContent = toCSVRows(selectedVideos);

    const safeKeyword = keyword.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]+/g, "_");
    const outputFile = path.join(projectRoot, `tiktok_search_${safeKeyword}_top${MAX_COUNT}.csv`);

    fs.writeFileSync(outputFile, csvContent, "utf8");

    console.log(`✅ CSV 已生成: ${outputFile}`);
  } catch (error) {
    console.error("❌ 抓取或导出过程中发生错误:", error?.message || error);
    process.exit(1);
  } finally {
    // searchInfluencersByKeyword 内部会自行关闭/释放浏览器资源
  }
}

main();

