/**
 * 幂等补齐「红人本人确认常住地」列（与平台抓取的 video_publish_country 分开存）。
 *
 * 为什么分开：爬虫只认识 video_publish_country，会覆盖它；把「红人本人说的」放到
 * 独立列，爬虫天然不会碰，也就不需要重新部署爬虫机器。
 *
 * 用法: node scripts/add-residence-country-columns.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TABLE = "TikTok_influencer";

const COLUMNS = [
  [
    "residence_country",
    "residence_country VARCHAR(16) NULL COMMENT '红人本人确认的常住地 ISO（对接/寄样用），爬虫不写'",
  ],
  [
    "residence_country_source",
    "residence_country_source VARCHAR(32) NULL COMMENT '常住地来源：email_reply_llm / shipping_address / manual 等'",
  ],
  [
    "residence_country_relation",
    "residence_country_relation VARCHAR(24) NULL COMMENT '判定关系：self_residence 等'",
  ],
  [
    "residence_country_evidence",
    "residence_country_evidence VARCHAR(512) NULL COMMENT '支撑该结论的邮件原句'",
  ],
  [
    "residence_country_confidence",
    "residence_country_confidence DECIMAL(4,2) NULL COMMENT '抽取置信度'",
  ],
  [
    "residence_country_checked_at",
    "residence_country_checked_at DATETIME NULL COMMENT '最近一次写入常住地时间'",
  ],
];

async function columnExists(table, column) {
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows?.[0]?.n || 0) > 0;
}

async function main() {
  const changed = [];
  for (const [col, ddl] of COLUMNS) {
    if (await columnExists(TABLE, col)) continue;
    await queryTikTok(`ALTER TABLE ${TABLE} ADD COLUMN ${ddl}`);
    changed.push(`${TABLE}.${col}`);
  }
  console.log(
    changed.length
      ? `✅ 已补齐列: ${changed.join(", ")}`
      : "✅ 列已存在（无需变更）。"
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 补齐列失败:", err?.message || err);
    process.exit(1);
  });
