/**
 * 迁移脚本：把 tiktok_influencer_conversation_messages 升级为时间线事件模型（v1）
 *
 * 使用方式：
 *   node scripts/migrate-conversation-messages-to-timeline-v1.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const TABLE_NAME = "tiktok_influencer_conversation_messages";

async function hasColumn(columnName) {
  const rows = await queryTikTok(
    `
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [TABLE_NAME, columnName]
  );
  return rows.length > 0;
}

async function hasIndex(indexName) {
  const rows = await queryTikTok(
    `
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1
    `,
    [TABLE_NAME, indexName]
  );
  return rows.length > 0;
}

async function addColumnIfMissing(columnName, ddl) {
  if (await hasColumn(columnName)) return;
  await queryTikTok(`ALTER TABLE ${TABLE_NAME} ADD COLUMN ${ddl}`);
  console.log(`[migrate-timeline-v1] 已添加字段: ${columnName}`);
}

async function addIndexIfMissing(indexName, ddl) {
  if (await hasIndex(indexName)) return;
  await queryTikTok(`ALTER TABLE ${TABLE_NAME} ADD ${ddl}`);
  console.log(`[migrate-timeline-v1] 已添加索引/约束: ${indexName}`);
}

async function checkDuplicateMessageId() {
  const dupRows = await queryTikTok(
    `
      SELECT influencer_id, message_id, COUNT(*) AS cnt
      FROM ${TABLE_NAME}
      WHERE message_id IS NOT NULL AND TRIM(message_id) <> ''
      GROUP BY influencer_id, message_id
      HAVING COUNT(*) > 1
      LIMIT 20
    `
  );
  return dupRows || [];
}

async function backfillData() {
  await queryTikTok(
    `
      UPDATE ${TABLE_NAME}
      SET event_time = COALESCE(event_time, sent_at, created_at)
      WHERE event_time IS NULL
    `
  );

  await queryTikTok(
    `
      UPDATE ${TABLE_NAME}
      SET event_type = CASE
        WHEN direction = 'influencer' THEN 'email_inbound'
        WHEN direction = 'bin' THEN 'email_outbound'
        ELSE event_type
      END
    `
  );

  await queryTikTok(
    `
      UPDATE ${TABLE_NAME}
      SET actor_type = CASE
        WHEN source_type = 'influencer_email_event' THEN 'system'
        WHEN source_type IN ('llm_outbound_email', 'seed_outreach', 'outbound_email', 'ask_influencer_special_request') THEN 'agent'
        ELSE actor_type
      END
    `
  );

  console.log("[migrate-timeline-v1] 已完成 event_time/event_type/actor_type 回填。");
}

async function main() {
  await addColumnIfMissing(
    "event_type",
    "event_type VARCHAR(64) NOT NULL DEFAULT 'email_outbound' COMMENT '时间线事件类型：email_inbound / email_outbound / draft_outbound / agent_action / campaign_update' AFTER message_id"
  );
  await addColumnIfMissing(
    "event_time",
    "event_time TIMESTAMP NULL DEFAULT NULL COMMENT '事件业务时间（时间线排序主字段）' AFTER event_type"
  );
  await addColumnIfMissing(
    "actor_type",
    "actor_type ENUM('agent','human','system') NOT NULL DEFAULT 'agent' COMMENT '事件执行者类型' AFTER event_time"
  );
  await addColumnIfMissing(
    "actor_id",
    "actor_id VARCHAR(128) NULL COMMENT '执行者 ID（如 agent 名称或人工用户 ID）' AFTER actor_type"
  );
  await addColumnIfMissing(
    "send_mode",
    "send_mode VARCHAR(64) NULL COMMENT '发送模式：auto_send / human_approved / human_manual_send' AFTER actor_id"
  );
  await addColumnIfMissing(
    "content_origin",
    "content_origin VARCHAR(64) NULL COMMENT '内容来源：agent_generated / human_written / human_edited_agent' AFTER send_mode"
  );
  await addColumnIfMissing(
    "trace_id",
    "trace_id VARCHAR(128) NULL COMMENT '同一触发链路追踪 ID' AFTER content_origin"
  );
  await addColumnIfMissing(
    "payload",
    "payload JSON NULL COMMENT '事件扩展信息' AFTER trace_id"
  );

  await backfillData();

  const dupRows = await checkDuplicateMessageId();
  if (dupRows.length > 0) {
    console.error(
      "[migrate-timeline-v1] 发现重复的 (influencer_id, message_id)，请先清理后再创建唯一键：",
      dupRows
    );
    process.exit(1);
  }

  await addIndexIfMissing(
    "uk_influencer_message_id",
    "UNIQUE KEY uk_influencer_message_id (influencer_id, message_id)"
  );
  await addIndexIfMissing(
    "idx_influencer_event_time",
    "INDEX idx_influencer_event_time (influencer_id, event_time DESC)"
  );
  await addIndexIfMissing("idx_trace_id", "INDEX idx_trace_id (trace_id)");

  console.log("[migrate-timeline-v1] 迁移完成。");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[migrate-timeline-v1] 迁移失败:", err?.message || err);
    process.exit(1);
  });
