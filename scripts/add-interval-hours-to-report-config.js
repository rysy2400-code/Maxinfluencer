/**
 * 为已有 tiktok_campaign_report_config 表添加 interval_hours 列，并从旧的 report_interval 迁移数据。
 *
 * 使用方式：
 *   node scripts/add-interval-hours-to-report-config.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function migrateIntervalHours() {
  try {
    // 1. 添加 interval_hours 列（若不存在）
    const cols = await queryTikTok(
      "SHOW COLUMNS FROM tiktok_campaign_report_config LIKE 'interval_hours'"
    );
    if (cols.length === 0) {
      console.log("正在添加 interval_hours 列...");
      await queryTikTok(
        "ALTER TABLE tiktok_campaign_report_config ADD COLUMN interval_hours DECIMAL(6,2) NOT NULL DEFAULT 24 COMMENT '两次汇报间隔（小时），如 24=每天一次，48=每2天一次'"
      );
      console.log("✅ interval_hours 列已添加");
    } else {
      console.log("⏭️ interval_hours 列已存在，跳过添加");
    }

    // 2. 如果仍有 report_interval 列，按枚举迁移到 interval_hours
    const oldCols = await queryTikTok(
      "SHOW COLUMNS FROM tiktok_campaign_report_config LIKE 'report_interval'"
    );
    if (oldCols.length > 0) {
      console.log("检测到旧的 report_interval 列，开始迁移数据到 interval_hours...");
      await queryTikTok(`
        UPDATE tiktok_campaign_report_config
        SET interval_hours = CASE report_interval
          WHEN 'daily' THEN 24
          WHEN 'every_2_days' THEN 48
          WHEN 'every_3_days' THEN 72
          WHEN 'weekly' THEN 168
          ELSE interval_hours
        END
      `);
      console.log("✅ 已根据 report_interval 迁移 interval_hours");

      console.log("正在删除 report_interval 列...");
      await queryTikTok(
        "ALTER TABLE tiktok_campaign_report_config DROP COLUMN report_interval"
      );
      console.log("✅ report_interval 列已删除");
    } else {
      console.log("⏭️ 未发现 report_interval 列，跳过迁移/删除");
    }
  } catch (error) {
    console.error("❌ 迁移 interval_hours 失败:", error);
    process.exit(1);
  }
  process.exit(0);
}

migrateIntervalHours();

