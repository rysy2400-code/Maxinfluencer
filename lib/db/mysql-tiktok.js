// MySQL 数据库连接工具 - TikTok 数据库专用
// 用于连接到 tiktok 数据库
import mysql from 'mysql2/promise.js';
import dotenv from 'dotenv';
import path from 'path';

// 加载环境变量
// Next.js/PM2 的工作目录就是项目根目录。不要从 import.meta.url 推导路径：
// webpack 会把构建机路径写入产物，跨平台部署时（macOS -> Windows）会导致
// fileURLToPath 抛出 ERR_INVALID_FILE_URL_PATH。
const projectRoot = process.cwd();
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(projectRoot, '.env.local') });

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const connectTimeoutMs = positiveTimeout(
  process.env.TIKTOK_DB_CONNECT_TIMEOUT_MS,
  15000
);
const queryTimeoutMs = positiveTimeout(
  process.env.TIKTOK_DB_QUERY_TIMEOUT_MS,
  120000
);

// 从环境变量读取 TikTok 数据库配置
// 优先级：TIKTOK_DB_* > MYSQL_* > DB_* > 默认值
const tiktokDbConfig = {
  host: process.env.TIKTOK_DB_HOST || process.env.MYSQL_HOST || process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.TIKTOK_DB_PORT || process.env.MYSQL_PORT || process.env.DB_PORT || '3306'),
  user: process.env.TIKTOK_DB_USER || process.env.MYSQL_USER || process.env.DB_USER || 'root',
  password: process.env.TIKTOK_DB_PASSWORD || process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.TIKTOK_DB_NAME || process.env.MYSQL_DATABASE || 'tiktok', // 默认使用 tiktok 数据库
  connectTimeout: connectTimeoutMs,
  waitForConnections: true,
  connectionLimit: 10,
  maxPreparedStatements: Math.max(
    Number(process.env.TIKTOK_DB_MAX_PREPARED_STATEMENTS || 100),
    1
  ),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: "utf8mb4",
  // 大结果集（如按项目收件箱 4.5 万行）开启协议压缩，显著降低跨机房传输耗时
  compress: true,
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
export async function queryTikTok(sql, params = [], options = {}) {
  const timeout = positiveTimeout(options.timeout, queryTimeoutMs);
  let connection = null;
  const startedAt = Date.now();
  try {
    connection = await tiktokPool.getConnection();
    const [rows] = await connection.query({
      sql,
      values: params,
      timeout,
    });
    return rows;
  } catch (error) {
    // mysql2 超时只结束客户端等待；销毁连接才能终止服务端查询，
    // 避免长查询继续占用表锁和连接池。
    if (error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT' && connection) {
      connection.destroy();
      connection = null;
    }
    console.error(
      '[MySQL-TikTok] 查询失败:',
      error.message,
      `(${Date.now() - startedAt}ms)`
    );
    console.error('[MySQL-TikTok] SQL:', sql);
    console.error('[MySQL-TikTok] 参数:', params);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

// 导出连接池供其他模块使用
export default tiktokPool;
