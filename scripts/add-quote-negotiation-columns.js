/**
 * 为 tiktok_campaign_execution 增加 currency、quote_negotiation（方案 A）
 *
 *   node scripts/add-quote-negotiation-columns.js
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

async function ensureColumn(table, column, definitionSql) {
  if (await hasColumn(table, column)) {
    console.log(`⏭️ ${table}.${column} 已存在，跳过`);
    return;
  }
  console.log(`执行: ALTER TABLE ${table} ADD COLUMN ${column} ...`);
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${definitionSql}`);
  console.log("  OK");
}

async function main() {
  const table = "tiktok_campaign_execution";

  await ensureColumn(
    table,
    "currency",
    "currency VARCHAR(8) NOT NULL DEFAULT 'USD' COMMENT '报价币种 ISO 4217，如 USD、EUR' AFTER flat_fee"
  );
  await ensureColumn(
    table,
    "quote_negotiation",
    "quote_negotiation JSON NULL COMMENT '报价/砍价时间线：[{role,amount,currency,reason,at,source}]' AFTER currency"
  );

  console.log("\n✅ currency / quote_negotiation 已就绪。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 迁移失败:", err?.message || err);
    process.exit(1);
  });
