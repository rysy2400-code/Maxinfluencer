-- 红人邮件事件表：用于记录「红人来信」等待业务处理的事件

CREATE TABLE IF NOT EXISTS tiktok_influencer_email_events (
  id INT AUTO_INCREMENT PRIMARY KEY,

  -- 关联信息
  influencer_id VARCHAR(128) NULL COMMENT '红人唯一标识（若能解析出来则填，否则为 NULL）',
  message_id VARCHAR(255) NOT NULL COMMENT '邮件 Message-ID',
  conversation_id INT NULL COMMENT '后续可挂载到会话表（可选）',

  -- 邮件快照
  from_email VARCHAR(255) NOT NULL COMMENT '红人邮箱地址',
  to_email VARCHAR(255) NOT NULL COMMENT '我方邮箱地址（企业邮箱）',
  subject VARCHAR(512) NULL,
  body_text TEXT NULL,
  raw_headers TEXT NULL COMMENT '原始头部（可选，用于调试）',
  in_reply_to VARCHAR(255) NULL COMMENT 'In-Reply-To 头部（若存在）',
  received_at TIMESTAMP NULL DEFAULT NULL COMMENT '邮件在服务器上的接收时间（IMAP INTERNALDATE）',

  -- 业务上下文（可选）
  candidate_campaign_ids JSON NULL COMMENT '候选 campaignId 列表，由轮询脚本或后续逻辑填充',

  -- 事件处理状态
  status ENUM('pending','processing','succeeded','failed','skipped') NOT NULL DEFAULT 'pending' COMMENT '事件处理状态',
  error_message TEXT NULL COMMENT '最近一次失败原因',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_message_id (message_id),
  INDEX idx_status (status),
  INDEX idx_influencer_status (influencer_id, status),
  INDEX idx_created_at (created_at DESC),
  INDEX idx_received_at (received_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='红人邮件事件表';

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

-- 给 InfluencerAgent 的事件表：例如需要发送邮件、触发其他动作
CREATE TABLE IF NOT EXISTS tiktok_influencer_agent_event (
  id INT AUTO_INCREMENT PRIMARY KEY,
  influencer_id VARCHAR(128) NULL COMMENT 'tiktok_influencer.influencer_id（平台侧唯一 ID，如 TikTok userId）',
  campaign_id VARCHAR(36) NULL COMMENT '关联的 campaign（如有）',

  event_type VARCHAR(64) NOT NULL COMMENT '事件类型，如 outbound_email 等',
  payload JSON NOT NULL COMMENT '事件载荷（完整参数）',

  status ENUM('pending','processing','succeeded','failed','skipped') NOT NULL DEFAULT 'pending' COMMENT '事件处理状态',
  error_message TEXT NULL COMMENT '最近一次失败原因',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_influencer_status (influencer_id, status),
  INDEX idx_campaign_status (campaign_id, status),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='InfluencerAgent 待处理事件表';

-- 给 Campaign 执行 Agent 的事件表：例如红人同意改时间线、确认脚本等
CREATE TABLE IF NOT EXISTS tiktok_advertiser_agent_event (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id VARCHAR(36) NULL COMMENT 'tiktok_campaign.id',
  influencer_id VARCHAR(128) NULL COMMENT 'tiktok_influencer.influencer_id（如存在）',

  event_type VARCHAR(64) NOT NULL COMMENT '事件类型，如 timeline_change_confirmed 等',
  payload JSON NOT NULL COMMENT '事件载荷（完整参数）',

  status ENUM('pending','processing','succeeded','failed','skipped') NOT NULL DEFAULT 'pending' COMMENT '事件处理状态',
  error_message TEXT NULL COMMENT '最近一次失败原因',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_campaign_status (campaign_id, status),
  INDEX idx_influencer_status (influencer_id, status),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Campaign 执行 Agent 待处理事件表';

-- 红人对话记忆表：记录 Bin 与红人的往来对话（按时间线）
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

