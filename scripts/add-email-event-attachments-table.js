/**
 * 一次性脚本：创建 tiktok_influencer_email_event_attachments 表（用于存储邮件附件内容）
 *
 * 使用方式：
 *   node scripts/add-email-event-attachments-table.js
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config({ path: path.join(projectRoot, ".env.local") });

async function main() {
  try {
    await queryTikTok(
      `
      CREATE TABLE IF NOT EXISTS tiktok_influencer_email_event_attachments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_id INT NOT NULL COMMENT 'tiktok_influencer_email_events.id',
        message_id VARCHAR(255) NOT NULL COMMENT '冗余保存，便于排查/联查',

        part VARCHAR(64) NULL COMMENT 'IMAP BODYSTRUCTURE part number，例如 2 或 1.2',
        content_id VARCHAR(255) NULL COMMENT 'Content-ID（若有）',

        filename VARCHAR(512) NULL,
        content_type VARCHAR(128) NULL,
        size_bytes INT NULL,

        content LONGBLOB NOT NULL COMMENT '附件二进制内容（已解码后的原始 bytes）',

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        UNIQUE KEY uk_event_part (event_id, part),
        INDEX idx_event_id (event_id),
        INDEX idx_message_id (message_id),
        INDEX idx_content_type (content_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='红人邮件事件附件表';
    `
    );

    console.log(
      "[add-email-event-attachments-table] 已确保 tiktok_influencer_email_event_attachments 表存在。"
    );
  } catch (err) {
    console.error(
      "[add-email-event-attachments-table] 执行建表失败：",
      err?.message || err
    );
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      "[add-email-event-attachments-table] 脚本运行出错：",
      err?.message || err
    );
    process.exit(1);
  });

