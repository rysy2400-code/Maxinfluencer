/**
 * 为已有 campaigns 表补齐快照相关列：
 * product_info, campaign_info, influencer_profile, influencers,
 * content_script, status, influencers_per_day
 *
 * 用于修复发布时报错：
 *  Unknown column 'product_info' in 'field list'
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function safeAlter(sql, label) {
  try {
    await queryTikTok(sql);
    console.log(`✅ ${label} 已添加`);
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log(`⏭️ ${label} 已存在，跳过`);
    } else {
      throw e;
    }
  }
}

async function run() {
  try {
    await safeAlter(
      "ALTER TABLE campaigns ADD COLUMN product_info JSON COMMENT '产品信息快照'",
      "product_info 列"
    );
    await safeAlter(
      "ALTER TABLE campaigns ADD COLUMN campaign_info JSON COMMENT 'Campaign 信息快照（平台、地区、预算、发布时间等）'",
      "campaign_info 列"
    );
    await safeAlter(
      "ALTER TABLE campaigns ADD COLUMN influencer_profile JSON COMMENT '红人画像快照'",
      "influencer_profile 列"
    );
    await safeAlter(
      "ALTER TABLE campaigns ADD COLUMN influencers JSON COMMENT '红人列表快照'",
      "influencers 列"
    );
    await safeAlter(
      "ALTER TABLE campaigns ADD COLUMN content_script JSON COMMENT '内容脚本快照'",
      "content_script 列"
    );
    await safeAlter(
      "ALTER TABLE campaigns ADD COLUMN status ENUM('running','paused','completed') NOT NULL DEFAULT 'running'",
      "status 列"
    );
    await safeAlter(
      "ALTER TABLE campaigns ADD COLUMN influencers_per_day INT NOT NULL DEFAULT 5 COMMENT '每天联系红人数量'",
      "influencers_per_day 列"
    );

    console.log("✅ campaigns 快照相关列补齐完毕");
    process.exit(0);
  } catch (err) {
    console.error("❌ 失败:", err.message);
    process.exit(1);
  }
}

run();

