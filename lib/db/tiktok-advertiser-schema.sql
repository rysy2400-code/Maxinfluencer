-- 广告主（公司）与登录用户；库：tiktok（与 tiktok_campaign_sessions 同库）
CREATE TABLE IF NOT EXISTS tiktok_advertiser (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL COMMENT '展示名，登录时与公司名一致匹配',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_advertiser_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tiktok_advertiser_user (
  id INT AUTO_INCREMENT PRIMARY KEY,
  advertiser_id INT NOT NULL COMMENT 'tiktok_advertiser.id',
  username VARCHAR(64) NOT NULL COMMENT '公司内唯一',
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_admin TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=可访问跨用户管理接口',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_advertiser_username (advertiser_id, username),
  KEY idx_advertiser_id (advertiser_id),
  CONSTRAINT fk_advertiser_user_advertiser FOREIGN KEY (advertiser_id) REFERENCES tiktok_advertiser (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
