/**
 * 一次性脚本：为 tiktok_campaign_execution 增加商务/交付相关字段
 *
 * 使用方式：
 *   node scripts/add-execution-deliverables-columns.js
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
  if (await hasColumn(table, column)) return;
  console.log(`执行: ALTER TABLE ${table} ADD COLUMN ${column} ...`);
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${definitionSql}`);
  console.log("  OK");
}

async function main() {
  const table = "tiktok_campaign_execution";

  await ensureColumn(
    table,
    "flat_fee",
    "flat_fee DECIMAL(10,2) NULL COMMENT '一次性合作费用（USD）' AFTER stage"
  );
  await ensureColumn(
    table,
    "sku",
    "sku VARCHAR(255) NULL COMMENT 'SKU（用于寄样/对账）' AFTER flat_fee"
  );
  await ensureColumn(
    table,
    "shipping_info",
    "shipping_info JSON NULL COMMENT '本次寄样信息快照（地址/收件人/电话/备注等）' AFTER sku"
  );
  await ensureColumn(
    table,
    "video_draft",
    "video_draft JSON NULL COMMENT '草稿与修改建议（建议存数组）' AFTER shipping_info"
  );
  await ensureColumn(
    table,
    "video_link",
    "video_link VARCHAR(1024) NULL COMMENT '最终视频链接（发布后填写）' AFTER video_draft"
  );
  await ensureColumn(
    table,
    "adcode",
    "adcode VARCHAR(255) NULL COMMENT '投放/追踪 code（如 adcode/utm 等）' AFTER video_link"
  );

  console.log("\n✅ tiktok_campaign_execution 字段已就绪。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 迁移失败:", err?.message || err);
    process.exit(1);
  });

