-- TikTok Influencer 相关表（tiktok 库）
-- 1) tiktok_influencer：全局红人主数据/缓存（用于减少第三方 API 调用）
-- 2) tiktok_campaign_influencer_candidates：按 campaign 维度的候选池 + 分析结果（支撑“已分析红人”与心跳挑选）

CREATE TABLE IF NOT EXISTS tiktok_influencer (
  influencer_id VARCHAR(128) PRIMARY KEY COMMENT '红人唯一标识（建议使用 EchoTik creator_oecuid 或平台唯一 ID）',

  platform VARCHAR(32) NOT NULL DEFAULT 'tiktok' COMMENT '平台，如 tiktok/instagram/youtube（预留）',
  region VARCHAR(64) NULL COMMENT '主地区，如 US',

  username VARCHAR(128) NULL COMMENT '用户名/@handle',
  display_name VARCHAR(256) NULL COMMENT '展示名',
  avatar_url TEXT NULL,

  follower_count INT NULL,
  avg_views INT NULL COMMENT '近似平均播放量（如有）',

  influencer_email VARCHAR(255) NULL COMMENT '主联系邮箱（主页抓取 profile_data.userInfo.email）',
  source VARCHAR(32) NULL COMMENT '数据来源，如 echotik',
  source_ref VARCHAR(128) NULL COMMENT '来源侧 ID，如 creator_oecuid',
  source_payload JSON COMMENT '来源原始快照（可选，用于调试/补字段）',

  last_fetched_at TIMESTAMP NULL DEFAULT NULL COMMENT '上次从第三方刷新时间',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_platform_region (platform, region),
  INDEX idx_username (username),
  INDEX idx_followers (follower_count DESC),
  INDEX idx_updated_at (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='TikTok Influencer 全局缓存表';


CREATE TABLE IF NOT EXISTS tiktok_campaign_influencer_candidates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id VARCHAR(36) NOT NULL COMMENT 'tiktok_campaign.id',
  tiktok_username VARCHAR(128) NOT NULL COMMENT 'TikTok handle（无 @），与执行表一致',
  influencer_id VARCHAR(128) NULL COMMENT 'TikTok userId，与 tiktok_influencer.influencer_id 一致（可空、可回填）',

  source VARCHAR(32) NOT NULL DEFAULT 'echotik' COMMENT '候选来源',
  influencer_snapshot JSON COMMENT '候选时的红人快照（用于审计/回溯，可为空）',

  match_score INT NULL COMMENT '匹配度评分（0-100 或自定义）',
  should_contact TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否建议联系（1=建议联系）',
  email VARCHAR(255) NULL COMMENT '候选红人的主联系邮箱（标准化）',
  has_email TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否有邮箱（1=有）',
  analysis_summary TEXT NULL COMMENT '匹配结论摘要（给前端展示）',
  match_analysis JSON NULL COMMENT '结构化匹配分析（长文等）；analysis_summary 为短摘要',
  analyzed_at TIMESTAMP NULL DEFAULT NULL COMMENT '分析完成时间',

  picked_at TIMESTAMP NULL DEFAULT NULL COMMENT '已被执行心跳消费并入执行表的时间',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_campaign_influencer (campaign_id, tiktok_username),
  INDEX idx_candidates_platform_influencer_id (influencer_id),
  INDEX idx_campaign_contact (campaign_id, should_contact, picked_at),
  INDEX idx_campaign_email_contact (campaign_id, has_email, should_contact, picked_at),
  INDEX idx_campaign_score (campaign_id, match_score DESC),
  INDEX idx_campaign_analyzed (campaign_id, analyzed_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Campaign 候选红人池 + 分析结果';
