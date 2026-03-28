/**
 * 为已有 campaigns 表添加 session_id 列（若已存在则跳过）
 * 解决发布时报错：Unknown column 'session_id' in 'field list'
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function run() {
  try {
    await queryTikTok(`
      ALTER TABLE campaigns
      ADD COLUMN session_id VARCHAR(36) NULL COMMENT '关联 campaign_sessions.id'
    `);
    console.log("✅ campaigns.session_id 列已添加");
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log("⏭️ session_id 列已存在，跳过");
    } else {
      throw e;
    }
  }

  try {
    await queryTikTok(`ALTER TABLE campaigns ADD INDEX idx_session_id (session_id)`);
    console.log("✅ idx_session_id 索引已添加");
  } catch (e) {
    if (e.message && /Duplicate key name/i.test(e.message)) {
      console.log("⏭️ idx_session_id 索引已存在，跳过");
    } else {
      throw e;
    }
  }

  process.exit(0);
}

run().catch((err) => {
  console.error("❌ 失败:", err.message);
  process.exit(1);
});
