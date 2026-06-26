/**
 * 为 tiktok_campaign 增加 running_passive 状态与 status_before_pause 列
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
      MODIFY COLUMN status ENUM(
        'draft',
        'running',
        'running_passive',
        'paused',
        'completed',
        'deleted'
      ) NOT NULL DEFAULT 'running'
      COMMENT 'Campaign 状态：running=自主寻源；running_passive=仅名单；paused/completed 同前'
    `);
    console.log("✅ tiktok_campaign.status 已扩展 running_passive");
  } catch (e) {
    if (e.message && /Duplicate|already/i.test(e.message)) {
      console.log("⏭️ status ENUM 可能已包含 running_passive，继续检查列");
    } else {
      throw e;
    }
  }

  try {
    await queryTikTok(`
      ALTER TABLE tiktok_campaign
      ADD COLUMN status_before_pause ENUM('running', 'running_passive') NULL
      COMMENT 'pause 前的活跃态，resume 时恢复'
      AFTER status
    `);
    console.log("✅ tiktok_campaign.status_before_pause 列已添加");
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log("⏭️ status_before_pause 列已存在，跳过");
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
