// 创建“未归属邮件待确认队列”表（幂等）
import { queryTikTok } from "../lib/db/mysql-tiktok.js";

await queryTikTok(`
  CREATE TABLE IF NOT EXISTS tiktok_influencer_email_attribution_queue (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    email_event_id BIGINT NOT NULL,
    from_email VARCHAR(255) NULL,
    to_email VARCHAR(255) NULL,
    subject VARCHAR(512) NULL,
    in_reply_to VARCHAR(255) NULL,
    body_excerpt TEXT NULL,
    reason VARCHAR(64) NULL,
    status ENUM('pending','claimed','ignored') NOT NULL DEFAULT 'pending',
    claimed_influencer_id VARCHAR(128) NULL,
    claimed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_email_event_id (email_event_id),
    KEY idx_status_created (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`);

console.log("✅ tiktok_influencer_email_attribution_queue 表已就绪");
process.exit(0);
