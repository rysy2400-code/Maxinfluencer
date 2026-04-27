/**
 * 创建 crawler_health 相关表：
 * - crawler_worker_health
 * - crawler_repair_action_log
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
  const exists = await columnExists(table, column);
  if (exists) return false;
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

function splitSqlStatements(sqlText) {
  return String(sqlText || "")
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trimEnd())
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const schemaPath = path.join(__dirname, "../lib/db/crawler-health-schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const statements = splitSqlStatements(sql);

  for (const statement of statements) {
    await queryTikTok(statement);
  }

  const changed = [];
  if (
    await ensureColumn(
      "crawler_worker_health",
      "cdp_9222_fail_streak",
      "cdp_9222_fail_streak INT NOT NULL DEFAULT 0"
    )
  ) {
    changed.push("crawler_worker_health.cdp_9222_fail_streak");
  }
  if (
    await ensureColumn(
      "crawler_worker_health",
      "cdp_9223_fail_streak",
      "cdp_9223_fail_streak INT NOT NULL DEFAULT 0"
    )
  ) {
    changed.push("crawler_worker_health.cdp_9223_fail_streak");
  }

  console.log("✅ crawler_worker_health / crawler_repair_action_log 表已确保存在。");
  if (changed.length) {
    console.log("✅ crawler health 已补齐字段:", changed.join(", "));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 创建 crawler health 表失败:", err?.message || err);
    process.exit(1);
  });
