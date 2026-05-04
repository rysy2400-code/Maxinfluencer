-- Campaign Session 表结构
-- 用于存储用户的多会话草稿（类似 ChatGPT 的会话列表）
-- 数据库：tiktok

CREATE TABLE IF NOT EXISTS campaign_sessions (
  id VARCHAR(36) PRIMARY KEY COMMENT '会话 ID（UUID）',
  title VARCHAR(255) NOT NULL DEFAULT '' COMMENT '会话标题（自动生成或用户自定义）',
  status ENUM('draft', 'published') NOT NULL DEFAULT 'draft' COMMENT '会话状态：draft=草稿中, published=已发布',
  messages JSON NOT NULL COMMENT '完整的对话消息数组（JSON 格式）',
  context JSON COMMENT '上下文对象（产品信息、红人画像等，JSON 格式）',
  published_user_hidden_at DATETIME NULL COMMENT '用户从前端移除已发布列表的时间（生产表多为 tiktok_campaign_sessions，需与迁移脚本一致）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  INDEX idx_status (status),
  INDEX idx_updated_at (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Campaign 会话草稿表';

