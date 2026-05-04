/**
 * 为 tiktok_campaign_sessions 增加 published_user_hidden_at（若已存在则跳过）
 * 含义：用户从前端删除「已发布」侧栏项时写入，会话行保留，便于审计与列表过滤。
 *
 * 部署后执行：node scripts/add-published-user-hidden-at-to-campaign-sessions.js
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
      ALTER TABLE tiktok_campaign_sessions
      ADD COLUMN published_user_hidden_at DATETIME NULL
        COMMENT '用户从前端移除已发布列表的时间；会话行保留'
    `);
    console.log("✅ tiktok_campaign_sessions.published_user_hidden_at 已添加");
  } catch (e) {
    if (e.message && /Duplicate column name/i.test(e.message)) {
      console.log("⏭️ published_user_hidden_at 列已存在，跳过");
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
