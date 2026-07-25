CREATE TABLE IF NOT EXISTS email_outreach_delivery_fact (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  campaign_id VARCHAR(36) NOT NULL,
  influencer_id VARCHAR(128) NOT NULL,
  outreach_message_id VARCHAR(255) NOT NULL,
  sender_email VARCHAR(255) NOT NULL,
  sender_domain VARCHAR(255) NOT NULL,
  recipient_email VARCHAR(255) NULL,
  sent_at TIMESTAMP NOT NULL,
  first_reply_message_id VARCHAR(255) NULL,
  first_reply_at TIMESTAMP NULL,
  bounce_message_id VARCHAR(255) NULL,
  bounce_at TIMESTAMP NULL,
  match_method VARCHAR(64) NULL,
  match_confidence ENUM('exact','high') NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_outreach_message_id (outreach_message_id),
  UNIQUE KEY uk_campaign_influencer (campaign_id, influencer_id),
  INDEX idx_sender_sent (sender_email, sent_at),
  INDEX idx_domain_sent (sender_domain, sent_at),
  INDEX idx_reply_at (first_reply_at),
  INDEX idx_bounce_at (bounce_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='首邀投递与首次回复事实表';

CREATE TABLE IF NOT EXISTS email_inbound_attribution_audit (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  inbound_message_id VARCHAR(255) NOT NULL,
  recipient_email VARCHAR(255) NULL,
  sender_email VARCHAR(255) NULL,
  received_at TIMESTAMP NOT NULL,
  inbound_type ENUM('reply','bounce') NOT NULL DEFAULT 'reply',
  attribution_status ENUM('matched','unattributed') NOT NULL DEFAULT 'unattributed',
  outreach_fact_id BIGINT NULL,
  match_method VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_inbound_message_id (inbound_message_id),
  INDEX idx_recipient_received (recipient_email, received_at),
  INDEX idx_status_received (attribution_status, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='入站邮件归因审计表';
