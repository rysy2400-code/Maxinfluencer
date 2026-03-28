-- Scraper 任务表：Execution Heartbeat 入队，Scraper Worker 消费
CREATE TABLE IF NOT EXISTS tiktok_influencer_search_task (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  campaign_id VARCHAR(36) NOT NULL COMMENT 'tiktok_campaign.id',
  priority INT NOT NULL DEFAULT 100 COMMENT '优先级，数字越大越优先',
  payload JSON NOT NULL COMMENT '任务参数，如 targetBatchSize/userMessage/trigger',
  status ENUM('pending','processing','succeeded','failed','cancelled') NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0 COMMENT '已尝试次数',
  worker_id VARCHAR(128) NULL COMMENT '当前处理该任务的 worker 标识',
  error_message TEXT NULL COMMENT '失败原因',
  started_at TIMESTAMP NULL DEFAULT NULL,
  finished_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_campaign_status (campaign_id, status),
  INDEX idx_status_priority_created (status, priority, created_at),
  INDEX idx_worker_status (worker_id, status),
  INDEX idx_created_at (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='红人搜索补货任务队列表';

