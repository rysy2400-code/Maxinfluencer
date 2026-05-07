/**
 * 创建 TikTok Influencer 相关表：
 * - tiktok_influencer
 * - tiktok_campaign_influencer_candidates
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function ensureColumn(table, column, definitionSql) {
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
  const exists = rows && rows[0] && Number(rows[0].n || 0) > 0;
  if (exists) return;
  console.log(`执行: ALTER TABLE ${table} ADD COLUMN ${column} ...`);
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${definitionSql}`);
  console.log("  OK");
}

async function dropColumnIfExists(table, column) {
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
  const exists = rows && rows[0] && Number(rows[0].n || 0) > 0;
  if (!exists) return;
  console.log(`执行: ALTER TABLE ${table} DROP COLUMN ${column} ...`);
  await queryTikTok(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
  console.log("  OK");
}

async function ensureIndex(table, indexName, indexSql) {
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
  const exists = rows && rows[0] && Number(rows[0].n || 0) > 0;
  if (exists) return;
  console.log(`执行: ALTER TABLE ${table} ADD ${indexSql} ...`);
  await queryTikTok(`ALTER TABLE ${table} ADD ${indexSql}`);
  console.log("  OK");
}

async function createTables() {
  // 1) 候选池表（若不存在则创建）
  const createCandidates = `
    CREATE TABLE IF NOT EXISTS tiktok_campaign_influencer_candidates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id VARCHAR(36) NOT NULL COMMENT 'tiktok_campaign.id',
      tiktok_username VARCHAR(128) NOT NULL COMMENT 'TikTok handle（无 @）',
      influencer_id VARCHAR(128) NULL COMMENT 'TikTok userId，与 tiktok_influencer.influencer_id 一致',
      source VARCHAR(32) NOT NULL DEFAULT 'echotik' COMMENT '候选来源',
      influencer_snapshot JSON COMMENT '候选时的红人快照（用于回溯，可为空）',
      match_score INT NULL COMMENT '匹配度评分（0-100 或自定义）',
      should_contact TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否建议联系（1=建议联系）',
      email VARCHAR(255) NULL COMMENT '候选红人的主联系邮箱（标准化）',
      has_email TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否有邮箱（1=有）',
      analysis_summary TEXT NULL COMMENT '匹配结论摘要（给前端展示）',
      analyzed_at TIMESTAMP NULL DEFAULT NULL COMMENT '分析完成时间',
      picked_at TIMESTAMP NULL DEFAULT NULL COMMENT '已被执行心跳消费并入执行表的时间',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_campaign_influencer (campaign_id, tiktok_username),
      INDEX idx_candidates_platform_influencer_id (influencer_id),
      INDEX idx_campaign_contact (campaign_id, should_contact, picked_at),
      INDEX idx_campaign_email_contact (campaign_id, has_email, should_contact, picked_at),
      INDEX idx_campaign_score (campaign_id, match_score DESC),
      INDEX idx_campaign_analyzed (campaign_id, analyzed_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Campaign 候选红人池 + 分析结果'
  `;

  console.log("执行: CREATE TABLE IF NOT EXISTS tiktok_campaign_influencer_candidates ...");
  await queryTikTok(createCandidates);
  console.log("  OK");
  await ensureColumn(
    "tiktok_campaign_influencer_candidates",
    "email",
    "email VARCHAR(255) NULL COMMENT '候选红人的主联系邮箱（标准化）' AFTER should_contact"
  );
  await ensureColumn(
    "tiktok_campaign_influencer_candidates",
    "has_email",
    "has_email TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否有邮箱（1=有）' AFTER email"
  );
  await ensureColumn(
    "tiktok_campaign_influencer_candidates",
    "match_analysis",
    "match_analysis JSON NULL COMMENT '结构化匹配分析（长文）；analysis_summary 为短摘要' AFTER analysis_summary"
  );
  await ensureIndex(
    "tiktok_campaign_influencer_candidates",
    "idx_campaign_email_contact",
    "INDEX idx_campaign_email_contact (campaign_id, has_email, should_contact, picked_at)"
  );

  // 2) 全局红人表：如果已存在旧版 tiktok_influencer，则通过 ALTER 补齐 EchoTik 接入需要的列
  const hasInfluencerTable = await queryTikTok("SHOW TABLES LIKE 'tiktok_influencer'");
  if (!hasInfluencerTable || hasInfluencerTable.length === 0) {
    const createInfluencer = `
      CREATE TABLE IF NOT EXISTS tiktok_influencer (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        influencer_id VARCHAR(128) NULL COMMENT '来源侧唯一 ID，如 creator_oecuid',
        platform VARCHAR(32) NOT NULL DEFAULT 'tiktok',
        region VARCHAR(64) NULL,
        username VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NULL,
        profile_url VARCHAR(500) NULL,
        avatar_url VARCHAR(500) NULL,
        followers_count BIGINT NULL,
        avg_views BIGINT NULL,
        influencer_email VARCHAR(255) NULL COMMENT '主联系邮箱（主页抓取 profile_data.userInfo.email）',
        source VARCHAR(32) NULL,
        source_ref VARCHAR(128) NULL,
        source_payload JSON NULL,
        last_fetched_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_username (username),
        UNIQUE KEY uk_influencer_id (influencer_id),
        INDEX idx_followers (followers_count),
        INDEX idx_views (avg_views),
        INDEX idx_updated_at (updated_at DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='TikTok 红人数据表（全局缓存）'
    `;
    console.log("执行: CREATE TABLE IF NOT EXISTS tiktok_influencer ...");
    await queryTikTok(createInfluencer);
    console.log("  OK");
  } else {
    await ensureColumn(
      "tiktok_influencer",
      "influencer_id",
      "influencer_id VARCHAR(128) NULL COMMENT '来源侧唯一 ID，如 creator_oecuid' AFTER id"
    );
    await ensureColumn(
      "tiktok_influencer",
      "platform",
      "platform VARCHAR(32) NOT NULL DEFAULT 'tiktok' AFTER influencer_id"
    );
    await ensureColumn(
      "tiktok_influencer",
      "region",
      "region VARCHAR(64) NULL AFTER platform"
    );
    await ensureColumn(
      "tiktok_influencer",
      "influencer_email",
      "influencer_email VARCHAR(255) NULL COMMENT '主联系邮箱（主页抓取 profile_data.userInfo.email）' AFTER avg_views"
    );
    await ensureColumn(
      "tiktok_influencer",
      "source",
      "source VARCHAR(32) NULL COMMENT '数据来源，如 echotik' AFTER influencer_email"
    );
    await ensureColumn(
      "tiktok_influencer",
      "source_ref",
      "source_ref VARCHAR(128) NULL COMMENT '来源侧 ID，如 creator_oecuid' AFTER source"
    );
    await ensureColumn(
      "tiktok_influencer",
      "source_payload",
      "source_payload JSON NULL COMMENT '来源原始快照（可选）' AFTER source_ref"
    );
    await ensureColumn(
      "tiktok_influencer",
      "last_fetched_at",
      "last_fetched_at TIMESTAMP NULL DEFAULT NULL COMMENT '上次从第三方刷新时间' AFTER source_payload"
    );
    await ensureIndex("tiktok_influencer", "uk_influencer_id", "UNIQUE KEY uk_influencer_id (influencer_id)");
  }

  try {
    await queryTikTok(`
      UPDATE tiktok_influencer
      SET influencer_email = LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(contacts, '$.email'))))
      WHERE (influencer_email IS NULL OR influencer_email = '')
        AND contacts IS NOT NULL
        AND JSON_EXTRACT(contacts, '$.email') IS NOT NULL
    `);
    console.log(
      "[migrate] 已尝试从旧版 contacts JSON 的 $.email 回填 influencer_email（仅填补空值）。"
    );
  } catch (e) {
    console.warn("[migrate] influencer_email 回填跳过:", e.message);
  }

  try {
    await dropColumnIfExists("tiktok_influencer", "contacts");
    console.log("[migrate] 已移除 tiktok_influencer.contacts 列（若曾存在）。");
  } catch (e) {
    console.warn("[migrate] DROP COLUMN contacts 跳过:", e.message);
  }

  console.log("\n✅ TikTok Influencer 相关表/字段已就绪。");
  process.exit(0);
}

createTables().catch((err) => {
  console.error("❌ 创建/迁移表失败:", err.message);
  process.exit(1);
});

