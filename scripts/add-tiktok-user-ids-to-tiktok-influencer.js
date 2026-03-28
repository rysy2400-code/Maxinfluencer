/**
 * 一次性脚本：为 tiktok_influencer 增加 TikTok userId / secUid 字段
 *
 * 约定：
 * - 对于 TikTok 平台，项目统一使用 TikTok 数字 userId 作为 influencer_id 的语义
 * - 同时在表上冗余存储：
 *   - tiktok_user_id：TikTok 数字 userId（推荐作为全局 influencerId）
 *   - tiktok_sec_uid：TikTok secUid（备用稳定 ID）
 *
 * 使用方式：
 *   node scripts/add-tiktok-user-ids-to-tiktok-influencer.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

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

async function hasIndex(table, indexName) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND INDEX_NAME = ?
  `,
    [table, indexName]
  );
  return rows && rows[0] && Number(rows[0].n || 0) > 0;
}

async function ensureColumn(table, column, definitionSql) {
  if (await hasColumn(table, column)) return;
  console.log(`执行: ALTER TABLE ${table} ADD COLUMN ${column} ...`);
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${definitionSql}`);
  console.log("  OK");
}

async function ensureIndex(table, indexName, indexSql) {
  if (await hasIndex(table, indexName)) return;
  console.log(`执行: ALTER TABLE ${table} ADD ${indexSql} ...`);
  await queryTikTok(`ALTER TABLE ${table} ADD ${indexSql}`);
  console.log("  OK");
}

async function main() {
  const table = "tiktok_influencer";

  await ensureColumn(
    table,
    "tiktok_user_id",
    "tiktok_user_id VARCHAR(64) NULL COMMENT 'TikTok 数字 userId（项目统一 influencerId 首选）' AFTER influencer_id"
  );

  await ensureColumn(
    table,
    "tiktok_sec_uid",
    "tiktok_sec_uid VARCHAR(256) NULL COMMENT 'TikTok secUid（备用稳定 ID）' AFTER tiktok_user_id"
  );

  await ensureIndex(
    table,
    "uk_tiktok_user_id",
    "UNIQUE KEY uk_tiktok_user_id (tiktok_user_id)"
  );

  await ensureIndex(
    table,
    "idx_tiktok_sec_uid",
    "INDEX idx_tiktok_sec_uid (tiktok_sec_uid)"
  );

  console.log("\n✅ tiktok_influencer TikTok userId/secUid 字段已就绪。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 迁移失败:", err?.message || err);
    process.exit(1);
  });

