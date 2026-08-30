/**
 * 一次性脚本：为 tiktok_influencer_conversation_messages 添加
 * (influencer_id, event_time DESC, id DESC) 索引。
 *
 * 用途：红人收件箱「按时间 / 按项目」视图计算每个红人最新一条消息时，
 * 让 MySQL 可以直接按索引顺序扫描，避免对全部消息做窗口排序。
 *
 * 使用方式：
 *   node scripts/add-conversation-messages-latest-index.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const INDEX_NAME = "idx_influencer_event_time_id";
const TABLE = "tiktok_influencer_conversation_messages";

async function main() {
  const [existing] = await pool.query(
    `SELECT COUNT(*) AS n
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [TABLE, INDEX_NAME]
  );

  if (Number(existing[0].n) > 0) {
    console.log(`[add-conversation-messages-latest-index] 索引 ${INDEX_NAME} 已存在，跳过。`);
    process.exit(0);
  }

  console.log(`[add-conversation-messages-latest-index] 创建索引 ${INDEX_NAME} ...`);
  const startedAt = Date.now();
  await pool.query(
    `ALTER TABLE \`${TABLE}\`
     ADD INDEX \`${INDEX_NAME}\` (influencer_id, event_time DESC, id DESC)`
  );
  console.log(`[add-conversation-messages-latest-index] 索引创建完成，耗时 ${Date.now() - startedAt}ms。`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[add-conversation-messages-latest-index] 运行失败:", err?.message || err);
    process.exit(1);
  });
