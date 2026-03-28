-- 红人数据表（单表设计，MVP版本）
-- 如果未来需要扩展，可以考虑拆分标签表和内容示例表

CREATE TABLE IF NOT EXISTS influencers (
  -- 主键
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- 平台和国家（用于筛选）
  platform VARCHAR(20) NOT NULL COMMENT '平台：TikTok 或 Instagram',
  country VARCHAR(50) NOT NULL COMMENT '国家：美国 或 德国',
  
  -- 账号基本信息
  username VARCHAR(255) NOT NULL COMMENT '账号ID，如 @username',
  display_name VARCHAR(255) COMMENT '显示名称',
  profile_url VARCHAR(500) NOT NULL COMMENT '主页链接',
  avatar_url VARCHAR(500) COMMENT '头像URL',
  
  -- 粉丝和互动数据
  followers_count BIGINT COMMENT '粉丝量（数字，用于排序和匹配）',
  followers_display VARCHAR(50) COMMENT '粉丝量（显示格式，如 "28.5万"）',
  following_count INT COMMENT '关注数',
  posts_count INT COMMENT '帖子数/视频数',
  
  -- 内容数据
  avg_views BIGINT COMMENT '平均播放量/观看量（数字）',
  views_display VARCHAR(50) COMMENT '播放量（显示格式，如 "15.2万"）',
  avg_likes BIGINT COMMENT '平均点赞数',
  avg_comments INT COMMENT '平均评论数',
  engagement_rate DECIMAL(5,2) COMMENT '互动率（%）',
  
  -- 账户类型和描述
  account_type VARCHAR(100) COMMENT '主账户类型（用于快速筛选），如：美妆达人',
  account_types JSON COMMENT '账户类型数组（支持多标签），如：["美妆达人", "时尚博主", "生活方式"]',
  bio TEXT COMMENT '个人简介',
  verified BOOLEAN DEFAULT FALSE COMMENT '是否认证',
  
  -- 商业数据
  cpm DECIMAL(10,2) COMMENT 'CPM（每千次展示成本，美元）',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  last_crawled_at TIMESTAMP COMMENT '最后爬取时间（用于缓存判断）',
  
  -- 唯一索引：同一平台、国家、用户名只能有一条记录
  UNIQUE KEY uk_platform_country_username (platform, country, username),
  
  -- 查询索引
  INDEX idx_platform_country (platform, country),
  INDEX idx_followers (followers_count),
  INDEX idx_views (avg_views),
  INDEX idx_account_type (account_type),
  INDEX idx_last_crawled (last_crawled_at),
  INDEX idx_engagement (engagement_rate DESC)
  -- 注意：JSON 字段查询使用 JSON_CONTAINS 函数
  -- MySQL 8.0+ 可以使用函数索引，但为了兼容性，这里不创建 JSON 索引
  -- 查询时使用：WHERE JSON_CONTAINS(account_types, '"美妆达人"')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='红人数据表';



CREATE TABLE IF NOT EXISTS influencers (
  -- 主键
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  
  -- 平台和国家（用于筛选）
  platform VARCHAR(20) NOT NULL COMMENT '平台：TikTok 或 Instagram',
  country VARCHAR(50) NOT NULL COMMENT '国家：美国 或 德国',
  
  -- 账号基本信息
  username VARCHAR(255) NOT NULL COMMENT '账号ID，如 @username',
  display_name VARCHAR(255) COMMENT '显示名称',
  profile_url VARCHAR(500) NOT NULL COMMENT '主页链接',
  avatar_url VARCHAR(500) COMMENT '头像URL',
  
  -- 粉丝和互动数据
  followers_count BIGINT COMMENT '粉丝量（数字，用于排序和匹配）',
  followers_display VARCHAR(50) COMMENT '粉丝量（显示格式，如 "28.5万"）',
  following_count INT COMMENT '关注数',
  posts_count INT COMMENT '帖子数/视频数',
  
  -- 内容数据
  avg_views BIGINT COMMENT '平均播放量/观看量（数字）',
  views_display VARCHAR(50) COMMENT '播放量（显示格式，如 "15.2万"）',
  avg_likes BIGINT COMMENT '平均点赞数',
  avg_comments INT COMMENT '平均评论数',
  engagement_rate DECIMAL(5,2) COMMENT '互动率（%）',
  
  -- 账户类型和描述
  account_type VARCHAR(100) COMMENT '主账户类型（用于快速筛选），如：美妆达人',
  account_types JSON COMMENT '账户类型数组（支持多标签），如：["美妆达人", "时尚博主", "生活方式"]',
  bio TEXT COMMENT '个人简介',
  verified BOOLEAN DEFAULT FALSE COMMENT '是否认证',
  
  -- 商业数据
  cpm DECIMAL(10,2) COMMENT 'CPM（每千次展示成本，美元）',
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  last_crawled_at TIMESTAMP COMMENT '最后爬取时间（用于缓存判断）',
  
  -- 唯一索引：同一平台、国家、用户名只能有一条记录
  UNIQUE KEY uk_platform_country_username (platform, country, username),
  
  -- 查询索引
  INDEX idx_platform_country (platform, country),
  INDEX idx_followers (followers_count),
  INDEX idx_views (avg_views),
  INDEX idx_account_type (account_type),
  INDEX idx_last_crawled (last_crawled_at),
  INDEX idx_engagement (engagement_rate DESC)
  -- 注意：JSON 字段查询使用 JSON_CONTAINS 函数
  -- MySQL 8.0+ 可以使用函数索引，但为了兼容性，这里不创建 JSON 索引
  -- 查询时使用：WHERE JSON_CONTAINS(account_types, '"美妆达人"')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='红人数据表';
