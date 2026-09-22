/**
 * 幂等：给 tiktok_influencer 增加「评论数据分析」列（官方口径 + LLM 口径都落库）。
 *
 * 用法: node scripts/add-comment-analysis-columns.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const COLUMNS = [
  ["comment_analysis_quality_ratio", "DECIMAL(6,4) NULL COMMENT '高质量评论占比(LLM)'"],
  [
    "comment_analysis_purchase_intent",
    "DECIMAL(6,4) NULL COMMENT '购买意愿评论占比(展示值：官方优先，缺失为LLM)'",
  ],
  [
    "comment_analysis_purchase_intent_official",
    "DECIMAL(6,4) NULL COMMENT '购买意愿评论占比-平台官方口径(TikTok)'",
  ],
  [
    "comment_analysis_purchase_intent_llm",
    "DECIMAL(6,4) NULL COMMENT '购买意愿评论占比-LLM口径(问价/求链接/问渠道)'",
  ],
  [
    "comment_analysis_purchase_intent_source",
    "VARCHAR(16) NULL COMMENT '展示值来源: official | llm'",
  ],
  ["comment_analysis_language_mix", "JSON NULL COMMENT '受众语言分布 {lang:ratio}'"],
  ["comment_analysis_language_source", "VARCHAR(16) NULL COMMENT '语言来源: official | llm'"],
  ["comment_analysis_content_directions", "JSON NULL COMMENT '评论内容方向 [{label,ratio}]'"],
  ["comment_analysis_fan_loyalty", "JSON NULL COMMENT '粉丝粘性 {score,summary}'"],
  ["comment_analysis_summary", "TEXT NULL COMMENT 'LLM 分析摘要（四行文本）'"],
  ["comment_analysis_videos", "INT NULL COMMENT '样本视频数'"],
  ["comment_analysis_comments", "INT NULL COMMENT '样本评论数'"],
  ["comment_analysis_model", "VARCHAR(64) NULL COMMENT '分析模型'"],
  ["comment_analysis_at", "TIMESTAMP NULL COMMENT '评论分析生成时间'"],
];

async function columnExists(table, column) {
  const rows = await queryTikTok(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows?.[0]?.n || 0) > 0;
}

async function main() {
  const added = [];
  for (const [name, ddl] of COLUMNS) {
    if (await columnExists("tiktok_influencer", name)) continue;
    await queryTikTok(`ALTER TABLE tiktok_influencer ADD COLUMN ${name} ${ddl}`, []);
    added.push(name);
  }
  console.log(
    added.length
      ? `[migrate] tiktok_influencer 新增 ${added.length} 列: ${added.join(", ")}`
      : "[migrate] 所有列已存在，无需变更"
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[migrate] FAILED:", e?.message || e);
  process.exit(1);
});
