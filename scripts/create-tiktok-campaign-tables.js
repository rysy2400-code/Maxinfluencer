/**
 * 创建 TikTok Campaign 相关表：
 * - tiktok_campaign
 * - tiktok_campaign_execution
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

async function createTables() {
  const schemaPath = path.join(__dirname, "../lib/db/tiktok-campaign-schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  // 粗分号切分（去除注释行），只执行 CREATE TABLE 语句
  const cleaned = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => /^CREATE\s+TABLE/i.test(s));

  if (statements.length === 0) {
    throw new Error("schema 中未解析到任何 CREATE TABLE 语句");
  }

  for (const statement of statements) {
    const preview = statement.substring(0, 80).replace(/\s+/g, " ");
    console.log("执行:", preview + "...");
    await queryTikTok(statement);
    console.log("  OK");
  }

  const changed = [];
  if (
    await ensureColumn(
      "tiktok_campaign",
      "keyword_strategy",
      "keyword_strategy TEXT NULL COMMENT '用户关键词策略（简短文本，供关键词生成参考）'"
    )
  ) {
    changed.push("tiktok_campaign.keyword_strategy");
  }

  console.log("\n✅ TikTok Campaign 相关表创建成功。");
  if (changed.length) {
    console.log("✅ 已补齐字段:", changed.join(", "));
  }
  try {
    const c = await queryTikTok("SHOW TABLES LIKE 'tiktok_campaign'");
    if (c.length > 0) console.log("  - tiktok_campaign");
    const e = await queryTikTok("SHOW TABLES LIKE 'tiktok_campaign_execution'");
    if (e.length > 0) console.log("  - tiktok_campaign_execution");
  } catch (e) {
    console.warn("(验证表存在时失败，可忽略):", e.message);
  }
  process.exit(0);
}

createTables().catch((err) => {
  console.error("❌ 创建表失败:", err.message);
  process.exit(1);
});

