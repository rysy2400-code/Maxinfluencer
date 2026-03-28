/**
 * 为已有 campaigns 表添加 execution_state 列（若已存在则跳过）
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function run() {
  try {
    await queryTikTok(`
      ALTER TABLE campaigns
      ADD COLUMN execution_state JSON COMMENT '红人执行状态：influencerId -> pending_quote|pending_sample|pending_draft|published'
    `);
    console.log("✅ campaigns.execution_state 列已添加");
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log("⏭️ execution_state 列已存在，跳过");
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
