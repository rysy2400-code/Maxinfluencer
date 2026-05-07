/**
 * 一次性迁移：
 * - tiktok_campaign_execution：原 influencer_id（实为 handle）→ tiktok_username；新增可空 influencer_id（TikTok userId）
 * - tiktok_campaign_influencer_candidates：同上
 * - 从 tiktok_influencer 按 username 回填 influencer_id
 *
 * 用法：node scripts/migrate-execution-candidates-tiktok-username.mjs
 * 幂等：已存在 tiktok_username 列则跳过表结构变更，仍执行回填 SQL（仅更新 NULL）。
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local") });

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

async function indexExists(table, indexName) {
  const rows = await queryTikTok(
    `
    SELECT COUNT(*) AS n
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND INDEX_NAME = ?
  `,
    [table, indexName]
  );
  return Number(rows?.[0]?.n || 0) > 0;
}

async function migrateTableExecution() {
  const table = "tiktok_campaign_execution";
  if (await columnExists(table, "tiktok_username")) {
    console.log(`[migrate] ${table} 已有 tiktok_username，跳过 DDL。`);
  } else {
    if (await indexExists(table, "uk_campaign_influencer")) {
      await queryTikTok(`ALTER TABLE \`${table}\` DROP INDEX uk_campaign_influencer`);
      console.log(`[migrate] ${table} 已删除 uk_campaign_influencer`);
    }
    await queryTikTok(`
      ALTER TABLE \`${table}\`
      CHANGE COLUMN influencer_id tiktok_username VARCHAR(128) NOT NULL
        COMMENT 'TikTok handle（小写、无 @）'
    `);
    await queryTikTok(`
      ALTER TABLE \`${table}\`
      ADD COLUMN influencer_id VARCHAR(128) NULL
        COMMENT 'TikTok userId，与 tiktok_influencer.influencer_id 一致'
      AFTER tiktok_username
    `);
    await queryTikTok(`
      ALTER TABLE \`${table}\`
      ADD UNIQUE KEY uk_campaign_influencer (campaign_id, tiktok_username)
    `);
    if (!(await indexExists(table, "idx_execution_platform_influencer_id"))) {
      await queryTikTok(`
        ALTER TABLE \`${table}\`
        ADD INDEX idx_execution_platform_influencer_id (influencer_id)
      `);
    }
    console.log(`[migrate] ${table} DDL 完成`);
  }

  const upExec = await queryTikTok(
    `
    UPDATE tiktok_campaign_execution e
    INNER JOIN tiktok_influencer i ON i.username = e.tiktok_username
    SET e.influencer_id = COALESCE(e.influencer_id, i.influencer_id)
    WHERE e.influencer_id IS NULL OR e.influencer_id = ''
  `
  );
  console.log(
    "[migrate] execution 回填 influencer_id，affectedRows:",
    upExec?.affectedRows ?? upExec
  );
}

async function migrateTableCandidates() {
  const table = "tiktok_campaign_influencer_candidates";
  if (await columnExists(table, "tiktok_username")) {
    console.log(`[migrate] ${table} 已有 tiktok_username，跳过 DDL。`);
  } else {
    if (await indexExists(table, "uk_campaign_influencer")) {
      await queryTikTok(`ALTER TABLE \`${table}\` DROP INDEX uk_campaign_influencer`);
      console.log(`[migrate] ${table} 已删除 uk_campaign_influencer`);
    }
    await queryTikTok(`
      ALTER TABLE \`${table}\`
      CHANGE COLUMN influencer_id tiktok_username VARCHAR(128) NOT NULL
        COMMENT 'TikTok handle（小写、无 @）'
    `);
    await queryTikTok(`
      ALTER TABLE \`${table}\`
      ADD COLUMN influencer_id VARCHAR(128) NULL
        COMMENT 'TikTok userId，与 tiktok_influencer.influencer_id 一致'
      AFTER tiktok_username
    `);
    await queryTikTok(`
      ALTER TABLE \`${table}\`
      ADD UNIQUE KEY uk_campaign_influencer (campaign_id, tiktok_username)
    `);
    if (!(await indexExists(table, "idx_candidates_platform_influencer_id"))) {
      await queryTikTok(`
        ALTER TABLE \`${table}\`
        ADD INDEX idx_candidates_platform_influencer_id (influencer_id)
      `);
    }
    console.log(`[migrate] ${table} DDL 完成`);
  }

  const upCand = await queryTikTok(
    `
    UPDATE tiktok_campaign_influencer_candidates c
    INNER JOIN tiktok_influencer i ON i.username = c.tiktok_username
    SET c.influencer_id = COALESCE(c.influencer_id, i.influencer_id)
    WHERE c.influencer_id IS NULL OR c.influencer_id = ''
  `
  );
  console.log(
    "[migrate] candidates 回填 influencer_id，affectedRows:",
    upCand?.affectedRows ?? upCand
  );
}

async function main() {
  await migrateTableExecution();
  await migrateTableCandidates();
  console.log("[migrate] ✅ 完成");
}

main().catch((e) => {
  console.error("[migrate] 失败:", e?.message || e);
  process.exit(1);
});
