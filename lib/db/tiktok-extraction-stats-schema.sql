-- 提取统计表：记录提取成功率和质量指标
-- 数据库：tiktok
-- 表名：extraction_stats

CREATE TABLE IF NOT EXISTS extraction_stats (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- 提取方式
  extraction_method VARCHAR(50) NOT NULL COMMENT '提取方式：function（函数提取）或 ai_agent（AI Agent提取）',
  platform VARCHAR(20) NOT NULL COMMENT '平台：TikTok 或 Instagram',
  
  -- 统计时间窗口
  time_window_start DATETIME NOT NULL COMMENT '统计时间窗口开始时间',
  time_window_end DATETIME NOT NULL COMMENT '统计时间窗口结束时间',
  
  -- 成功率统计
  total_attempts INT DEFAULT 0 COMMENT '总尝试次数',
  successful_extractions INT DEFAULT 0 COMMENT '成功提取次数',
  failed_extractions INT DEFAULT 0 COMMENT '失败提取次数',
  success_rate DECIMAL(5,2) DEFAULT 0.00 COMMENT '成功率（%）',
  
  -- 字段级别的成功率（JSON格式）
  field_success_rates JSON COMMENT '各字段提取成功率，如 {"username": 100, "followers": 85, "bio": 60}',
  
  -- 失败原因统计（JSON格式）
  failure_reasons JSON COMMENT '失败原因统计，如 {"timeout": 10, "selector_not_found": 5, "format_error": 3}',
  
  -- 性能指标
  avg_extraction_time_ms INT DEFAULT 0 COMMENT '平均提取时间（毫秒）',
  total_extraction_time_ms BIGINT DEFAULT 0 COMMENT '总提取时间（毫秒）',
  
  -- 质量指标
  data_completeness DECIMAL(5,2) DEFAULT 0.00 COMMENT '数据完整度（%）',
  data_accuracy DECIMAL(5,2) DEFAULT 0.00 COMMENT '数据准确度（%）',
  
  -- 切换决策
  should_use_ai_agent BOOLEAN DEFAULT FALSE COMMENT '是否应该使用 AI Agent（基于成功率判断）',
  switch_reason TEXT COMMENT '切换原因说明',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- 索引
  INDEX idx_platform_method (platform, extraction_method),
  INDEX idx_time_window (time_window_start, time_window_end),
  INDEX idx_success_rate (success_rate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='提取统计表';

-- 提取日志表：记录每次提取的详细信息
CREATE TABLE IF NOT EXISTS extraction_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- 提取信息
  extraction_method VARCHAR(50) NOT NULL COMMENT '提取方式：function 或 ai_agent',
  platform VARCHAR(20) NOT NULL COMMENT '平台',
  username VARCHAR(255) COMMENT '红人用户名',
  
  -- 提取结果
  success BOOLEAN DEFAULT FALSE COMMENT '是否成功',
  extracted_fields JSON COMMENT '提取到的字段（JSON格式）',
  missing_fields JSON COMMENT '缺失的字段（JSON格式）',
  
  -- 错误信息
  error_type VARCHAR(50) COMMENT '错误类型',
  error_message TEXT COMMENT '错误消息',
  error_details JSON COMMENT '错误详情（JSON格式）',
  
  -- 性能指标
  extraction_time_ms INT DEFAULT 0 COMMENT '提取耗时（毫秒）',
  
  -- 质量指标
  data_completeness DECIMAL(5,2) DEFAULT 0.00 COMMENT '数据完整度（%）',
  data_accuracy DECIMAL(5,2) DEFAULT 0.00 COMMENT '数据准确度（%）',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- 索引
  INDEX idx_method_platform (extraction_method, platform),
  INDEX idx_success (success),
  INDEX idx_created_at (created_at),
  INDEX idx_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='提取日志表';


-- 表名：extraction_stats

CREATE TABLE IF NOT EXISTS extraction_stats (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- 提取方式
  extraction_method VARCHAR(50) NOT NULL COMMENT '提取方式：function（函数提取）或 ai_agent（AI Agent提取）',
  platform VARCHAR(20) NOT NULL COMMENT '平台：TikTok 或 Instagram',
  
  -- 统计时间窗口
  time_window_start DATETIME NOT NULL COMMENT '统计时间窗口开始时间',
  time_window_end DATETIME NOT NULL COMMENT '统计时间窗口结束时间',
  
  -- 成功率统计
  total_attempts INT DEFAULT 0 COMMENT '总尝试次数',
  successful_extractions INT DEFAULT 0 COMMENT '成功提取次数',
  failed_extractions INT DEFAULT 0 COMMENT '失败提取次数',
  success_rate DECIMAL(5,2) DEFAULT 0.00 COMMENT '成功率（%）',
  
  -- 字段级别的成功率（JSON格式）
  field_success_rates JSON COMMENT '各字段提取成功率，如 {"username": 100, "followers": 85, "bio": 60}',
  
  -- 失败原因统计（JSON格式）
  failure_reasons JSON COMMENT '失败原因统计，如 {"timeout": 10, "selector_not_found": 5, "format_error": 3}',
  
  -- 性能指标
  avg_extraction_time_ms INT DEFAULT 0 COMMENT '平均提取时间（毫秒）',
  total_extraction_time_ms BIGINT DEFAULT 0 COMMENT '总提取时间（毫秒）',
  
  -- 质量指标
  data_completeness DECIMAL(5,2) DEFAULT 0.00 COMMENT '数据完整度（%）',
  data_accuracy DECIMAL(5,2) DEFAULT 0.00 COMMENT '数据准确度（%）',
  
  -- 切换决策
  should_use_ai_agent BOOLEAN DEFAULT FALSE COMMENT '是否应该使用 AI Agent（基于成功率判断）',
  switch_reason TEXT COMMENT '切换原因说明',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  -- 索引
  INDEX idx_platform_method (platform, extraction_method),
  INDEX idx_time_window (time_window_start, time_window_end),
  INDEX idx_success_rate (success_rate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='提取统计表';

-- 提取日志表：记录每次提取的详细信息
CREATE TABLE IF NOT EXISTS extraction_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- 提取信息
  extraction_method VARCHAR(50) NOT NULL COMMENT '提取方式：function 或 ai_agent',
  platform VARCHAR(20) NOT NULL COMMENT '平台',
  username VARCHAR(255) COMMENT '红人用户名',
  
  -- 提取结果
  success BOOLEAN DEFAULT FALSE COMMENT '是否成功',
  extracted_fields JSON COMMENT '提取到的字段（JSON格式）',
  missing_fields JSON COMMENT '缺失的字段（JSON格式）',
  
  -- 错误信息
  error_type VARCHAR(50) COMMENT '错误类型',
  error_message TEXT COMMENT '错误消息',
  error_details JSON COMMENT '错误详情（JSON格式）',
  
  -- 性能指标
  extraction_time_ms INT DEFAULT 0 COMMENT '提取耗时（毫秒）',
  
  -- 质量指标
  data_completeness DECIMAL(5,2) DEFAULT 0.00 COMMENT '数据完整度（%）',
  data_accuracy DECIMAL(5,2) DEFAULT 0.00 COMMENT '数据准确度（%）',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- 索引
  INDEX idx_method_platform (extraction_method, platform),
  INDEX idx_success (success),
  INDEX idx_created_at (created_at),
  INDEX idx_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='提取日志表';
