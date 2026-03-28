/**
 * 为 tiktok_campaign 表添加 influencers_per_day 列（若已存在则跳过）
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
      ADD COLUMN influencers_per_day INT NOT NULL DEFAULT 5 COMMENT '每天联系红人数量'
    `);
    console.log("✅ tiktok_campaign.influencers_per_day 列已添加");
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log("⏭️ influencers_per_day 列已存在，跳过");
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

