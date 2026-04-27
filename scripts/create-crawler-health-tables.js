/**
 * 创建 / 迁移 crawler health 相关表：
 * - tiktok_crawler_worker_health（旧名 crawler_worker_health 会 RENAME）
 * - tiktok_crawler_repair_action_log（旧名 crawler_repair_action_log 会 RENAME）
 * - 移除 tiktok_influencer_outreach_thread_binding（若存在）
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

const T_WORKER = "tiktok_crawler_worker_health";
const T_LOG = "tiktok_crawler_repair_action_log";
const OLD_WORKER = "crawler_worker_health";
const OLD_LOG = "crawler_repair_action_log";

async function tableExists(table) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
  `,
    [table]
  );
  return Number(rows?.[0]?.n || 0) > 0;
}

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
  await queryTikTok(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
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

async function migrateOldNamesIfNeeded() {
  const hasOldW = await tableExists(OLD_WORKER);
  const hasNewW = await tableExists(T_WORKER);
  const hasOldL = await tableExists(OLD_LOG);
  const hasNewL = await tableExists(T_LOG);

  if (hasOldW && hasNewW) {
    console.warn(
      `⚠️ 同时存在 ${OLD_WORKER} 与 ${T_WORKER}，跳过 RENAME，请人工合并后删除旧表。`
    );
  } else if (hasOldL && hasNewL) {
    console.warn(`⚠️ 同时存在 ${OLD_LOG} 与 ${T_LOG}，跳过 RENAME，请人工合并后删除旧表。`);
  } else if (hasOldW && !hasNewW && hasOldL && !hasNewL) {
    await queryTikTok(
      `RENAME TABLE \`${OLD_WORKER}\` TO \`${T_WORKER}\`, \`${OLD_LOG}\` TO \`${T_LOG}\``
    );
    console.log(`✅ RENAME: ${OLD_WORKER}→${T_WORKER}, ${OLD_LOG}→${T_LOG}`);
  } else {
    if (hasOldW && !hasNewW) {
      await queryTikTok(`RENAME TABLE \`${OLD_WORKER}\` TO \`${T_WORKER}\``);
      console.log(`✅ RENAME: ${OLD_WORKER}→${T_WORKER}`);
    }
    if (hasOldL && !hasNewL) {
      await queryTikTok(`RENAME TABLE \`${OLD_LOG}\` TO \`${T_LOG}\``);
      console.log(`✅ RENAME: ${OLD_LOG}→${T_LOG}`);
    }
  }
}

async function main() {
  await migrateOldNamesIfNeeded();

  const schemaPath = path.join(__dirname, "../lib/db/crawler-health-schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const statements = splitSqlStatements(sql);

  for (const statement of statements) {
    await queryTikTok(statement);
  }

  const changed = [];
  if (
    await ensureColumn(
      T_WORKER,
      "cdp_9222_fail_streak",
      "cdp_9222_fail_streak INT NOT NULL DEFAULT 0"
    )
  ) {
    changed.push(`${T_WORKER}.cdp_9222_fail_streak`);
  }
  if (
    await ensureColumn(
      T_WORKER,
      "cdp_9223_fail_streak",
      "cdp_9223_fail_streak INT NOT NULL DEFAULT 0"
    )
  ) {
    changed.push(`${T_WORKER}.cdp_9223_fail_streak`);
  }

  await queryTikTok("DROP TABLE IF EXISTS tiktok_influencer_outreach_thread_binding");
  console.log("✅ 已 DROP IF EXISTS tiktok_influencer_outreach_thread_binding");

  console.log(`✅ ${T_WORKER} / ${T_LOG} 表已确保存在。`);
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
