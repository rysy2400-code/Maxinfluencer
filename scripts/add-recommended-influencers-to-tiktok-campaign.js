/**
 * 为 tiktok_campaign 增加 recommended_influencers JSON 列（若已存在则跳过）
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
      ALTER TABLE tiktok_campaign
      ADD COLUMN recommended_influencers JSON NULL COMMENT '发布时推荐红人列表（规范快照，不进执行表）'
      AFTER content_script
    `);
    console.log("✅ tiktok_campaign.recommended_influencers 列已添加");
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log("⏭️ recommended_influencers 列已存在，跳过");
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
