/**
 * 幂等补齐 tiktok_campaign_influencer_candidates：
 * - match_analysis JSON NULL（长文匹配分析，analysis_summary 仍为短摘要）
 *
 * 用法：node scripts/add-match-analysis-candidates.js
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
  const table = "tiktok_campaign_influencer_candidates";
  const changed = [];

  if (
    await ensureColumn(
      table,
      "match_analysis",
      "match_analysis JSON NULL COMMENT '结构化匹配分析（长文等）；analysis_summary 为短摘要'"
    )
  ) {
    changed.push("match_analysis");
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
