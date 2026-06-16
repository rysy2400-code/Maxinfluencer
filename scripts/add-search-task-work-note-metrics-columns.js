/**
 * 幂等补齐 tiktok_influencer_search_task 工作笔记展示指标列。
 *
 * 用法：node scripts/add-search-task-work-note-metrics-columns.js
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
  const columns = [
    [
      "progress_search_found_count",
      "progress_search_found_count INT NOT NULL DEFAULT 0 COMMENT '关键词搜索池频道数（已获取）'",
    ],
    [
      "progress_profile_browsed_count",
      "progress_profile_browsed_count INT NOT NULL DEFAULT 0 COMMENT '已浏览主页（含国家预筛与完整 enrich）'",
    ],
    [
      "progress_recommended_count",
      "progress_recommended_count INT NOT NULL DEFAULT 0 COMMENT '符合红人画像（isRecommended=true 写入候选池）'",
    ],
    [
      "progress_contactable_count",
      "progress_contactable_count INT NOT NULL DEFAULT 0 COMMENT '可联系（符合画像且有邮箱）'",
    ],
    [
      "progress_skip_country_unknown_count",
      "progress_skip_country_unknown_count INT NOT NULL DEFAULT 0 COMMENT '因国家未知跳过分析'",
    ],
    [
      "progress_skip_country_mismatch_count",
      "progress_skip_country_mismatch_count INT NOT NULL DEFAULT 0 COMMENT '因国家不符合跳过分析'",
    ],
  ];

  const changed = [];
  for (const [name, ddl] of columns) {
    if (await ensureColumn(table, name, ddl)) changed.push(name);
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
