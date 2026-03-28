// MySQL 数据库连接工具 - TikTok 数据库专用
// 用于连接到 tiktok 数据库
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

// 从环境变量读取 TikTok 数据库配置
// 优先级：TIKTOK_DB_* > MYSQL_* > DB_* > 默认值
const tiktokDbConfig = {
  host: process.env.TIKTOK_DB_HOST || process.env.MYSQL_HOST || process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.TIKTOK_DB_PORT || process.env.MYSQL_PORT || process.env.DB_PORT || '3306'),
  user: process.env.TIKTOK_DB_USER || process.env.MYSQL_USER || process.env.DB_USER || 'root',
  password: process.env.TIKTOK_DB_PASSWORD || process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.TIKTOK_DB_NAME || process.env.MYSQL_DATABASE || 'tiktok', // 默认使用 tiktok 数据库
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
};

// 创建 TikTok 数据库连接池
export const tiktokPool = mysql.createPool(tiktokDbConfig);

/**
 * 测试 TikTok 数据库连接
 */
export async function testTikTokConnection() {
  try {
    const connection = await tiktokPool.getConnection();
    await connection.ping();
    connection.release();
    console.log('[MySQL-TikTok] TikTok 数据库连接成功');
    return true;
  } catch (error) {
    console.error('[MySQL-TikTok] TikTok 数据库连接失败:', error.message);
    return false;
  }
}

/**
 * 执行查询（带错误处理）
 */
export async function queryTikTok(sql, params = []) {
  try {
    const [rows] = await tiktokPool.execute(sql, params);
    return rows;
  } catch (error) {
    console.error('[MySQL-TikTok] 查询失败:', error.message);
    console.error('[MySQL-TikTok] SQL:', sql);
    console.error('[MySQL-TikTok] 参数:', params);
    throw error;
  }
}

// 导出连接池供其他模块使用
export default tiktokPool;
