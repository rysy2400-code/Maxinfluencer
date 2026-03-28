#!/usr/bin/env node

/**
 * 测试 CDP Network 拦截功能
 * 
 * 使用方法：
 * 1. 启动 Chrome 并启用远程调试（用于主页提取）：
 *    bash scripts/launch-chrome-remote-debug-enrich.sh
 * 
 * 2. 运行测试：
 *    node test-cdp-interception.js [username]
 * 
 * 示例：
 *    node test-cdp-interception.js mikayla.ari
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// 加载环境变量
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, './');
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(projectRoot, '.env.local') });

// 导入 CDP 拦截函数
const { extractUserProfileFromPageCDP } = await import('./lib/tools/influencer-functions/extract-user-profile-cdp.js');

/**
 * 连接 CDP 浏览器
 */
async function connectBrowser() {
  const CDP_ENDPOINT = process.env.CDP_ENDPOINT_ENRICH || process.env.CDP_ENDPOINT || 'http://localhost:9223';
  console.log(`\n🔗 连接到 CDP: ${CDP_ENDPOINT}`);
  console.log(`💡 提示: 确保已启动 Chrome 并启用远程调试`);
  console.log(`    bash scripts/launch-chrome-remote-debug-enrich.sh\n`);
  
  let browser = null;
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries) {
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 10000 });
      console.log(`✅ CDP 连接成功（尝试 ${retryCount + 1}/${maxRetries}）`);
      break;
    } catch (error) {
      retryCount++;
      console.warn(`⚠️  CDP 连接失败（尝试 ${retryCount}/${maxRetries}）: ${error.message}`);
      if (retryCount < maxRetries) {
        console.log('等待 2 秒后重试...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  if (!browser) {
    throw new Error(
      `CDP 连接失败（已重试 ${maxRetries} 次）\n` +
      `请确保已启动 Chrome 并启用远程调试：\n` +
      `  bash scripts/launch-chrome-remote-debug-enrich.sh`
    );
  }
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const page = await context.newPage();
  
  return { browser, context, page };
}

/**
 * 测试 CDP Network 拦截
 */
async function testCDPInterception(username) {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 测试 CDP Network 拦截功能');
  console.log('='.repeat(80));
  console.log(`\n📝 测试用户名: @${username}`);
  console.log(`   目标 URL: https://www.tiktok.com/@${username}\n`);
  
  let browser = null;
  let page = null;
  
  try {
    // 连接浏览器
    const { browser: connectedBrowser, page: connectedPage } = await connectBrowser();
    browser = connectedBrowser;
    page = connectedPage;
    
    // 步骤更新回调
    const onStepUpdate = (update) => {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`[${timestamp}] ${update.step || '执行中'}: ${update.message || ''}`);
    };
    
    // 调用 CDP 拦截提取函数
    console.log('\n🚀 开始提取数据（使用 CDP Network 拦截）...\n');
    const startTime = Date.now();
    
    const result = await extractUserProfileFromPageCDP(
      page,
      username,
      {
        onStepUpdate
      }
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // 显示结果
    console.log('\n' + '='.repeat(80));
    console.log('✅ 提取完成！');
    console.log('='.repeat(80));
    console.log(`\n⏱️  耗时: ${duration} 秒`);
    console.log(`\n📊 拦截结果:`);
    console.log(`   - 用户信息 API: ${result.interceptedApis.userDetail ? '✅ 已拦截' : '❌ 未拦截'}`);
    console.log(`   - 视频列表 API: ${result.interceptedApis.itemList} 次`);
    console.log(`   - 视频详情 API: ${result.interceptedApis.itemDetail} 次`);
    console.log(`   - 关注者列表 API: ${result.interceptedApis.followers ? '✅ 已拦截' : '❌ 未拦截'}`);
    console.log(`   - 关注列表 API: ${result.interceptedApis.following ? '✅ 已拦截' : '❌ 未拦截'}`);
    
    console.log(`\n👤 用户信息:`);
    if (result.userInfo) {
      console.log(`   - 用户名: @${result.userInfo.username || '未知'}`);
      console.log(`   - 显示名: ${result.userInfo.displayName || '未知'}`);
      console.log(`   - 头像: ${result.userInfo.avatarUrl ? '✅' : '❌'}`);
      console.log(`   - 简介: ${result.userInfo.bio ? result.userInfo.bio.substring(0, 50) + '...' : '无'}`);
      console.log(`   - 邮箱: ${result.userInfo.email || '未找到'}`);
      console.log(`   - 粉丝数: ${result.userInfo.followers ? result.userInfo.followers.display : '未知'}`);
      console.log(`   - 关注数: ${result.userInfo.following ? result.userInfo.following.display : '未知'}`);
      console.log(`   - 获赞数: ${result.userInfo.likes ? result.userInfo.likes.display : '未知'}`);
      console.log(`   - 视频数: ${result.userInfo.postsCount ? result.userInfo.postsCount.display : '未知'}`);
      console.log(`   - 认证: ${result.userInfo.verified ? '✅' : '❌'}`);
    } else {
      console.log(`   ❌ 未提取到用户信息`);
    }
    
    console.log(`\n📹 视频数据:`);
    console.log(`   - 提取视频数: ${result.videos.length} 个`);
    if (result.videos.length > 0) {
      console.log(`   - 前 3 个视频:`);
      result.videos.slice(0, 3).forEach((video, i) => {
        console.log(`     ${i + 1}. ${video.videoId || '未知ID'}`);
        console.log(`        描述: ${video.description ? video.description.substring(0, 50) + '...' : '无'}`);
        console.log(`        播放: ${video.views ? video.views.display : '未知'}`);
        console.log(`        点赞: ${video.likes ? video.likes.display : '未知'}`);
        console.log(`        评论: ${video.comments ? video.comments.display : '未知'}`);
        console.log(`        分享: ${video.shares ? video.shares.display : '未知'}`);
        console.log(`        收藏: ${video.favorites ? video.favorites.display : '未知'}`);
      });
    }
    
    console.log(`\n📈 统计数据:`);
    if (result.statistics) {
      console.log(`   - 平均播放量: ${result.statistics.avgViews ? result.statistics.avgViews.toLocaleString() : '未知'}`);
      console.log(`   - 平均点赞数: ${result.statistics.avgLikes ? result.statistics.avgLikes.toLocaleString() : '未知'}`);
      console.log(`   - 平均评论数: ${result.statistics.avgComments ? result.statistics.avgComments.toLocaleString() : '未知'}`);
      console.log(`   - 平均收藏数: ${result.statistics.avgFavorites ? result.statistics.avgFavorites.toLocaleString() : '未知'}`);
    }
    
    console.log(`\n⚠️  缺失数据:`);
    if (result.missingData) {
      Object.entries(result.missingData).forEach(([key, value]) => {
        if (value) {
          console.log(`   - ${key}: ${value}`);
        }
      });
    }
    
    // 显示视频详情（如果拦截到）
    if (result.videoDetails && result.videoDetails.length > 0) {
      console.log(`\n🎬 视频详情 (从 itemDetail API):`);
      console.log(`   - 详细视频数: ${result.videoDetails.length} 个`);
      if (result.videoDetails.length > 0) {
        const detail = result.videoDetails[0];
        console.log(`   - 示例视频: ${detail.videoId || '未知ID'}`);
        console.log(`     时长: ${detail.duration ? detail.duration + '秒' : '未知'}`);
        console.log(`     分辨率: ${detail.width && detail.height ? `${detail.width}x${detail.height}` : '未知'}`);
      }
    }
    
    // 显示关注者列表（如果拦截到）
    if (result.followers && result.followers.length > 0) {
      console.log(`\n👥 关注者列表:`);
      console.log(`   - 关注者数: ${result.followers.length} 个`);
      if (result.followers.length > 0) {
        console.log(`   - 前 3 个关注者:`);
        result.followers.slice(0, 3).forEach((follower, i) => {
          console.log(`     ${i + 1}. @${follower.username || '未知'} - ${follower.displayName || '未知'}`);
          console.log(`        粉丝: ${follower.followers ? follower.followers.display : '未知'}`);
        });
      }
    }
    
    // 显示关注列表（如果拦截到）
    if (result.following && result.following.length > 0) {
      console.log(`\n👤 关注列表:`);
      console.log(`   - 关注数: ${result.following.length} 个`);
      if (result.following.length > 0) {
        console.log(`   - 前 3 个关注:`);
        result.following.slice(0, 3).forEach((follow, i) => {
          console.log(`     ${i + 1}. @${follow.username || '未知'} - ${follow.displayName || '未知'}`);
          console.log(`        粉丝: ${follow.followers ? follow.followers.display : '未知'}`);
        });
      }
    }
    
    // 保存结果到日志文件
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = path.join(projectRoot, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, `cdp-interception-${username}-${timestamp}.json`);
    fs.writeFileSync(logFile, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`\n💾 结果已保存到: ${logFile}`);
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ 测试完成！');
    console.log('='.repeat(80));
    
    return result;
    
  } catch (error) {
    console.error('\n' + '='.repeat(80));
    console.error('❌ 测试失败');
    console.error('='.repeat(80));
    console.error('\n错误信息:', error.message);
    console.error('\n错误堆栈:');
    console.error(error.stack);
    throw error;
  } finally {
    // 不关闭浏览器，保持打开状态以便查看
    if (page) {
      console.log('\n💡 提示: 浏览器保持打开状态，你可以查看页面');
      console.log('   查看完毕后，请手动关闭浏览器窗口');
    }
  }
}

/**
 * 主函数
 */
async function main() {
  const username = process.argv[2] || 'mikayla.ari';
  
  console.log('\n' + '='.repeat(80));
  console.log('🧪 CDP Network 拦截功能测试');
  console.log('='.repeat(80));
  console.log(`\n📝 测试用户名: @${username}`);
  console.log('\n⚠️  前置条件：');
  console.log('   1. 确保已启动 Chrome 并启用远程调试：');
  console.log('      bash scripts/launch-chrome-remote-debug-enrich.sh');
  console.log('   2. 确保网络连接正常');
  console.log('   3. 主页提取不需要登录状态');
  
  try {
    await testCDPInterception(username);
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);


/**
 * 测试 CDP Network 拦截功能
 * 
 * 使用方法：
 * 1. 启动 Chrome 并启用远程调试（用于主页提取）：
 *    bash scripts/launch-chrome-remote-debug-enrich.sh
 * 
 * 2. 运行测试：
 *    node test-cdp-interception.js [username]
 * 
 * 示例：
 *    node test-cdp-interception.js mikayla.ari
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// 加载环境变量
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, './');
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(projectRoot, '.env.local') });

// 导入 CDP 拦截函数
const { extractUserProfileFromPageCDP } = await import('./lib/tools/influencer-functions/extract-user-profile-cdp.js');

/**
 * 连接 CDP 浏览器
 */
async function connectBrowser() {
  const CDP_ENDPOINT = process.env.CDP_ENDPOINT_ENRICH || process.env.CDP_ENDPOINT || 'http://localhost:9223';
  console.log(`\n🔗 连接到 CDP: ${CDP_ENDPOINT}`);
  console.log(`💡 提示: 确保已启动 Chrome 并启用远程调试`);
  console.log(`    bash scripts/launch-chrome-remote-debug-enrich.sh\n`);
  
  let browser = null;
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries) {
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 10000 });
      console.log(`✅ CDP 连接成功（尝试 ${retryCount + 1}/${maxRetries}）`);
      break;
    } catch (error) {
      retryCount++;
      console.warn(`⚠️  CDP 连接失败（尝试 ${retryCount}/${maxRetries}）: ${error.message}`);
      if (retryCount < maxRetries) {
        console.log('等待 2 秒后重试...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  if (!browser) {
    throw new Error(
      `CDP 连接失败（已重试 ${maxRetries} 次）\n` +
      `请确保已启动 Chrome 并启用远程调试：\n` +
      `  bash scripts/launch-chrome-remote-debug-enrich.sh`
    );
  }
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const page = await context.newPage();
  
  return { browser, context, page };
}

/**
 * 测试 CDP Network 拦截
 */
async function testCDPInterception(username) {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 测试 CDP Network 拦截功能');
  console.log('='.repeat(80));
  console.log(`\n📝 测试用户名: @${username}`);
  console.log(`   目标 URL: https://www.tiktok.com/@${username}\n`);
  
  let browser = null;
  let page = null;
  
  try {
    // 连接浏览器
    const { browser: connectedBrowser, page: connectedPage } = await connectBrowser();
    browser = connectedBrowser;
    page = connectedPage;
    
    // 步骤更新回调
    const onStepUpdate = (update) => {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`[${timestamp}] ${update.step || '执行中'}: ${update.message || ''}`);
    };
    
    // 调用 CDP 拦截提取函数
    console.log('\n🚀 开始提取数据（使用 CDP Network 拦截）...\n');
    const startTime = Date.now();
    
    const result = await extractUserProfileFromPageCDP(
      page,
      username,
      {
        onStepUpdate
      }
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // 显示结果
    console.log('\n' + '='.repeat(80));
    console.log('✅ 提取完成！');
    console.log('='.repeat(80));
    console.log(`\n⏱️  耗时: ${duration} 秒`);
    console.log(`\n📊 拦截结果:`);
    console.log(`   - 用户信息 API: ${result.interceptedApis.userDetail ? '✅ 已拦截' : '❌ 未拦截'}`);
    console.log(`   - 视频列表 API: ${result.interceptedApis.itemList} 次`);
    console.log(`   - 视频详情 API: ${result.interceptedApis.itemDetail} 次`);
    console.log(`   - 关注者列表 API: ${result.interceptedApis.followers ? '✅ 已拦截' : '❌ 未拦截'}`);
    console.log(`   - 关注列表 API: ${result.interceptedApis.following ? '✅ 已拦截' : '❌ 未拦截'}`);
    
    console.log(`\n👤 用户信息:`);
    if (result.userInfo) {
      console.log(`   - 用户名: @${result.userInfo.username || '未知'}`);
      console.log(`   - 显示名: ${result.userInfo.displayName || '未知'}`);
      console.log(`   - 头像: ${result.userInfo.avatarUrl ? '✅' : '❌'}`);
      console.log(`   - 简介: ${result.userInfo.bio ? result.userInfo.bio.substring(0, 50) + '...' : '无'}`);
      console.log(`   - 邮箱: ${result.userInfo.email || '未找到'}`);
      console.log(`   - 粉丝数: ${result.userInfo.followers ? result.userInfo.followers.display : '未知'}`);
      console.log(`   - 关注数: ${result.userInfo.following ? result.userInfo.following.display : '未知'}`);
      console.log(`   - 获赞数: ${result.userInfo.likes ? result.userInfo.likes.display : '未知'}`);
      console.log(`   - 视频数: ${result.userInfo.postsCount ? result.userInfo.postsCount.display : '未知'}`);
      console.log(`   - 认证: ${result.userInfo.verified ? '✅' : '❌'}`);
    } else {
      console.log(`   ❌ 未提取到用户信息`);
    }
    
    console.log(`\n📹 视频数据:`);
    console.log(`   - 提取视频数: ${result.videos.length} 个`);
    if (result.videos.length > 0) {
      console.log(`   - 前 3 个视频:`);
      result.videos.slice(0, 3).forEach((video, i) => {
        console.log(`     ${i + 1}. ${video.videoId || '未知ID'}`);
        console.log(`        描述: ${video.description ? video.description.substring(0, 50) + '...' : '无'}`);
        console.log(`        播放: ${video.views ? video.views.display : '未知'}`);
        console.log(`        点赞: ${video.likes ? video.likes.display : '未知'}`);
        console.log(`        评论: ${video.comments ? video.comments.display : '未知'}`);
        console.log(`        分享: ${video.shares ? video.shares.display : '未知'}`);
        console.log(`        收藏: ${video.favorites ? video.favorites.display : '未知'}`);
      });
    }
    
    console.log(`\n📈 统计数据:`);
    if (result.statistics) {
      console.log(`   - 平均播放量: ${result.statistics.avgViews ? result.statistics.avgViews.toLocaleString() : '未知'}`);
      console.log(`   - 平均点赞数: ${result.statistics.avgLikes ? result.statistics.avgLikes.toLocaleString() : '未知'}`);
      console.log(`   - 平均评论数: ${result.statistics.avgComments ? result.statistics.avgComments.toLocaleString() : '未知'}`);
      console.log(`   - 平均收藏数: ${result.statistics.avgFavorites ? result.statistics.avgFavorites.toLocaleString() : '未知'}`);
    }
    
    console.log(`\n⚠️  缺失数据:`);
    if (result.missingData) {
      Object.entries(result.missingData).forEach(([key, value]) => {
        if (value) {
          console.log(`   - ${key}: ${value}`);
        }
      });
    }
    
    // 显示视频详情（如果拦截到）
    if (result.videoDetails && result.videoDetails.length > 0) {
      console.log(`\n🎬 视频详情 (从 itemDetail API):`);
      console.log(`   - 详细视频数: ${result.videoDetails.length} 个`);
      if (result.videoDetails.length > 0) {
        const detail = result.videoDetails[0];
        console.log(`   - 示例视频: ${detail.videoId || '未知ID'}`);
        console.log(`     时长: ${detail.duration ? detail.duration + '秒' : '未知'}`);
        console.log(`     分辨率: ${detail.width && detail.height ? `${detail.width}x${detail.height}` : '未知'}`);
      }
    }
    
    // 显示关注者列表（如果拦截到）
    if (result.followers && result.followers.length > 0) {
      console.log(`\n👥 关注者列表:`);
      console.log(`   - 关注者数: ${result.followers.length} 个`);
      if (result.followers.length > 0) {
        console.log(`   - 前 3 个关注者:`);
        result.followers.slice(0, 3).forEach((follower, i) => {
          console.log(`     ${i + 1}. @${follower.username || '未知'} - ${follower.displayName || '未知'}`);
          console.log(`        粉丝: ${follower.followers ? follower.followers.display : '未知'}`);
        });
      }
    }
    
    // 显示关注列表（如果拦截到）
    if (result.following && result.following.length > 0) {
      console.log(`\n👤 关注列表:`);
      console.log(`   - 关注数: ${result.following.length} 个`);
      if (result.following.length > 0) {
        console.log(`   - 前 3 个关注:`);
        result.following.slice(0, 3).forEach((follow, i) => {
          console.log(`     ${i + 1}. @${follow.username || '未知'} - ${follow.displayName || '未知'}`);
          console.log(`        粉丝: ${follow.followers ? follow.followers.display : '未知'}`);
        });
      }
    }
    
    // 保存结果到日志文件
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = path.join(projectRoot, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, `cdp-interception-${username}-${timestamp}.json`);
    fs.writeFileSync(logFile, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`\n💾 结果已保存到: ${logFile}`);
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ 测试完成！');
    console.log('='.repeat(80));
    
    return result;
    
  } catch (error) {
    console.error('\n' + '='.repeat(80));
    console.error('❌ 测试失败');
    console.error('='.repeat(80));
    console.error('\n错误信息:', error.message);
    console.error('\n错误堆栈:');
    console.error(error.stack);
    throw error;
  } finally {
    // 不关闭浏览器，保持打开状态以便查看
    if (page) {
      console.log('\n💡 提示: 浏览器保持打开状态，你可以查看页面');
      console.log('   查看完毕后，请手动关闭浏览器窗口');
    }
  }
}

/**
 * 主函数
 */
async function main() {
  const username = process.argv[2] || 'mikayla.ari';
  
  console.log('\n' + '='.repeat(80));
  console.log('🧪 CDP Network 拦截功能测试');
  console.log('='.repeat(80));
  console.log(`\n📝 测试用户名: @${username}`);
  console.log('\n⚠️  前置条件：');
  console.log('   1. 确保已启动 Chrome 并启用远程调试：');
  console.log('      bash scripts/launch-chrome-remote-debug-enrich.sh');
  console.log('   2. 确保网络连接正常');
  console.log('   3. 主页提取不需要登录状态');
  
  try {
    await testCDPInterception(username);
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);


/**
 * 测试 CDP Network 拦截功能
 * 
 * 使用方法：
 * 1. 启动 Chrome 并启用远程调试（用于主页提取）：
 *    bash scripts/launch-chrome-remote-debug-enrich.sh
 * 
 * 2. 运行测试：
 *    node test-cdp-interception.js [username]
 * 
 * 示例：
 *    node test-cdp-interception.js mikayla.ari
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// 加载环境变量
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, './');
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(projectRoot, '.env.local') });

// 导入 CDP 拦截函数
const { extractUserProfileFromPageCDP } = await import('./lib/tools/influencer-functions/extract-user-profile-cdp.js');

/**
 * 连接 CDP 浏览器
 */
async function connectBrowser() {
  const CDP_ENDPOINT = process.env.CDP_ENDPOINT_ENRICH || process.env.CDP_ENDPOINT || 'http://localhost:9223';
  console.log(`\n🔗 连接到 CDP: ${CDP_ENDPOINT}`);
  console.log(`💡 提示: 确保已启动 Chrome 并启用远程调试`);
  console.log(`    bash scripts/launch-chrome-remote-debug-enrich.sh\n`);
  
  let browser = null;
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries) {
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 10000 });
      console.log(`✅ CDP 连接成功（尝试 ${retryCount + 1}/${maxRetries}）`);
      break;
    } catch (error) {
      retryCount++;
      console.warn(`⚠️  CDP 连接失败（尝试 ${retryCount}/${maxRetries}）: ${error.message}`);
      if (retryCount < maxRetries) {
        console.log('等待 2 秒后重试...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  if (!browser) {
    throw new Error(
      `CDP 连接失败（已重试 ${maxRetries} 次）\n` +
      `请确保已启动 Chrome 并启用远程调试：\n` +
      `  bash scripts/launch-chrome-remote-debug-enrich.sh`
    );
  }
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const page = await context.newPage();
  
  return { browser, context, page };
}

/**
 * 测试 CDP Network 拦截
 */
async function testCDPInterception(username) {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 测试 CDP Network 拦截功能');
  console.log('='.repeat(80));
  console.log(`\n📝 测试用户名: @${username}`);
  console.log(`   目标 URL: https://www.tiktok.com/@${username}\n`);
  
  let browser = null;
  let page = null;
  
  try {
    // 连接浏览器
    const { browser: connectedBrowser, page: connectedPage } = await connectBrowser();
    browser = connectedBrowser;
    page = connectedPage;
    
    // 步骤更新回调
    const onStepUpdate = (update) => {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`[${timestamp}] ${update.step || '执行中'}: ${update.message || ''}`);
    };
    
    // 调用 CDP 拦截提取函数
    console.log('\n🚀 开始提取数据（使用 CDP Network 拦截）...\n');
    const startTime = Date.now();
    
    const result = await extractUserProfileFromPageCDP(
      page,
      username,
      {
        onStepUpdate
      }
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // 显示结果
    console.log('\n' + '='.repeat(80));
    console.log('✅ 提取完成！');
    console.log('='.repeat(80));
    console.log(`\n⏱️  耗时: ${duration} 秒`);
    console.log(`\n📊 拦截结果:`);
    console.log(`   - 用户信息 API: ${result.interceptedApis.userDetail ? '✅ 已拦截' : '❌ 未拦截'}`);
    console.log(`   - 视频列表 API: ${result.interceptedApis.itemList} 次`);
    console.log(`   - 视频详情 API: ${result.interceptedApis.itemDetail} 次`);
    console.log(`   - 关注者列表 API: ${result.interceptedApis.followers ? '✅ 已拦截' : '❌ 未拦截'}`);
    console.log(`   - 关注列表 API: ${result.interceptedApis.following ? '✅ 已拦截' : '❌ 未拦截'}`);
    
    console.log(`\n👤 用户信息:`);
    if (result.userInfo) {
      console.log(`   - 用户名: @${result.userInfo.username || '未知'}`);
      console.log(`   - 显示名: ${result.userInfo.displayName || '未知'}`);
      console.log(`   - 头像: ${result.userInfo.avatarUrl ? '✅' : '❌'}`);
      console.log(`   - 简介: ${result.userInfo.bio ? result.userInfo.bio.substring(0, 50) + '...' : '无'}`);
      console.log(`   - 邮箱: ${result.userInfo.email || '未找到'}`);
      console.log(`   - 粉丝数: ${result.userInfo.followers ? result.userInfo.followers.display : '未知'}`);
      console.log(`   - 关注数: ${result.userInfo.following ? result.userInfo.following.display : '未知'}`);
      console.log(`   - 获赞数: ${result.userInfo.likes ? result.userInfo.likes.display : '未知'}`);
      console.log(`   - 视频数: ${result.userInfo.postsCount ? result.userInfo.postsCount.display : '未知'}`);
      console.log(`   - 认证: ${result.userInfo.verified ? '✅' : '❌'}`);
    } else {
      console.log(`   ❌ 未提取到用户信息`);
    }
    
    console.log(`\n📹 视频数据:`);
    console.log(`   - 提取视频数: ${result.videos.length} 个`);
    if (result.videos.length > 0) {
      console.log(`   - 前 3 个视频:`);
      result.videos.slice(0, 3).forEach((video, i) => {
        console.log(`     ${i + 1}. ${video.videoId || '未知ID'}`);
        console.log(`        描述: ${video.description ? video.description.substring(0, 50) + '...' : '无'}`);
        console.log(`        播放: ${video.views ? video.views.display : '未知'}`);
        console.log(`        点赞: ${video.likes ? video.likes.display : '未知'}`);
        console.log(`        评论: ${video.comments ? video.comments.display : '未知'}`);
        console.log(`        分享: ${video.shares ? video.shares.display : '未知'}`);
        console.log(`        收藏: ${video.favorites ? video.favorites.display : '未知'}`);
      });
    }
    
    console.log(`\n📈 统计数据:`);
    if (result.statistics) {
      console.log(`   - 平均播放量: ${result.statistics.avgViews ? result.statistics.avgViews.toLocaleString() : '未知'}`);
      console.log(`   - 平均点赞数: ${result.statistics.avgLikes ? result.statistics.avgLikes.toLocaleString() : '未知'}`);
      console.log(`   - 平均评论数: ${result.statistics.avgComments ? result.statistics.avgComments.toLocaleString() : '未知'}`);
      console.log(`   - 平均收藏数: ${result.statistics.avgFavorites ? result.statistics.avgFavorites.toLocaleString() : '未知'}`);
    }
    
    console.log(`\n⚠️  缺失数据:`);
    if (result.missingData) {
      Object.entries(result.missingData).forEach(([key, value]) => {
        if (value) {
          console.log(`   - ${key}: ${value}`);
        }
      });
    }
    
    // 显示视频详情（如果拦截到）
    if (result.videoDetails && result.videoDetails.length > 0) {
      console.log(`\n🎬 视频详情 (从 itemDetail API):`);
      console.log(`   - 详细视频数: ${result.videoDetails.length} 个`);
      if (result.videoDetails.length > 0) {
        const detail = result.videoDetails[0];
        console.log(`   - 示例视频: ${detail.videoId || '未知ID'}`);
        console.log(`     时长: ${detail.duration ? detail.duration + '秒' : '未知'}`);
        console.log(`     分辨率: ${detail.width && detail.height ? `${detail.width}x${detail.height}` : '未知'}`);
      }
    }
    
    // 显示关注者列表（如果拦截到）
    if (result.followers && result.followers.length > 0) {
      console.log(`\n👥 关注者列表:`);
      console.log(`   - 关注者数: ${result.followers.length} 个`);
      if (result.followers.length > 0) {
        console.log(`   - 前 3 个关注者:`);
        result.followers.slice(0, 3).forEach((follower, i) => {
          console.log(`     ${i + 1}. @${follower.username || '未知'} - ${follower.displayName || '未知'}`);
          console.log(`        粉丝: ${follower.followers ? follower.followers.display : '未知'}`);
        });
      }
    }
    
    // 显示关注列表（如果拦截到）
    if (result.following && result.following.length > 0) {
      console.log(`\n👤 关注列表:`);
      console.log(`   - 关注数: ${result.following.length} 个`);
      if (result.following.length > 0) {
        console.log(`   - 前 3 个关注:`);
        result.following.slice(0, 3).forEach((follow, i) => {
          console.log(`     ${i + 1}. @${follow.username || '未知'} - ${follow.displayName || '未知'}`);
          console.log(`        粉丝: ${follow.followers ? follow.followers.display : '未知'}`);
        });
      }
    }
    
    // 保存结果到日志文件
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = path.join(projectRoot, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, `cdp-interception-${username}-${timestamp}.json`);
    fs.writeFileSync(logFile, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`\n💾 结果已保存到: ${logFile}`);
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ 测试完成！');
    console.log('='.repeat(80));
    
    return result;
    
  } catch (error) {
    console.error('\n' + '='.repeat(80));
    console.error('❌ 测试失败');
    console.error('='.repeat(80));
    console.error('\n错误信息:', error.message);
    console.error('\n错误堆栈:');
    console.error(error.stack);
    throw error;
  } finally {
    // 不关闭浏览器，保持打开状态以便查看
    if (page) {
      console.log('\n💡 提示: 浏览器保持打开状态，你可以查看页面');
      console.log('   查看完毕后，请手动关闭浏览器窗口');
    }
  }
}

/**
 * 主函数
 */
async function main() {
  const username = process.argv[2] || 'mikayla.ari';
  
  console.log('\n' + '='.repeat(80));
  console.log('🧪 CDP Network 拦截功能测试');
  console.log('='.repeat(80));
  console.log(`\n📝 测试用户名: @${username}`);
  console.log('\n⚠️  前置条件：');
  console.log('   1. 确保已启动 Chrome 并启用远程调试：');
  console.log('      bash scripts/launch-chrome-remote-debug-enrich.sh');
  console.log('   2. 确保网络连接正常');
  console.log('   3. 主页提取不需要登录状态');
  
  try {
    await testCDPInterception(username);
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);

