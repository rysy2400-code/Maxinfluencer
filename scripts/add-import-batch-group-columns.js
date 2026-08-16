/**
 * 平台拆分导入：给 tiktok_influencer_import_task 增加批次分组与汇报标记列。
 *
 * 用法:
 *   node scripts/add-import-batch-group-columns.js
 */
import { queryTikTok, tiktokPool } from "../lib/db/mysql-tiktok.js";

async function ensureColumn(column, ddl) {
  const rows = await queryTikTok(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tiktok_influencer_import_task'
      AND COLUMN_NAME = ?
  `,
    [column]
  );
  if (rows?.length) {
    console.log(`[migrate] 列已存在，跳过: ${column}`);
    return;
  }
  await queryTikTok(`ALTER TABLE tiktok_influencer_import_task ADD COLUMN ${ddl}`);
  console.log(`[migrate] 已添加列: ${column}`);
}

async function ensureIndex(indexName, ddl) {
  const rows = await queryTikTok(
    `
    SELECT INDEX_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tiktok_influencer_import_task'
      AND INDEX_NAME = ?
    LIMIT 1
  `,
    [indexName]
  );
  if (rows?.length) {
    console.log(`[migrate] 索引已存在，跳过: ${indexName}`);
    return;
  }
  await queryTikTok(`ALTER TABLE tiktok_influencer_import_task ADD INDEX ${ddl}`);
  console.log(`[migrate] 已添加索引: ${indexName}`);
}

await ensureColumn(
  "batch_group_id",
  "batch_group_id VARCHAR(64) NULL COMMENT '平台子任务公共批次号（用于全部完成后汇总汇报）' AFTER import_batch_id"
);
await ensureColumn(
  "batch_group_reported_at",
  "batch_group_reported_at DATETIME NULL COMMENT '批次汇总已汇报时间（防重复汇报）' AFTER result_summary"
);
await ensureIndex(
  "idx_campaign_batch_group",
  "idx_campaign_batch_group (campaign_id, batch_group_id)"
);

await tiktokPool.end();
console.log("[migrate] 完成");
