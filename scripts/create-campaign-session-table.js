// 创建 campaign_sessions 表的脚本
import dotenv from 'dotenv';
dotenv.config();

import { queryTikTok } from '../lib/db/mysql-tiktok.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function createTable() {
  try {
    console.log('正在创建 campaign_sessions 表...\n');
    
    // 读取 SQL 文件
    const sqlPath = join(__dirname, '../lib/db/campaign-session-schema.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    
    // 执行 SQL（移除注释和空行，只保留 CREATE TABLE 语句）
    const createTableSQL = sql
      .split('\n')
      .filter(line => !line.trim().startsWith('--') && line.trim())
      .join('\n');
    
    await queryTikTok(createTableSQL);
    
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
    console.error(error);
    process.exit(1);
  }
}

createTable();

