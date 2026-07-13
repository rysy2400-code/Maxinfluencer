/**
 * 创建 tiktok_campaign_keyword_signals 及 contributor 表；
 * 并为 tiktok_influencer_search_task 增加 progress_new_recommended_insert_count。
 *
 * 用法：
 *   node scripts/create-campaign-keyword-signals-table.js
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

async function ensureColumn(table, column, ddl) {
  const ok = await columnExists(table, column);
  if (ok) return false;
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
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
    projectRoot,
    "lib/db/campaign-keyword-signals-schema.sql"
  );
  const sqlText = fs.readFileSync(schemaPath, "utf8");
  const statements = splitSqlStatements(sqlText);

  for (const stmt of statements) {
    await queryTikTok(stmt);
    console.log("✅ 已执行:", stmt.slice(0, 80).replace(/\s+/g, " "), "...");
  }

  const taskCol = await ensureColumn(
    "tiktok_influencer_search_task",
    "progress_new_recommended_insert_count",
    "progress_new_recommended_insert_count INT NOT NULL DEFAULT 0 COMMENT '首次 isRecommended=true 写入候选池的红人数'"
  );
  if (taskCol) {
    console.log("✅ 已添加 tiktok_influencer_search_task.progress_new_recommended_insert_count");
  } else {
    console.log("ℹ️ progress_new_recommended_insert_count 已存在，跳过");
  }

  console.log("✅ campaign keyword signals 表结构已就绪。");
}

main().catch((err) => {
  console.error("❌ 迁移失败:", err?.message || err);
  process.exit(1);
});
