-- Crawler 机器健康状态（每台机器一行，持续 upsert）
CREATE TABLE IF NOT EXISTS tiktok_crawler_worker_health (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  machine_id BIGINT NULL,
  worker_host VARCHAR(128) NOT NULL,
  worker_ip VARCHAR(64) NULL,
  worker_id VARCHAR(128) NULL,
  reported_platforms VARCHAR(255) NULL,
  reported_release_sha CHAR(40) NULL,
  worker_alive TINYINT(1) NOT NULL DEFAULT 0,
  worker_loop_ok TINYINT(1) NULL,
  cdp_9222_ok TINYINT(1) NOT NULL DEFAULT 0,
  cdp_9222_rpc_ok TINYINT(1) NULL,
  cdp_9223_ok TINYINT(1) NOT NULL DEFAULT 0,
  cdp_9222_fail_streak INT NOT NULL DEFAULT 0,
  cdp_9223_fail_streak INT NOT NULL DEFAULT 0,
  last_seen_at DATETIME NOT NULL,
  last_claim_at DATETIME NULL,
  last_progress_at DATETIME NULL,
  last_error VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_worker_host (worker_host),
  INDEX idx_machine_seen (machine_id, last_seen_at DESC),
  INDEX idx_worker_host_ip (worker_host, worker_ip),
  INDEX idx_last_seen (last_seen_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawler 机器健康状态';

-- 每个平台独立维护可部署的生产版本；同一平台只有一条 active 记录。
CREATE TABLE IF NOT EXISTS tiktok_crawler_release (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  platform ENUM('youtube','tiktok','instagram') NOT NULL,
  release_sha CHAR(40) NOT NULL,
  status ENUM('pending','active','retired') NOT NULL DEFAULT 'pending',
  released_by BIGINT NULL,
  released_at DATETIME NULL,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_sha (platform, release_sha),
  INDEX idx_platform_status (platform, status, released_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawler 按平台生产版本';

-- 机器期望配置。machine_key 是稳定身份，不随公网 IP 或 hostname 漂移。
CREATE TABLE IF NOT EXISTS tiktok_crawler_machine (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  machine_key VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  public_ip VARCHAR(64) NOT NULL,
  ssh_host VARCHAR(128) NOT NULL,
  expected_worker_host VARCHAR(128) NULL,
  mode ENUM('dedicated','mixed') NOT NULL DEFAULT 'dedicated',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_machine_key (machine_key),
  UNIQUE KEY uk_public_ip (public_ip),
  INDEX idx_enabled_mode (enabled, mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawler 机器注册表';

CREATE TABLE IF NOT EXISTS tiktok_crawler_machine_platform (
  machine_id BIGINT NOT NULL,
  platform ENUM('youtube','tiktok','instagram') NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_primary TINYINT(1) NOT NULL DEFAULT 1,
  worker_slots INT NOT NULL DEFAULT 1,
  task_timeout_minutes INT NOT NULL DEFAULT 30,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (machine_id, platform),
  INDEX idx_platform_enabled (platform, enabled),
  CONSTRAINT fk_crawler_machine_platform_machine
    FOREIGN KEY (machine_id) REFERENCES tiktok_crawler_machine (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawler 机器期望平台角色';

CREATE TABLE IF NOT EXISTS tiktok_crawler_alert_state (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  machine_id BIGINT NOT NULL,
  platform ENUM('youtube','tiktok','instagram') NOT NULL,
  current_level ENUM('normal','degraded','fault','idle','unknown') NOT NULL DEFAULT 'unknown',
  notified_level ENUM('normal','degraded','fault','idle','unknown') NULL,
  reason_codes JSON NULL,
  state_started_at DATETIME NOT NULL,
  last_alert_at DATETIME NULL,
  last_recovery_at DATETIME NULL,
  alert_fingerprint VARCHAR(128) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_machine_platform (machine_id, platform),
  INDEX idx_alert_level_time (current_level, state_started_at),
  CONSTRAINT fk_crawler_alert_state_machine
    FOREIGN KEY (machine_id) REFERENCES tiktok_crawler_machine (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawler 告警状态与去重';

CREATE TABLE IF NOT EXISTS tiktok_crawler_platform_alert_state (
  platform ENUM('youtube','tiktok','instagram') PRIMARY KEY,
  current_level ENUM('normal','fault') NOT NULL DEFAULT 'normal',
  state_started_at DATETIME NOT NULL,
  last_alert_at DATETIME NULL,
  last_recovery_at DATETIME NULL,
  alert_fingerprint VARCHAR(128) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawler 平台级事故告警状态';

-- Crawler 自动修复动作日志（审计）
CREATE TABLE IF NOT EXISTS tiktok_crawler_repair_action_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  machine_id BIGINT NULL,
  worker_host VARCHAR(128) NOT NULL,
  worker_ip VARCHAR(64) NULL,
  platform VARCHAR(32) NULL,
  action_type VARCHAR(64) NOT NULL COMMENT 'restart_worker/restart_cdp/redeploy_crawler/...',
  trigger_reason VARCHAR(255) NOT NULL,
  request_reason VARCHAR(500) NULL,
  target_release_sha CHAR(40) NULL,
  result ENUM('started','succeeded','failed','skipped') NOT NULL DEFAULT 'started',
  detail TEXT NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  operator VARCHAR(64) NOT NULL DEFAULT 'auto',
  requested_by_user_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_worker_host_ip_time (worker_host, worker_ip, started_at DESC),
  INDEX idx_action_result (action_type, result, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawler 自动修复动作日志';
