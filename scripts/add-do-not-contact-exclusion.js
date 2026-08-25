/**
 * 迁移：候选表加 do_not_contact 列 + 新建全局红人触达排除表
 * 幂等，可重复执行。
 */
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

async function columnExists(table, column) {
  const rows = await queryTikTok(
    `
    SELECT 1 AS ok
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    LIMIT 1
  `,
    [table, column]
  );
  return !!(rows && rows.length > 0);
}

async function main() {
  if (!(await columnExists("tiktok_campaign_influencer_candidates", "do_not_contact"))) {
    await queryTikTok(
      `
      ALTER TABLE tiktok_campaign_influencer_candidates
        ADD COLUMN do_not_contact TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '用户导入不联系名单标记（1=硬性不联系，不随分析结果翻回）'
        AFTER should_contact
    `,
      []
    );
    console.log("[migrate] added tiktok_campaign_influencer_candidates.do_not_contact");
  } else {
    console.log("[migrate] do_not_contact column already exists");
  }

  await queryTikTok(
    `
    CREATE TABLE IF NOT EXISTS tiktok_influencer_contact_exclusion (
      id INT AUTO_INCREMENT PRIMARY KEY,
      platform VARCHAR(32) NOT NULL COMMENT '平台 slug：youtube/instagram/tiktok',
      handle VARCHAR(128) NOT NULL COMMENT '小写 handle（无 @）',
      profile_url VARCHAR(1024) NULL COMMENT '规范化主页链接',
      display_name VARCHAR(256) NULL COMMENT '展示名（如有）',
      source_file VARCHAR(255) NULL COMMENT '来源文件名',
      source_batch_id VARCHAR(64) NULL COMMENT '来源导入批次',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_platform_handle (platform, handle),
      INDEX idx_handle (handle)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='全局红人触达排除名单（用户导入，不联系）'
  `,
    []
  );
  console.log("[migrate] tiktok_influencer_contact_exclusion ready");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[migrate] failed:", e?.message || e);
    process.exit(1);
  });
