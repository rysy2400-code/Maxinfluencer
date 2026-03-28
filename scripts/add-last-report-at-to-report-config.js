/**
 * 为已有 tiktok_campaign_report_config 表添加 last_report_at 列（若已存在则跳过）
 *
 * 使用方式：
 *   node scripts/add-last-report-at-to-report-config.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function addLastReportAtColumn() {
  try {
    const cols = await queryTikTok(
      "SHOW COLUMNS FROM tiktok_campaign_report_config LIKE 'last_report_at'"
    );
    if (cols.length > 0) {
      console.log("⏭️ last_report_at 列已存在，跳过");
      process.exit(0);
    }

    console.log("正在为 tiktok_campaign_report_config 添加 last_report_at 列...");
    await queryTikTok(
      "ALTER TABLE tiktok_campaign_report_config ADD COLUMN last_report_at TIMESTAMP NULL DEFAULT NULL COMMENT '上一次常规汇报时间'"
    );
    console.log("✅ last_report_at 列已添加");
    process.exit(0);
  } catch (error) {
    console.error("❌ 添加 last_report_at 列失败:", error);
    process.exit(1);
  }
}

addLastReportAtColumn();

