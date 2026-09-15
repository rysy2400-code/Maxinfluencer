/**
 * 为 tiktok_campaign_execution 增加 commission_percent（执行级佣金，和 flat_fee 同规则）
 *
 *   node scripts/add-execution-commission-percent.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TABLE = "tiktok_campaign_execution";
const COLUMN = "commission_percent";
const DEFINITION =
  "commission_percent DECIMAL(5,2) NULL COMMENT '本条执行谈定的佣金百分比（0-100）；NULL=未谈定' AFTER flat_fee";

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

async function main() {
  if (await hasColumn(TABLE, COLUMN)) {
    console.log(`⏭️ ${TABLE}.${COLUMN} 已存在，跳过`);
    return;
  }
  console.log(`执行: ALTER TABLE ${TABLE} ADD COLUMN ${DEFINITION}`);
  await queryTikTok(`ALTER TABLE ${TABLE} ADD COLUMN ${DEFINITION}`);
  console.log("  OK");
  console.log("\n✅ commission_percent 已就绪。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 迁移失败:", err?.message || err);
    process.exit(1);
  });
