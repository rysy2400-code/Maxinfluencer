/**
 * 创建 tiktok_influencer_search_task 任务表。
 *
 * 用法：
 *   node scripts/create-influencer-search-task-table.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
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
  return (rows?.[0]?.n || 0) > 0;
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
  return (rows?.[0]?.n || 0) > 0;
}

async function ensureColumn(table, column, ddl) {
  const ok = await columnExists(table, column);
  if (ok) return false;
  await queryTikTok(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

async function ensureIndex(table, indexName, ddl) {
  const ok = await indexExists(table, indexName);
  if (ok) return false;
  await queryTikTok(`ALTER TABLE ${table} ADD ${ddl}`);
  return true;
}

async function dropIndexIfExists(table, indexName) {
  const ok = await indexExists(table, indexName);
  if (!ok) return false;
  await queryTikTok(`ALTER TABLE ${table} DROP INDEX ${indexName}`);
  return true;
}

function splitSqlStatements(sqlText) {
  const lines = String(sqlText || "").split("\n");
  const withoutComments = lines
    .map((line) => line.replace(/--.*$/, "").trimEnd())
    .join("\n");

  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const schemaPath = path.join(
    __dirname,
    "../lib/db/influencer-search-task-schema.sql"
  );
  const sql = fs.readFileSync(schemaPath, "utf8");
  // mysql2 默认不允许 multiStatements；这里手动拆分并清理行注释。
  const statements = splitSqlStatements(sql);
  for (const stmt of statements) {
    await queryTikTok(stmt);
  }

  // 注意：CREATE TABLE IF NOT EXISTS 不会更新已存在表结构。
  // 下面补齐新增列/索引，保证脚本可重复执行（幂等）。
  const taskTable = "tiktok_influencer_search_task";

  const changed = [];
  if (await ensureColumn(taskTable, "session_id", "session_id VARCHAR(36) NULL COMMENT '关联 campaign_sessions.id，供工作实况订阅路由'")) changed.push("task.session_id");
  if (await ensureColumn(taskTable, "run_id", "run_id VARCHAR(64) NULL COMMENT '执行批次 ID（通常为 campaign + date）'")) changed.push("task.run_id");
  if (await ensureColumn(taskTable, "keyword", "keyword VARCHAR(255) NULL COMMENT '本任务主关键词（单任务单关键词）'")) changed.push("task.keyword");
  if (await ensureColumn(taskTable, "keyword_type", "keyword_type ENUM('new','variant','high_performer','fallback') NOT NULL DEFAULT 'new'")) changed.push("task.keyword_type");
  if (await ensureColumn(taskTable, "worker_host", "worker_host VARCHAR(128) NULL COMMENT '执行机器标识（可选）'")) changed.push("task.worker_host");
  if (await ensureColumn(taskTable, "worker_ip", "worker_ip VARCHAR(64) NULL COMMENT '执行机器 IP（可选）'")) changed.push("task.worker_ip");
  if (await ensureColumn(taskTable, "last_progress_at", "last_progress_at DATETIME NULL COMMENT '最近一次确认任务有推进的时间（用于 stuck 回收）'")) changed.push("task.last_progress_at");
  if (await ensureColumn(taskTable, "progress_analyzed_count", "progress_analyzed_count INT NOT NULL DEFAULT 0 COMMENT 'LLM 分析完成并写入候选池'")) changed.push("task.progress_analyzed_count");
  if (await ensureColumn(taskTable, "progress_search_found_count", "progress_search_found_count INT NOT NULL DEFAULT 0 COMMENT '关键词搜索池频道数（已获取）'")) changed.push("task.progress_search_found_count");
  if (await ensureColumn(taskTable, "progress_profile_browsed_count", "progress_profile_browsed_count INT NOT NULL DEFAULT 0 COMMENT '已浏览主页（含国家预筛与完整 enrich）'")) changed.push("task.progress_profile_browsed_count");
  if (await ensureColumn(taskTable, "progress_recommended_count", "progress_recommended_count INT NOT NULL DEFAULT 0 COMMENT '符合红人画像（isRecommended=true）'")) changed.push("task.progress_recommended_count");
  if (await ensureColumn(taskTable, "progress_contactable_count", "progress_contactable_count INT NOT NULL DEFAULT 0 COMMENT '可联系（符合画像且有邮箱）'")) changed.push("task.progress_contactable_count");
  if (await ensureColumn(taskTable, "progress_skip_country_unknown_count", "progress_skip_country_unknown_count INT NOT NULL DEFAULT 0 COMMENT '因国家未知跳过分析'")) changed.push("task.progress_skip_country_unknown_count");
  if (await ensureColumn(taskTable, "progress_skip_country_mismatch_count", "progress_skip_country_mismatch_count INT NOT NULL DEFAULT 0 COMMENT '因国家不符合跳过分析'")) changed.push("task.progress_skip_country_mismatch_count");
  if (
    await ensureColumn(
      taskTable,
      "platform",
      "platform VARCHAR(24) NOT NULL DEFAULT 'tiktok' COMMENT '投放平台 slug：tiktok|instagram|youtube'"
    )
  ) {
    changed.push("task.platform");
  }

  try {
    await queryTikTok(
      `
      UPDATE ${taskTable}
      SET platform = LOWER(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.platform')), ''))
      WHERE JSON_EXTRACT(payload, '$.platform') IS NOT NULL
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.platform')) != ''
    `
    );
  } catch {
    /* ignore backfill errors */
  }

  // indexes / unique key（同 run 同关键词可多平台各一条）
  if (await ensureIndex(taskTable, "idx_campaign_run", "INDEX idx_campaign_run (campaign_id, run_id)")) changed.push("task.idx_campaign_run");
  if (await ensureIndex(taskTable, "idx_session_status", "INDEX idx_session_status (session_id, status)")) changed.push("task.idx_session_status");
  if (await ensureIndex(taskTable, "idx_keyword", "INDEX idx_keyword (campaign_id, keyword, created_at)")) changed.push("task.idx_keyword");
  if (await ensureIndex(taskTable, "idx_worker_host_ip_status", "INDEX idx_worker_host_ip_status (worker_host, worker_ip, status)")) changed.push("task.idx_worker_host_ip_status");
  if (await ensureIndex(taskTable, "idx_worker_platform_started", "INDEX idx_worker_platform_started (worker_ip, platform, started_at DESC)")) changed.push("task.idx_worker_platform_started");
  if (await ensureIndex(taskTable, "idx_worker_platform_finished", "INDEX idx_worker_platform_finished (worker_ip, platform, finished_at DESC)")) changed.push("task.idx_worker_platform_finished");
  if (await dropIndexIfExists(taskTable, "uk_campaign_run_keyword")) changed.push("task.drop_uk_campaign_run_keyword");
  if (
    await ensureIndex(
      taskTable,
      "uk_campaign_run_keyword_platform",
      "UNIQUE KEY uk_campaign_run_keyword_platform (campaign_id, run_id, keyword, platform)"
    )
  ) {
    changed.push("task.uk_campaign_run_keyword_platform");
  }

  const resultTable = "tiktok_keyword_run_result";
  if (await ensureColumn(resultTable, "assigned_worker_ip", "assigned_worker_ip VARCHAR(64) NULL COMMENT '执行机器 IP（可选）'")) changed.push("result.assigned_worker_ip");
  if (
    await ensureColumn(
      resultTable,
      "platform",
      "platform VARCHAR(24) NOT NULL DEFAULT 'tiktok' COMMENT '投放平台 slug：tiktok|instagram|youtube'"
    )
  ) {
    changed.push("result.platform");
  }
  if (await dropIndexIfExists(resultTable, "uk_campaign_run_keyword")) changed.push("result.drop_uk_campaign_run_keyword");
  if (
    await ensureIndex(
      resultTable,
      "uk_campaign_run_keyword_platform",
      "UNIQUE KEY uk_campaign_run_keyword_platform (campaign_id, run_id, keyword, platform)"
    )
  ) {
    changed.push("result.uk_campaign_run_keyword_platform");
  }
  if (await ensureIndex(resultTable, "idx_worker_ip_time", "INDEX idx_worker_ip_time (assigned_worker_host, assigned_worker_ip, created_at)")) changed.push("result.idx_worker_ip_time");

  if (changed.length) {
    console.log("✅ tiktok_influencer_search_task 已补齐字段/索引:", changed.join(", "));
  } else {
    console.log("✅ tiktok_influencer_search_task 表结构已是最新（无需变更）。");
  }

  console.log("✅ 已确保 tiktok_keyword_run_result 表存在。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ 创建 tiktok_influencer_search_task 失败:", err?.message || err);
    process.exit(1);
  });
