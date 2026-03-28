// 测试 TikTok 数据库连接
// 加载环境变量
import dotenv from 'dotenv';
dotenv.config();

import { testTikTokConnection, queryTikTok } from './lib/db/mysql-tiktok.js';

async function testConnection() {
  console.log('正在测试 TikTok 数据库连接...\n');

  // 显示当前配置（隐藏密码）
  const config = {
    host: process.env.MYSQL_HOST || process.env.TIKTOK_DB_HOST || '未设置',
    port: process.env.MYSQL_PORT || process.env.TIKTOK_DB_PORT || '未设置',
    user: process.env.MYSQL_USER || process.env.TIKTOK_DB_USER || '未设置',
    database: process.env.MYSQL_DATABASE || process.env.TIKTOK_DB_NAME || '未设置',
    password: (process.env.MYSQL_PASSWORD || process.env.TIKTOK_DB_PASSWORD) ? '***已设置***' : '未设置'
  };
  console.log('当前数据库配置:');
  console.log(JSON.stringify(config, null, 2));
  console.log('');

  // 1. 测试连接
  const connected = await testTikTokConnection();
  if (!connected) {
    console.error('❌ 数据库连接失败！');
    console.error('请检查：');
    console.error('1. 数据库服务是否运行');
    console.error('2. 环境变量配置是否正确（MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE）');
    console.error('3. 网络连接是否正常');
    process.exit(1);
  }

  console.log('✅ 数据库连接成功！\n');

  // 2. 检查表是否存在
  try {
    const tables = await queryTikTok('SHOW TABLES LIKE "TikTok_influencer"');
    if (tables.length === 0) {
      console.log('⚠️  表 TikTok_influencer 不存在');
      console.log('请执行以下 SQL 创建表：');
      console.log('mysql -h rm-2ze57d76jg0075zd7qo.mysql.rds.aliyuncs.com -u admin_user -p tiktok < lib/db/tiktok-influencer-schema.sql\n');
    } else {
      console.log('✅ 表 TikTok_influencer 存在\n');
    }
  } catch (error) {
    console.error('❌ 检查表失败:', error.message);
  }

  // 3. 查询表结构（如果表存在）
  try {
    const columns = await queryTikTok('DESCRIBE TikTok_influencer');
    if (columns.length > 0) {
      console.log('📊 表结构：');
      columns.forEach(col => {
        console.log(`  - ${col.Field}: ${col.Type} ${col.Null === 'YES' ? '(可空)' : '(必填)'}`);
      });
      console.log('');
    }
  } catch (error) {
    // 表不存在，忽略错误
  }

  // 4. 查询现有数据数量
  try {
    const count = await queryTikTok('SELECT COUNT(*) as count FROM TikTok_influencer');
    console.log(`📈 当前数据量: ${count[0]?.count || 0} 条记录\n`);
  } catch (error) {
    // 表不存在，忽略错误
  }

  console.log('✅ 测试完成！');
  process.exit(0);
}

testConnection().catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});

import dotenv from 'dotenv';
dotenv.config();

import { testTikTokConnection, queryTikTok } from './lib/db/mysql-tiktok.js';

async function testConnection() {
  console.log('正在测试 TikTok 数据库连接...\n');

  // 显示当前配置（隐藏密码）
  const config = {
    host: process.env.MYSQL_HOST || process.env.TIKTOK_DB_HOST || '未设置',
    port: process.env.MYSQL_PORT || process.env.TIKTOK_DB_PORT || '未设置',
    user: process.env.MYSQL_USER || process.env.TIKTOK_DB_USER || '未设置',
    database: process.env.MYSQL_DATABASE || process.env.TIKTOK_DB_NAME || '未设置',
    password: (process.env.MYSQL_PASSWORD || process.env.TIKTOK_DB_PASSWORD) ? '***已设置***' : '未设置'
  };
  console.log('当前数据库配置:');
  console.log(JSON.stringify(config, null, 2));
  console.log('');

  // 1. 测试连接
  const connected = await testTikTokConnection();
  if (!connected) {
    console.error('❌ 数据库连接失败！');
    console.error('请检查：');
    console.error('1. 数据库服务是否运行');
    console.error('2. 环境变量配置是否正确（MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE）');
    console.error('3. 网络连接是否正常');
    process.exit(1);
  }

  console.log('✅ 数据库连接成功！\n');

  // 2. 检查表是否存在
  try {
    const tables = await queryTikTok('SHOW TABLES LIKE "TikTok_influencer"');
    if (tables.length === 0) {
      console.log('⚠️  表 TikTok_influencer 不存在');
      console.log('请执行以下 SQL 创建表：');
      console.log('mysql -h rm-2ze57d76jg0075zd7qo.mysql.rds.aliyuncs.com -u admin_user -p tiktok < lib/db/tiktok-influencer-schema.sql\n');
    } else {
      console.log('✅ 表 TikTok_influencer 存在\n');
    }
  } catch (error) {
    console.error('❌ 检查表失败:', error.message);
  }

  // 3. 查询表结构（如果表存在）
  try {
    const columns = await queryTikTok('DESCRIBE TikTok_influencer');
    if (columns.length > 0) {
      console.log('📊 表结构：');
      columns.forEach(col => {
        console.log(`  - ${col.Field}: ${col.Type} ${col.Null === 'YES' ? '(可空)' : '(必填)'}`);
      });
      console.log('');
    }
  } catch (error) {
    // 表不存在，忽略错误
  }

  // 4. 查询现有数据数量
  try {
    const count = await queryTikTok('SELECT COUNT(*) as count FROM TikTok_influencer');
    console.log(`📈 当前数据量: ${count[0]?.count || 0} 条记录\n`);
  } catch (error) {
    // 表不存在，忽略错误
  }

  console.log('✅ 测试完成！');
  process.exit(0);
}

testConnection().catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});