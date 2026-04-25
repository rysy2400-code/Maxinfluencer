/**
 * 创建 tiktok_influencer_search_task 任务表。
 *
 * 用法：
 *   node scripts/create-influencer-search-task-table.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function columnExists(table, column) {
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
  return (rows?.[0]?.n || 0) > 0;
}

async function indexExists(table, indexName) {
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
  return (rows?.[0]?.n || 0) > 0;
}

async function ensureColumn(table, column, ddl) {
  const ok = await columnExists(table, column);
  if (ok) return false;
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

async function ensureIndex(table, indexName, ddl) {
  const ok = await indexExists(table, indexName);
  if (ok) return false;
  await queryTikTok(`ALTER TABLE ${table} ADD ${ddl}`);
  return true;
}

function splitSqlStatements(sqlText) {
  const lines = String(sqlText || "").split("\n");
  const withoutComments = lines
    .map((line) => line.replace(/--.*$/, "").trimEnd())
    .join("\n");

  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const schemaPath = path.join(
    __dirname,
    "../lib/db/influencer-search-task-schema.sql"
  );
  const sql = fs.readFileSync(schemaPath, "utf8");
  // mysql2 默认不允许 multiStatements；这里手动拆分并清理行注释。
  const statements = splitSqlStatements(sql);
  for (const stmt of statements) {
    await queryTikTok(stmt);
  }

  // 注意：CREATE TABLE IF NOT EXISTS 不会更新已存在表结构。
  // 下面补齐新增列/索引，保证脚本可重复执行（幂等）。
  const taskTable = "tiktok_influencer_search_task";

  const changed = [];
  if (await ensureColumn(taskTable, "session_id", "session_id VARCHAR(36) NULL COMMENT '关联 campaign_sessions.id，供工作实况订阅路由'")) changed.push("task.session_id");
  if (await ensureColumn(taskTable, "run_id", "run_id VARCHAR(64) NULL COMMENT '执行批次 ID（通常为 campaign + date）'")) changed.push("task.run_id");
  if (await ensureColumn(taskTable, "keyword", "keyword VARCHAR(255) NULL COMMENT '本任务主关键词（单任务单关键词）'")) changed.push("task.keyword");
  if (await ensureColumn(taskTable, "keyword_type", "keyword_type ENUM('new','variant','high_performer','fallback') NOT NULL DEFAULT 'new'")) changed.push("task.keyword_type");
  if (await ensureColumn(taskTable, "worker_host", "worker_host VARCHAR(128) NULL COMMENT '执行机器标识（可选）'")) changed.push("task.worker_host");

  // indexes / unique key
  if (await ensureIndex(taskTable, "idx_campaign_run", "INDEX idx_campaign_run (campaign_id, run_id)")) changed.push("task.idx_campaign_run");
  if (await ensureIndex(taskTable, "idx_session_status", "INDEX idx_session_status (session_id, status)")) changed.push("task.idx_session_status");
  if (await ensureIndex(taskTable, "idx_keyword", "INDEX idx_keyword (campaign_id, keyword, created_at)")) changed.push("task.idx_keyword");
  if (await ensureIndex(taskTable, "uk_campaign_run_keyword", "UNIQUE KEY uk_campaign_run_keyword (campaign_id, run_id, keyword)")) changed.push("task.uk_campaign_run_keyword");

  if (changed.length) {
    console.log("✅ tiktok_influencer_search_task 已补齐字段/索引:", changed.join(", "));
  } else {
    console.log("✅ tiktok_influencer_search_task 表结构已是最新（无需变更）。");
  }

  console.log("✅ 已确保 tiktok_keyword_run_result 表存在。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 创建 tiktok_influencer_search_task 失败:", err?.message || err);
    process.exit(1);
  });

