/**
 * 幂等补齐：
 * - TikTok_influencer.video_publish_country / video_publish_country_source / video_publish_country_checked_at
 * - tiktok_influencer_search_task.progress_country_* / progress_enriched_count
 *
 * 用法: node scripts/add-video-publish-country-columns.js
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
  const changed = [];

  const influencerCols = [
    [
      "video_publish_country",
      "video_publish_country VARCHAR(16) NULL COMMENT '代表视频 locationCreated（发布地）'",
    ],
    [
      "video_publish_country_source",
      "video_publish_country_source VARCHAR(64) NULL COMMENT '国家来源：video_detail / about_page / email_reply 等'",
    ],
    [
      "video_publish_country_checked_at",
      "video_publish_country_checked_at DATETIME NULL COMMENT '最近一次从视频详情页写入发布地时间'",
    ],
  ];

  for (const [col, ddl] of influencerCols) {
    if (await ensureColumn("TikTok_influencer", col, ddl)) {
      changed.push(`TikTok_influencer.${col}`);
    }
  }

  const taskCols = [
    [
      "progress_country_checked_count",
      "progress_country_checked_count INT NOT NULL DEFAULT 0 COMMENT '已完成视频详情页国家采集的人数'",
    ],
    [
      "progress_country_passed_count",
      "progress_country_passed_count INT NOT NULL DEFAULT 0 COMMENT '发布地符合 campaign.countries 的人数'",
    ],
    [
      "progress_enriched_count",
      "progress_enriched_count INT NOT NULL DEFAULT 0 COMMENT '已完成主页 enrich 的人数'",
    ],
  ];

  for (const [col, ddl] of taskCols) {
    if (await ensureColumn("tiktok_influencer_search_task", col, ddl)) {
      changed.push(`tiktok_influencer_search_task.${col}`);
    }
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
