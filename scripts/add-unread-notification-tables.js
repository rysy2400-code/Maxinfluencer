/**
 * 一次性脚本：Bin 工作台未读提示所需的结构
 *
 * 1. tiktok_campaign_execution 增加红人沟通条目计数（供 tab / 卡片未读判定）
 *    - infl_event_seq：红人侧沟通条目总数（含寄样条目）
 *    - infl_card_seq ：红人侧沟通条目数（不含寄样条目，用于卡片红色数字）
 * 2. tiktok_campaign_sessions 增加 Bin 消息计数（供会话聊天框未读）
 *    - assistant_message_seq
 * 3. 新建 tiktok_user_read_state（按真实登录用户记已读水位）
 *
 * 计数一律从 0 起、增量累加，不回填历史。这样上线时历史沟通记录不会被判成未读。
 *
 * 使用方式：
 *   node scripts/add-unread-notification-tables.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const SESSION_TABLE = "tiktok_campaign_sessions";
const EXECUTION_TABLE = "tiktok_campaign_execution";

async function hasColumn(table, column) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
  `,
    [table, column]
  );
  return rows && rows[0] && Number(rows[0].n || 0) > 0;
}

async function hasTable(table) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
  `,
    [table]
  );
  return rows && rows[0] && Number(rows[0].n || 0) > 0;
}

async function ensureColumn(table, column, definitionSql) {
  if (!(await hasTable(table))) {
    console.log(`跳过: ${table} 不存在`);
    return;
  }
  if (await hasColumn(table, column)) {
    console.log(`已存在: ${table}.${column}`);
    return;
  }
  console.log(`执行: ALTER TABLE ${table} ADD COLUMN ${column} ...`);
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${definitionSql}`);
  console.log("  OK");
}

async function main() {
  await ensureColumn(
    EXECUTION_TABLE,
    "infl_event_seq",
    "infl_event_seq INT NOT NULL DEFAULT 0 COMMENT '红人侧沟通条目累计计数（含寄样），未读判定用'"
  );
  await ensureColumn(
    EXECUTION_TABLE,
    "infl_card_seq",
    "infl_card_seq INT NOT NULL DEFAULT 0 COMMENT '红人侧沟通条目累计计数（不含寄样），卡片红色数字用'"
  );
  await ensureColumn(
    SESSION_TABLE,
    "assistant_message_seq",
    "assistant_message_seq INT NOT NULL DEFAULT 0 COMMENT 'Bin(assistant) 消息累计计数，未读判定用'"
  );

  if (await hasTable("tiktok_user_read_state")) {
    console.log("已存在: tiktok_user_read_state");
  } else {
    console.log("执行: CREATE TABLE tiktok_user_read_state ...");
    await queryTikTok(`
      CREATE TABLE IF NOT EXISTS tiktok_user_read_state (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        reader_user_id INT NOT NULL COMMENT '真实登录用户 tiktok_advertiser_user.id',
        scope VARCHAR(32) NOT NULL COMMENT 'session=会话聊天框 / campaign_influencer=红人卡片',
        scope_key VARCHAR(191) NOT NULL COMMENT 'session=<sessionId>；campaign_influencer=<campaignId>:<username>',
        last_read_seq BIGINT NOT NULL DEFAULT 0 COMMENT '已读顺序水位',
        last_read_card_seq BIGINT NOT NULL DEFAULT 0 COMMENT '红人卡片已读水位（不含寄样条目）',
        last_read_at DATETIME NULL COMMENT '最后一次标记已读时间',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_reader_scope_key (reader_user_id, scope, scope_key),
        KEY idx_reader_scope (reader_user_id, scope)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='未读提示已读水位表'
    `);
    console.log("  OK");
  }

  console.log("\n✅ 未读提示结构已就绪。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 迁移失败:", err?.message || err);
    process.exit(1);
  });
