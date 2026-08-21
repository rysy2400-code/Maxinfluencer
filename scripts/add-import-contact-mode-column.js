/**
 * 导入任务联系模式：recommended_only（只联系符合投放地区和画像要求且推荐的红人）| contact_all（联系符合投放地区的所有红人）。
 *
 * 用法:
 *   node scripts/add-import-contact-mode-column.js
 */
import { queryTikTok, tiktokPool } from "../lib/db/mysql-tiktok.js";

const rows = await queryTikTok(
  `
  SELECT COLUMN_NAME
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tiktok_influencer_import_task'
    AND COLUMN_NAME = 'contact_mode'
`
);
if (rows?.length) {
  console.log("[migrate] contact_mode 已存在，跳过");
} else {
  await queryTikTok(
    `
    ALTER TABLE tiktok_influencer_import_task
    ADD COLUMN contact_mode VARCHAR(24) NOT NULL DEFAULT 'recommended_only'
      COMMENT 'recommended_only=只联系符合投放地区和画像要求且推荐的红人; contact_all=联系符合投放地区的所有红人'
      AFTER platform
  `
  );
  console.log("[migrate] 已添加 contact_mode");
}

await tiktokPool.end();
console.log("[migrate] 完成");
