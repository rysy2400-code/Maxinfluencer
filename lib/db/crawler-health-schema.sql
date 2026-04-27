-- Crawler 机器健康状态（每台机器一行，持续 upsert）
CREATE TABLE IF NOT EXISTS tiktok_crawler_worker_health (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  worker_host VARCHAR(128) NOT NULL,
  worker_ip VARCHAR(64) NULL,
  worker_id VARCHAR(128) NULL,
  worker_alive TINYINT(1) NOT NULL DEFAULT 0,
  cdp_9222_ok TINYINT(1) NOT NULL DEFAULT 0,
  cdp_9223_ok TINYINT(1) NOT NULL DEFAULT 0,
  cdp_9222_fail_streak INT NOT NULL DEFAULT 0,
  cdp_9223_fail_streak INT NOT NULL DEFAULT 0,
  last_seen_at DATETIME NOT NULL,
  last_error VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_worker_host (worker_host),
  INDEX idx_worker_host_ip (worker_host, worker_ip),
  INDEX idx_last_seen (last_seen_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawler 机器健康状态';

-- Crawler 自动修复动作日志（审计）
CREATE TABLE IF NOT EXISTS tiktok_crawler_repair_action_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  worker_host VARCHAR(128) NOT NULL,
  worker_ip VARCHAR(64) NULL,
  action_type VARCHAR(64) NOT NULL COMMENT 'restart_worker/restart_cdp/redeploy_crawler/...',
  trigger_reason VARCHAR(255) NOT NULL,
  result ENUM('started','succeeded','failed','skipped') NOT NULL DEFAULT 'started',
  detail TEXT NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  operator VARCHAR(64) NOT NULL DEFAULT 'auto',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_worker_host_ip_time (worker_host, worker_ip, started_at DESC),
  INDEX idx_action_result (action_type, result, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawler 自动修复动作日志';
