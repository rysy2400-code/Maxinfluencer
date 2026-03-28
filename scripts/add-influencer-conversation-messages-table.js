/**
 * 一次性脚本：创建 tiktok_influencer_conversation_messages 表（红人对话记忆）
 *
 * 使用方式：
 *   node scripts/add-influencer-conversation-messages-table.js
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
      CREATE TABLE IF NOT EXISTS tiktok_influencer_conversation_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,

        influencer_id VARCHAR(128) NULL COMMENT 'tiktok_influencer.influencer_id（如能解析则填）',
        campaign_id VARCHAR(36) NULL COMMENT '关联的 tiktok_campaign.id（如有）',

        direction ENUM('bin','influencer') NOT NULL COMMENT 'bin=我方，influencer=红人',
        channel ENUM('email') NOT NULL DEFAULT 'email' COMMENT '沟通渠道，当前仅支持 email，预留扩展',

        from_email VARCHAR(255) NULL COMMENT '发件邮箱',
        to_email VARCHAR(255) NULL COMMENT '收件邮箱',
        subject VARCHAR(512) NULL,
        body_text TEXT NOT NULL COMMENT '已清洗后的可读正文',

        message_id VARCHAR(255) NULL COMMENT '邮件 Message-ID（如有）',

        source_type VARCHAR(64) NOT NULL COMMENT '消息来源类型：seed_outreach / influencer_email_event / influencer_agent_event / llm_outbound 等',
        source_event_table VARCHAR(64) NULL COMMENT '来源事件表名：tiktok_influencer_email_events / tiktok_influencer_agent_event / tiktok_advertiser_agent_event 等',
        source_event_id INT NULL COMMENT '来源事件表主键 ID',

        sent_at TIMESTAMP NULL DEFAULT NULL COMMENT '消息发送/接收时间（业务时间）',

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

        INDEX idx_influencer_time (influencer_id, sent_at),
        INDEX idx_campaign_time (campaign_id, sent_at),
        INDEX idx_message_id (message_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='红人对话记忆表（Bin 与红人的往来对话）';
    `
    );

    console.log(
      "[add-influencer-conversation-messages-table] 已确保 tiktok_influencer_conversation_messages 表存在。"
    );
  } catch (err) {
    console.error(
      "[add-influencer-conversation-messages-table] 执行建表失败：",
      err?.message || err
    );
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      "[add-influencer-conversation-messages-table] 脚本运行出错：",
      err?.message || err
    );
    process.exit(1);
  });

