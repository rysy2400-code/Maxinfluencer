-- TikTok Campaign 业务表（tiktok 库）
-- 1. tiktok_campaign：Campaign 配置与 4 大板块快照
-- 2. tiktok_campaign_execution：按红人维度的执行状态

CREATE TABLE IF NOT EXISTS tiktok_campaign (
  id VARCHAR(36) PRIMARY KEY COMMENT 'Campaign 业务 ID，如 CAMP-xxx',
  session_id VARCHAR(36) NOT NULL COMMENT '关联 campaign_sessions.id',

  -- 便于筛选与报表的关键字段
  platform VARCHAR(32) NOT NULL COMMENT '主投放平台，如 tiktok',
  region VARCHAR(64) NOT NULL COMMENT '主投放地区，如 US',
  start_date DATE NULL COMMENT '发布时间段起',
  end_date DATE NULL COMMENT '发布时间段止',
  budget DECIMAL(10,2) NULL COMMENT '总预算，USD',
  commission DECIMAL(5,2) NULL COMMENT '佣金百分比',

  -- 四个板块的完整快照
  product_info JSON COMMENT '产品信息快照',
  campaign_info JSON COMMENT 'Campaign 信息快照（平台、地区、预算、发布时间等）',
  influencer_profile JSON COMMENT '红人画像快照',
  content_script JSON COMMENT '内容脚本快照',

  influencers_per_day INT NOT NULL DEFAULT 5 COMMENT '每天联系红人数量',
  status ENUM('draft','running','paused','completed','deleted') NOT NULL DEFAULT 'running' COMMENT 'Campaign 状态',
  deleted_at DATETIME NULL COMMENT '软删除时间',
  deleted_by VARCHAR(64) NULL COMMENT '删除操作者（user/agent/system）',
  delete_reason VARCHAR(255) NULL COMMENT '删除原因',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_session_id (session_id),
  INDEX idx_platform_region_date (platform, region, start_date, end_date),
  INDEX idx_status (status),
  INDEX idx_updated_at (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='TikTok Campaign 配置与快照';


CREATE TABLE IF NOT EXISTS tiktok_campaign_execution (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id VARCHAR(36) NOT NULL COMMENT 'tiktok_campaign.id',
  influencer_id VARCHAR(128) NOT NULL COMMENT '红人唯一标识（如 TikTok 用户名或内部 ID）',

  influencer_snapshot JSON COMMENT '红人快照（画像 + 主页数据 + 评估等）',

  stage ENUM(
    'pending_quote',
    'quote_submitted',
    'pending_sample',
    'sample_sent',
    'pending_draft',
    'draft_submitted',
    'published',
    'failed'
  ) NOT NULL DEFAULT 'pending_quote' COMMENT '执行阶段',

  -- 商务/交付信息（可随流程逐步填写）
  flat_fee DECIMAL(10,2) NULL COMMENT '一次性合作费用（USD）',
  sku VARCHAR(255) NULL COMMENT 'SKU（用于寄样/对账）',
  shipping_info JSON NULL COMMENT '本次寄样信息快照（地址/收件人/电话/备注等）',
  video_draft JSON NULL COMMENT '草稿与修改建议（建议存数组：[{draftLink, feedback, status, createdAt}]）',
  video_link VARCHAR(1024) NULL COMMENT '最终视频链接（发布后填写）',
  adcode VARCHAR(255) NULL COMMENT '投放/追踪 code（如 adcode/utm 等）',

  last_event JSON COMMENT '最近一次事件/备注（可扩展）',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_campaign_influencer (campaign_id, influencer_id),
  INDEX idx_campaign_stage (campaign_id, stage),
  INDEX idx_stage (stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='TikTok Campaign 执行明细（按红人）';

