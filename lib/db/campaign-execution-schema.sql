-- Campaign 执行相关表（tiktok 库）
-- 1. campaigns：已发布的 campaign 主表
-- 2. tiktok_campaign_report_config：广告主汇报配置
-- 3. influencer_special_requests：红人特殊请求及反馈

-- 已发布的 Campaign
CREATE TABLE IF NOT EXISTS campaigns (
  id VARCHAR(36) PRIMARY KEY COMMENT 'Campaign 业务 ID，如 CAMP-xxx',
  session_id VARCHAR(36) NOT NULL COMMENT '关联 campaign_sessions.id',
  product_info JSON COMMENT '产品信息快照',
  campaign_info JSON COMMENT 'Campaign 信息快照（平台、地区、预算、发布时间等）',
  influencer_profile JSON COMMENT '红人画像快照',
  influencers JSON COMMENT '红人列表快照',
  content_script JSON COMMENT '内容脚本快照',
  status ENUM('running', 'paused', 'completed') NOT NULL DEFAULT 'running',
  influencers_per_day INT NOT NULL DEFAULT 5 COMMENT '每天联系红人数量',
  execution_state JSON COMMENT '红人执行状态：{ "influencerId": "pending_quote|quote_submitted|pending_sample|draft_submitted|published", ... } 或按需扩展',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_session_id (session_id),
  INDEX idx_status (status),
  INDEX idx_updated_at (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='已发布 Campaign 表';

-- 汇报配置（每个 campaign 一条，按广告主习惯）
CREATE TABLE IF NOT EXISTS tiktok_campaign_report_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id VARCHAR(36) NOT NULL COMMENT 'campaigns.id',
  interval_hours DECIMAL(6,2) NOT NULL DEFAULT 24 COMMENT '两次汇报间隔（小时），如 24=每天一次，48=每2天一次',
  report_time VARCHAR(5) NOT NULL DEFAULT '09:00' COMMENT 'HH:mm 24h',
  content_preference ENUM('brief', 'detailed', 'summary_only') NOT NULL DEFAULT 'brief',
  include_metrics JSON COMMENT '包含的指标，如 ["pending_price_count","pending_sample_count","pending_draft_count","published_count"]',
  abnormal_rules JSON COMMENT '异常汇报规则：最小集合（阈值、冷却时间等），由心跳 worker 解析',
  last_report_at TIMESTAMP NULL DEFAULT NULL COMMENT '上一次常规汇报时间',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_campaign_id (campaign_id),
  INDEX idx_campaign_id (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='TikTok Campaign 汇报配置';

-- 红人特殊请求及反馈（延后发布、改内容等）
CREATE TABLE IF NOT EXISTS influencer_special_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(64) NOT NULL COMMENT '业务请求 ID，如 req_xxx',
  campaign_id VARCHAR(36) NOT NULL,
  influencer_id VARCHAR(128) NOT NULL,
  request_type VARCHAR(32) NOT NULL COMMENT 'delay_publish, change_content, adjust_price, other',
  request_detail TEXT NOT NULL,
  deadline DATETIME NULL COMMENT '期望红人回复截止时间',
  status ENUM('pending', 'replied', 'failed') NOT NULL DEFAULT 'pending',
  influencer_reply TEXT NULL COMMENT '红人回复内容',
  synced_to_advertiser TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_request_id (request_id),
  INDEX idx_campaign_influencer (campaign_id, influencer_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='红人特殊请求与反馈';
