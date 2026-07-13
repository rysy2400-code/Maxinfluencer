-- Campaign 红人视频 #tag / @mention 信号池（关键词生成自迭代）
CREATE TABLE IF NOT EXISTS tiktok_campaign_keyword_signals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  campaign_id VARCHAR(36) NOT NULL COMMENT 'tiktok_campaign.id',
  platform VARCHAR(24) NOT NULL COMMENT 'tiktok|instagram|youtube',
  signal_type ENUM('hashtag','mention') NOT NULL,
  signal_value VARCHAR(255) NOT NULL COMMENT '原样存储，如 #poolcleaner / @beatbot',
  influencer_count INT NOT NULL DEFAULT 0 COMMENT '贡献该信号的 isRecommended 红人数',
  occurrence_count INT NOT NULL DEFAULT 0 COMMENT '视频出现总次数',
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  consumed_at TIMESTAMP NULL COMMENT '最近一次被搜索消费的时间',
  last_new_recommended_count INT NOT NULL DEFAULT 0 COMMENT '上次消费后新增推荐红人数',
  UNIQUE KEY uk_campaign_platform_type_value (campaign_id, platform, signal_type, signal_value),
  INDEX idx_campaign_platform_count (campaign_id, platform, influencer_count DESC, last_seen_at DESC),
  INDEX idx_campaign_consumed (campaign_id, platform, consumed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Campaign 关键词信号池';

CREATE TABLE IF NOT EXISTS tiktok_campaign_keyword_signal_contributor (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  campaign_id VARCHAR(36) NOT NULL,
  platform VARCHAR(24) NOT NULL,
  signal_type ENUM('hashtag','mention') NOT NULL,
  signal_value VARCHAR(255) NOT NULL,
  contributor_username VARCHAR(128) NOT NULL COMMENT '推荐红人 handle（小写）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_signal_contributor (
    campaign_id,
    platform,
    signal_type,
    signal_value,
    contributor_username
  ),
  INDEX idx_campaign_contributor (campaign_id, contributor_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='信号贡献红人（去重 influencer_count）';
