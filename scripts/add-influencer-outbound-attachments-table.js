/**
 * 一次性脚本：创建 tiktok_influencer_outbound_attachments 表（用于存储发件附件内容）
 *
 * 使用方式：
 *   node scripts/add-influencer-outbound-attachments-table.js
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
  await queryTikTok(
    `
    CREATE TABLE IF NOT EXISTS tiktok_influencer_outbound_attachments (
      id INT AUTO_INCREMENT PRIMARY KEY,

      conversation_message_id BIGINT NULL COMMENT '发送成功后回填关联到 tiktok_influencer_conversation_messages.id',
      dedupe_key VARCHAR(255) NOT NULL COMMENT '幂等键：outatt:{client_message_id}:{index}',

      filename VARCHAR(512) NULL,
      content_type VARCHAR(128) NULL,
      size_bytes INT NULL,

      content LONGBLOB NOT NULL COMMENT '附件二进制内容（原始 bytes）',

      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE KEY uk_dedupe_key (dedupe_key),
      INDEX idx_conversation_message_id (conversation_message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='红人发件附件表（outbound）';
  `
  );

  console.log(
    "[add-influencer-outbound-attachments-table] 已确保 tiktok_influencer_outbound_attachments 表存在。"
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      "[add-influencer-outbound-attachments-table] 运行失败：",
      err?.message || err
    );
    process.exit(1);
  });

