/**
 * 幂等补齐 tiktok_influencer_search_task 观测字段：
 * - last_progress_at DATETIME NULL
 * - progress_analyzed_count INT NOT NULL DEFAULT 0
 *
 * 用法：
 *   node scripts/add-task-progress-columns.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
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
  return Number(rows?.[0]?.n || 0) > 0;
}

async function ensureColumn(table, column, ddl) {
  if (await columnExists(table, column)) return false;
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

async function main() {
  const table = "tiktok_influencer_search_task";
  const changed = [];

  if (
    await ensureColumn(
      table,
      "last_progress_at",
      "last_progress_at DATETIME NULL COMMENT '最近一次确认任务有推进的时间（用于 stuck 回收）'"
    )
  ) {
    changed.push("last_progress_at");
  }

  if (
    await ensureColumn(
      table,
      "progress_analyzed_count",
      "progress_analyzed_count INT NOT NULL DEFAULT 0 COMMENT '候选写入尝试数（包含重复/INSERT IGNORE）'"
    )
  ) {
    changed.push("progress_analyzed_count");
  }

  if (changed.length) {
    console.log("✅ 已补齐列:", changed.join(", "));
  } else {
    console.log("✅ 列已存在（无需变更）。");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 补齐列失败:", err?.message || err);
    process.exit(1);
  });

