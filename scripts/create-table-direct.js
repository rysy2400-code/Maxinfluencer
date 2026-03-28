// 直接执行 SQL 创建表的脚本（不依赖文件读取）
import dotenv from 'dotenv';
dotenv.config();

import { queryTikTok } from '../lib/db/mysql-tiktok.js';

async function createTable() {
  try {
    console.log('正在创建 campaign_sessions 表...\n');
    
    const sql = `
CREATE TABLE IF NOT EXISTS campaign_sessions (
  id VARCHAR(36) PRIMARY KEY COMMENT '会话 ID（UUID）',
  title VARCHAR(255) NOT NULL DEFAULT '' COMMENT '会话标题（自动生成或用户自定义）',
  status ENUM('draft', 'published') NOT NULL DEFAULT 'draft' COMMENT '会话状态：draft=草稿中, published=已发布',
  messages JSON NOT NULL COMMENT '完整的对话消息数组（JSON 格式）',
  context JSON COMMENT '上下文对象（产品信息、红人画像等，JSON 格式）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  INDEX idx_status (status),
  INDEX idx_updated_at (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Campaign 会话草稿表';
    `.trim();
    
    await queryTikTok(sql);
    
    console.log('✅ campaign_sessions 表创建成功！\n');
    
    // 验证表是否存在
    const tables = await queryTikTok("SHOW TABLES LIKE 'campaign_sessions'");
    if (tables.length > 0) {
      console.log('✅ 验证：表已存在\n');
      
      // 显示表结构
      const structure = await queryTikTok("DESCRIBE campaign_sessions");
      console.log('表结构：');
      console.table(structure);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ 创建表失败:', error.message);
    if (error.code === 'ER_TABLE_EXISTS') {
      console.log('⚠️  表已存在，无需重复创建');
      process.exit(0);
    }
    console.error(error);
    process.exit(1);
  }
}

createTable();

