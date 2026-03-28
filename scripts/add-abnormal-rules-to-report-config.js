/**
 * 为已有 tiktok_campaign_report_config 表添加 abnormal_rules 列（若已存在则跳过）
 * 用于存储异常汇报规则的最小集合，由心跳 worker 解析。
 *
 * 使用方式：
 *   node scripts/add-abnormal-rules-to-report-config.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function addAbnormalRulesColumn() {
  try {
    const columns = await queryTikTok("SHOW COLUMNS FROM tiktok_campaign_report_config LIKE 'abnormal_rules'");
    if (columns.length > 0) {
      console.log("⏭️ tiktok_campaign_report_config.abnormal_rules 已存在，跳过");
      return;
    }

    console.log("正在为 tiktok_campaign_report_config 添加 abnormal_rules 列...");
    await queryTikTok(
      "ALTER TABLE tiktok_campaign_report_config ADD COLUMN abnormal_rules JSON COMMENT '异常汇报规则：最小集合（阈值、冷却时间等），由心跳 worker 解析'"
    );
    console.log("✅ abnormal_rules 列已添加");
  } catch (error) {
    console.error("❌ 添加 abnormal_rules 列失败:", error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

addAbnormalRulesColumn();

