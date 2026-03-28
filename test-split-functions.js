#!/usr/bin/env node

/**
 * 测试拆分后的函数：searchInfluencersByKeyword 和 enrichInfluencerProfiles
 * 
 * 使用方法：
 * 1. 确保 Chrome 已启动并启用远程调试：
 *    bash scripts/launch-chrome-remote-debug.sh
 * 
 * 2. 运行测试：
 *    node test-split-functions.js [test-name]
 * 
 * 测试选项：
 *   - all: 运行所有测试（默认）
 *   - search: 仅测试 searchInfluencersByKeyword
 *   - enrich: 仅测试 enrichInfluencerProfiles
 *   - combined: 仅测试 searchAndExtractInfluencers（组合调用）
 */

import { chromium } from 'playwright';
import path from 'path';
import { 
  searchInfluencersByKeyword, 
  enrichInfluencerProfiles,
  searchAndExtractInfluencers 
} from './lib/tools/influencer-functions/search-and-extract-influencers.js';
import { generateSearchKeywords } from './lib/tools/influencer-functions/generate-search-keywords.js';
import dotenv from 'dotenv';

dotenv.config();

// 测试数据
const testProductInfo = {
  productName: "G4Free Wireless Earbuds",
  brand: "G4Free",
  category: "Electronics",
  tags: ["wireless", "earbuds", "bluetooth", "audio"]
};

const testCampaignInfo = {
  platforms: ["TikTok"],
  countries: ["美国"],
  region: ["美国"],
  budget: 10000,
  commission: 0.1
};

const testInfluencerProfile = {
  accountType: "tech",
  followerRange: "10K-1M"
};

// 步骤更新回调
const onStepUpdate = (update) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${update.step || '执行中'}: ${update.message || ''}`);
};

/**
 * 连接 CDP 浏览器
 */
async function connectBrowser() {
  // 验证用户数据目录配置
  const userDataDir = process.env.TIKTOK_USER_DATA_DIR || path.join(process.cwd(), '.tiktok-user-data');
  console.log(`\n📁 用户数据目录: ${userDataDir}`);
  if (process.env.TIKTOK_USER_DATA_DIR) {
    console.log(`✅ 使用环境变量指定的用户数据目录: ${process.env.TIKTOK_USER_DATA_DIR}`);
  } else {
    console.log(`⚠️  使用默认目录: ${userDataDir}`);
    console.log(`💡 提示: 如需使用已登录的目录，请在 .env 中设置 TIKTOK_USER_DATA_DIR`);
  }
  
  const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://localhost:9222';
  console.log(`\n🔗 连接到 CDP: ${CDP_ENDPOINT}`);
  console.log(`💡 提示: 确保启动 Chrome 时使用了相同的用户数据目录`);
  
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
      `  bash scripts/launch-chrome-remote-debug.sh`
    );
  }
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const page = await context.newPage();
  
  // 创建 CDP 会话
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Runtime.enable');
  await client.send('Console.enable');
  
  return { browser, context, page };
}

/**
 * 测试 1: searchInfluencersByKeyword（仅搜索功能）
 * 使用 playwright + chromium（持久化上下文，保持登录状态）
 */
async function testSearchInfluencersByKeyword() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 1: searchInfluencersByKeyword（仅搜索功能）');
  console.log('='.repeat(80));
  console.log('💡 使用 playwright + chromium（持久化上下文，保持登录状态）');
  
  try {
    // 生成关键词
    console.log('\n📝 生成搜索关键词...');
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });
    
    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }
    
    console.log(`✅ 生成 ${keywordsResult.search_queries.length} 个关键词`);
    console.log(`   关键词: ${keywordsResult.search_queries[0]}`);
    
    // 调用搜索函数（函数内部会启动浏览器）
    console.log('\n🔍 开始搜索红人（使用用户数据目录，保持登录状态）...');
    const startTime = Date.now();
    
    const searchResult = await searchInfluencersByKeyword(
      {
        keywords: { search_queries: keywordsResult.search_queries },
        campaignInfo: testCampaignInfo
      },
      { 
        onStepUpdate,
        keepBrowserOpen: true // 测试模式下保持浏览器打开
      }
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ 搜索完成！');
    console.log(`   耗时: ${duration} 秒`);
    console.log(`   找到红人: ${searchResult.influencerRecords.length} 个`);
    console.log(`   找到视频: ${searchResult.videos.length} 个`);
    
    if (searchResult.influencerRecords.length > 0) {
      console.log('\n📋 红人列表（前5个）:');
      searchResult.influencerRecords.slice(0, 5).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
      });
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('💡 浏览器保持打开状态');
    console.log('='.repeat(80));
    console.log('   你可以在浏览器中查看搜索结果');
    console.log('   查看完毕后，请手动关闭浏览器窗口');
    console.log('='.repeat(80));
    
    return searchResult;
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    throw error;
  }
}

/**
 * 测试 2: enrichInfluencerProfiles（仅主页提取功能，测试并发）
 * 使用 playwright + CDP + chrome（手动启动，不需要登录状态）
 */
async function testEnrichInfluencerProfiles() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 2: enrichInfluencerProfiles（主页提取 + 并发）');
  console.log('='.repeat(80));
  console.log('💡 使用 playwright + CDP + chrome（手动启动，不需要登录状态）');
  console.log('⚠️  请确保已启动 Chrome 并启用远程调试：');
  console.log('      bash scripts/launch-chrome-remote-debug.sh');
  
  try {
    // 使用模拟数据（实际测试中可以从数据库或之前的搜索结果获取）
    console.log('\n📝 准备测试数据...');
    const mockRecords = [
      { username: 'testuser1', profileUrl: 'https://www.tiktok.com/@testuser1', displayName: 'Test User 1' },
      { username: 'testuser2', profileUrl: 'https://www.tiktok.com/@testuser2', displayName: 'Test User 2' },
      { username: 'testuser3', profileUrl: 'https://www.tiktok.com/@testuser3', displayName: 'Test User 3' },
    ];
    
    console.log(`   准备提取 ${mockRecords.length} 个红人的主页数据`);
    console.log(`   并发数: 3 个标签页/批`);
    
    // 调用主页提取函数（函数内部会连接 CDP）
    console.log('\n🔍 开始提取主页数据（并发模式，使用 CDP 连接）...');
    const startTime = Date.now();
    
    const enrichedResult = await enrichInfluencerProfiles(
      mockRecords,
      {
        onStepUpdate,
        maxCount: 3,
        concurrency: 3, // 3 个标签页并发
        delayBetweenBatches: { min: 5000, max: 10000 }
      }
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ 主页提取完成！');
    console.log(`   耗时: ${duration} 秒`);
    console.log(`   处理记录: ${enrichedResult.length} 个`);
    
    return enrichedResult;
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    throw error;
  }
}

/**
 * 测试 3: searchAndExtractInfluencers（组合调用，测试完整流程）
 */
async function testCombinedFunction() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 3: searchAndExtractInfluencers（组合调用）');
  console.log('='.repeat(80));
  
  try {
    // 生成关键词
    console.log('\n📝 生成搜索关键词...');
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });
    
    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }
    
    console.log(`✅ 生成 ${keywordsResult.search_queries.length} 个关键词`);
    
    // 调用组合函数
    console.log('\n🔍 开始完整流程（搜索 + 主页提取）...');
    console.log('   注意：主页提取将使用 3 个标签页并发模式');
    const startTime = Date.now();
    
    const result = await searchAndExtractInfluencers({
      keywords: { search_queries: keywordsResult.search_queries },
      platforms: testCampaignInfo.platforms,
      countries: testCampaignInfo.countries,
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    }, {
      maxResults: 10,
      onStepUpdate,
      enrichProfileData: true,
      maxEnrichCount: 5, // 只提取前 5 个，加快测试
      concurrency: 3, // 3 个标签页并发
      delayBetweenBatches: { min: 5000, max: 10000 }
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ 完整流程完成！');
    console.log(`   总耗时: ${duration} 秒`);
    console.log(`   提取红人: ${result.influencers.length} 个`);
    console.log(`   提取视频: ${result.videos.length} 个`);
    console.log(`   保存到数据库: ${result.savedCount} 个`);
    
    if (result.influencers.length > 0) {
      console.log('\n📋 红人列表（前5个）:');
      result.influencers.slice(0, 5).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
        console.log(`      粉丝: ${inf.followers || '未知'}`);
      });
    }
    
    return result;
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    throw error;
  }
}

/**
 * 主测试函数
 */
async function main() {
  const testName = process.argv[2] || 'all';
  
  console.log('\n' + '='.repeat(80));
  console.log('🧪 测试拆分后的函数');
  console.log('='.repeat(80));
  console.log(`\n测试模式: ${testName}`);
  console.log('\n⚠️  前置条件：');
  console.log('   1. 确保已启动 Chrome 并启用远程调试：');
  console.log('      bash scripts/launch-chrome-remote-debug.sh');
  console.log('   2. 确保网络连接正常');
  console.log('   3. 确保已登录 TikTok（搜索功能需要登录状态）');
  console.log('\n📁 用户数据目录配置：');
  const userDataDir = process.env.TIKTOK_USER_DATA_DIR || path.join(process.cwd(), '.tiktok-user-data');
  if (process.env.TIKTOK_USER_DATA_DIR) {
    console.log(`   ✅ 使用环境变量: ${process.env.TIKTOK_USER_DATA_DIR}`);
  } else {
    console.log(`   ⚠️  使用默认目录: ${userDataDir}`);
    console.log(`   💡 提示: 如需使用已登录的目录，请在 .env 中设置 TIKTOK_USER_DATA_DIR`);
    console.log(`   💡 示例: TIKTOK_USER_DATA_DIR=/path/to/your/chrome/user-data`);
  }
  
  try {
    switch (testName) {
      case 'search':
        await testSearchInfluencersByKeyword();
        break;
        
      case 'enrich':
        await testEnrichInfluencerProfiles();
        break;
        
      case 'combined':
        await testCombinedFunction();
        break;
        
      case 'all':
      default:
        console.log('\n📦 运行所有测试...\n');
        await testSearchInfluencersByKeyword();
        await new Promise(resolve => setTimeout(resolve, 3000)); // 等待 3 秒
        await testEnrichInfluencerProfiles();
        await new Promise(resolve => setTimeout(resolve, 3000)); // 等待 3 秒
        await testCombinedFunction();
        break;
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ 所有测试完成！');
    console.log('='.repeat(80));
    
  } catch (error) {
    console.error('\n' + '='.repeat(80));
    console.error('❌ 测试失败');
    console.error('='.repeat(80));
    console.error('\n错误信息:', error.message);
    console.error('\n错误堆栈:');
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);


/**
 * 测试拆分后的函数：searchInfluencersByKeyword 和 enrichInfluencerProfiles
 * 
 * 使用方法：
 * 1. 确保 Chrome 已启动并启用远程调试：
 *    bash scripts/launch-chrome-remote-debug.sh
 * 
 * 2. 运行测试：
 *    node test-split-functions.js [test-name]
 * 
 * 测试选项：
 *   - all: 运行所有测试（默认）
 *   - search: 仅测试 searchInfluencersByKeyword
 *   - enrich: 仅测试 enrichInfluencerProfiles
 *   - combined: 仅测试 searchAndExtractInfluencers（组合调用）
 */

import { chromium } from 'playwright';
import path from 'path';
import { 
  searchInfluencersByKeyword, 
  enrichInfluencerProfiles,
  searchAndExtractInfluencers 
} from './lib/tools/influencer-functions/search-and-extract-influencers.js';
import { generateSearchKeywords } from './lib/tools/influencer-functions/generate-search-keywords.js';
import dotenv from 'dotenv';

dotenv.config();

// 测试数据
const testProductInfo = {
  productName: "G4Free Wireless Earbuds",
  brand: "G4Free",
  category: "Electronics",
  tags: ["wireless", "earbuds", "bluetooth", "audio"]
};

const testCampaignInfo = {
  platforms: ["TikTok"],
  countries: ["美国"],
  region: ["美国"],
  budget: 10000,
  commission: 0.1
};

const testInfluencerProfile = {
  accountType: "tech",
  followerRange: "10K-1M"
};

// 步骤更新回调
const onStepUpdate = (update) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${update.step || '执行中'}: ${update.message || ''}`);
};

/**
 * 连接 CDP 浏览器
 */
async function connectBrowser() {
  // 验证用户数据目录配置
  const userDataDir = process.env.TIKTOK_USER_DATA_DIR || path.join(process.cwd(), '.tiktok-user-data');
  console.log(`\n📁 用户数据目录: ${userDataDir}`);
  if (process.env.TIKTOK_USER_DATA_DIR) {
    console.log(`✅ 使用环境变量指定的用户数据目录: ${process.env.TIKTOK_USER_DATA_DIR}`);
  } else {
    console.log(`⚠️  使用默认目录: ${userDataDir}`);
    console.log(`💡 提示: 如需使用已登录的目录，请在 .env 中设置 TIKTOK_USER_DATA_DIR`);
  }
  
  const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://localhost:9222';
  console.log(`\n🔗 连接到 CDP: ${CDP_ENDPOINT}`);
  console.log(`💡 提示: 确保启动 Chrome 时使用了相同的用户数据目录`);
  
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
      `  bash scripts/launch-chrome-remote-debug.sh`
    );
  }
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const page = await context.newPage();
  
  // 创建 CDP 会话
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Runtime.enable');
  await client.send('Console.enable');
  
  return { browser, context, page };
}

/**
 * 测试 1: searchInfluencersByKeyword（仅搜索功能）
 * 使用 playwright + chromium（持久化上下文，保持登录状态）
 */
async function testSearchInfluencersByKeyword() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 1: searchInfluencersByKeyword（仅搜索功能）');
  console.log('='.repeat(80));
  console.log('💡 使用 playwright + chromium（持久化上下文，保持登录状态）');
  
  try {
    // 生成关键词
    console.log('\n📝 生成搜索关键词...');
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });
    
    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }
    
    console.log(`✅ 生成 ${keywordsResult.search_queries.length} 个关键词`);
    console.log(`   关键词: ${keywordsResult.search_queries[0]}`);
    
    // 调用搜索函数（函数内部会启动浏览器）
    console.log('\n🔍 开始搜索红人（使用用户数据目录，保持登录状态）...');
    const startTime = Date.now();
    
    const searchResult = await searchInfluencersByKeyword(
      {
        keywords: { search_queries: keywordsResult.search_queries },
        campaignInfo: testCampaignInfo
      },
      { 
        onStepUpdate,
        keepBrowserOpen: true // 测试模式下保持浏览器打开
      }
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ 搜索完成！');
    console.log(`   耗时: ${duration} 秒`);
    console.log(`   找到红人: ${searchResult.influencerRecords.length} 个`);
    console.log(`   找到视频: ${searchResult.videos.length} 个`);
    
    if (searchResult.influencerRecords.length > 0) {
      console.log('\n📋 红人列表（前5个）:');
      searchResult.influencerRecords.slice(0, 5).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
      });
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('💡 浏览器保持打开状态');
    console.log('='.repeat(80));
    console.log('   你可以在浏览器中查看搜索结果');
    console.log('   查看完毕后，请手动关闭浏览器窗口');
    console.log('='.repeat(80));
    
    return searchResult;
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    throw error;
  }
}

/**
 * 测试 2: enrichInfluencerProfiles（仅主页提取功能，测试并发）
 * 使用 playwright + CDP + chrome（手动启动，不需要登录状态）
 */
async function testEnrichInfluencerProfiles() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 2: enrichInfluencerProfiles（主页提取 + 并发）');
  console.log('='.repeat(80));
  console.log('💡 使用 playwright + CDP + chrome（手动启动，不需要登录状态）');
  console.log('⚠️  请确保已启动 Chrome 并启用远程调试：');
  console.log('      bash scripts/launch-chrome-remote-debug.sh');
  
  try {
    // 使用模拟数据（实际测试中可以从数据库或之前的搜索结果获取）
    console.log('\n📝 准备测试数据...');
    const mockRecords = [
      { username: 'testuser1', profileUrl: 'https://www.tiktok.com/@testuser1', displayName: 'Test User 1' },
      { username: 'testuser2', profileUrl: 'https://www.tiktok.com/@testuser2', displayName: 'Test User 2' },
      { username: 'testuser3', profileUrl: 'https://www.tiktok.com/@testuser3', displayName: 'Test User 3' },
    ];
    
    console.log(`   准备提取 ${mockRecords.length} 个红人的主页数据`);
    console.log(`   并发数: 3 个标签页/批`);
    
    // 调用主页提取函数（函数内部会连接 CDP）
    console.log('\n🔍 开始提取主页数据（并发模式，使用 CDP 连接）...');
    const startTime = Date.now();
    
    const enrichedResult = await enrichInfluencerProfiles(
      mockRecords,
      {
        onStepUpdate,
        maxCount: 3,
        concurrency: 3, // 3 个标签页并发
        delayBetweenBatches: { min: 5000, max: 10000 }
      }
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ 主页提取完成！');
    console.log(`   耗时: ${duration} 秒`);
    console.log(`   处理记录: ${enrichedResult.length} 个`);
    
    return enrichedResult;
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    throw error;
  }
}

/**
 * 测试 3: searchAndExtractInfluencers（组合调用，测试完整流程）
 */
async function testCombinedFunction() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 3: searchAndExtractInfluencers（组合调用）');
  console.log('='.repeat(80));
  
  try {
    // 生成关键词
    console.log('\n📝 生成搜索关键词...');
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });
    
    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }
    
    console.log(`✅ 生成 ${keywordsResult.search_queries.length} 个关键词`);
    
    // 调用组合函数
    console.log('\n🔍 开始完整流程（搜索 + 主页提取）...');
    console.log('   注意：主页提取将使用 3 个标签页并发模式');
    const startTime = Date.now();
    
    const result = await searchAndExtractInfluencers({
      keywords: { search_queries: keywordsResult.search_queries },
      platforms: testCampaignInfo.platforms,
      countries: testCampaignInfo.countries,
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    }, {
      maxResults: 10,
      onStepUpdate,
      enrichProfileData: true,
      maxEnrichCount: 5, // 只提取前 5 个，加快测试
      concurrency: 3, // 3 个标签页并发
      delayBetweenBatches: { min: 5000, max: 10000 }
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ 完整流程完成！');
    console.log(`   总耗时: ${duration} 秒`);
    console.log(`   提取红人: ${result.influencers.length} 个`);
    console.log(`   提取视频: ${result.videos.length} 个`);
    console.log(`   保存到数据库: ${result.savedCount} 个`);
    
    if (result.influencers.length > 0) {
      console.log('\n📋 红人列表（前5个）:');
      result.influencers.slice(0, 5).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
        console.log(`      粉丝: ${inf.followers || '未知'}`);
      });
    }
    
    return result;
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    throw error;
  }
}

/**
 * 主测试函数
 */
async function main() {
  const testName = process.argv[2] || 'all';
  
  console.log('\n' + '='.repeat(80));
  console.log('🧪 测试拆分后的函数');
  console.log('='.repeat(80));
  console.log(`\n测试模式: ${testName}`);
  console.log('\n⚠️  前置条件：');
  console.log('   1. 确保已启动 Chrome 并启用远程调试：');
  console.log('      bash scripts/launch-chrome-remote-debug.sh');
  console.log('   2. 确保网络连接正常');
  console.log('   3. 确保已登录 TikTok（搜索功能需要登录状态）');
  console.log('\n📁 用户数据目录配置：');
  const userDataDir = process.env.TIKTOK_USER_DATA_DIR || path.join(process.cwd(), '.tiktok-user-data');
  if (process.env.TIKTOK_USER_DATA_DIR) {
    console.log(`   ✅ 使用环境变量: ${process.env.TIKTOK_USER_DATA_DIR}`);
  } else {
    console.log(`   ⚠️  使用默认目录: ${userDataDir}`);
    console.log(`   💡 提示: 如需使用已登录的目录，请在 .env 中设置 TIKTOK_USER_DATA_DIR`);
    console.log(`   💡 示例: TIKTOK_USER_DATA_DIR=/path/to/your/chrome/user-data`);
  }
  
  try {
    switch (testName) {
      case 'search':
        await testSearchInfluencersByKeyword();
        break;
        
      case 'enrich':
        await testEnrichInfluencerProfiles();
        break;
        
      case 'combined':
        await testCombinedFunction();
        break;
        
      case 'all':
      default:
        console.log('\n📦 运行所有测试...\n');
        await testSearchInfluencersByKeyword();
        await new Promise(resolve => setTimeout(resolve, 3000)); // 等待 3 秒
        await testEnrichInfluencerProfiles();
        await new Promise(resolve => setTimeout(resolve, 3000)); // 等待 3 秒
        await testCombinedFunction();
        break;
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ 所有测试完成！');
    console.log('='.repeat(80));
    
  } catch (error) {
    console.error('\n' + '='.repeat(80));
    console.error('❌ 测试失败');
    console.error('='.repeat(80));
    console.error('\n错误信息:', error.message);
    console.error('\n错误堆栈:');
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);


/**
 * 测试拆分后的函数：searchInfluencersByKeyword 和 enrichInfluencerProfiles
 * 
 * 使用方法：
 * 1. 确保 Chrome 已启动并启用远程调试：
 *    bash scripts/launch-chrome-remote-debug.sh
 * 
 * 2. 运行测试：
 *    node test-split-functions.js [test-name]
 * 
 * 测试选项：
 *   - all: 运行所有测试（默认）
 *   - search: 仅测试 searchInfluencersByKeyword
 *   - enrich: 仅测试 enrichInfluencerProfiles
 *   - combined: 仅测试 searchAndExtractInfluencers（组合调用）
 */

import { chromium } from 'playwright';
import path from 'path';
import { 
  searchInfluencersByKeyword, 
  enrichInfluencerProfiles,
  searchAndExtractInfluencers 
} from './lib/tools/influencer-functions/search-and-extract-influencers.js';
import { generateSearchKeywords } from './lib/tools/influencer-functions/generate-search-keywords.js';
import dotenv from 'dotenv';

dotenv.config();

// 测试数据
const testProductInfo = {
  productName: "G4Free Wireless Earbuds",
  brand: "G4Free",
  category: "Electronics",
  tags: ["wireless", "earbuds", "bluetooth", "audio"]
};

const testCampaignInfo = {
  platforms: ["TikTok"],
  countries: ["美国"],
  region: ["美国"],
  budget: 10000,
  commission: 0.1
};

const testInfluencerProfile = {
  accountType: "tech",
  followerRange: "10K-1M"
};

// 步骤更新回调
const onStepUpdate = (update) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${update.step || '执行中'}: ${update.message || ''}`);
};

/**
 * 连接 CDP 浏览器
 */
async function connectBrowser() {
  // 验证用户数据目录配置
  const userDataDir = process.env.TIKTOK_USER_DATA_DIR || path.join(process.cwd(), '.tiktok-user-data');
  console.log(`\n📁 用户数据目录: ${userDataDir}`);
  if (process.env.TIKTOK_USER_DATA_DIR) {
    console.log(`✅ 使用环境变量指定的用户数据目录: ${process.env.TIKTOK_USER_DATA_DIR}`);
  } else {
    console.log(`⚠️  使用默认目录: ${userDataDir}`);
    console.log(`💡 提示: 如需使用已登录的目录，请在 .env 中设置 TIKTOK_USER_DATA_DIR`);
  }
  
  const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://localhost:9222';
  console.log(`\n🔗 连接到 CDP: ${CDP_ENDPOINT}`);
  console.log(`💡 提示: 确保启动 Chrome 时使用了相同的用户数据目录`);
  
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
      `  bash scripts/launch-chrome-remote-debug.sh`
    );
  }
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const page = await context.newPage();
  
  // 创建 CDP 会话
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Runtime.enable');
  await client.send('Console.enable');
  
  return { browser, context, page };
}

/**
 * 测试 1: searchInfluencersByKeyword（仅搜索功能）
 * 使用 playwright + chromium（持久化上下文，保持登录状态）
 */
async function testSearchInfluencersByKeyword() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 1: searchInfluencersByKeyword（仅搜索功能）');
  console.log('='.repeat(80));
  console.log('💡 使用 playwright + chromium（持久化上下文，保持登录状态）');
  
  try {
    // 生成关键词
    console.log('\n📝 生成搜索关键词...');
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });
    
    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }
    
    console.log(`✅ 生成 ${keywordsResult.search_queries.length} 个关键词`);
    console.log(`   关键词: ${keywordsResult.search_queries[0]}`);
    
    // 调用搜索函数（函数内部会启动浏览器）
    console.log('\n🔍 开始搜索红人（使用用户数据目录，保持登录状态）...');
    const startTime = Date.now();
    
    const searchResult = await searchInfluencersByKeyword(
      {
        keywords: { search_queries: keywordsResult.search_queries },
        campaignInfo: testCampaignInfo
      },
      { 
        onStepUpdate,
        keepBrowserOpen: true // 测试模式下保持浏览器打开
      }
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ 搜索完成！');
    console.log(`   耗时: ${duration} 秒`);
    console.log(`   找到红人: ${searchResult.influencerRecords.length} 个`);
    console.log(`   找到视频: ${searchResult.videos.length} 个`);
    
    if (searchResult.influencerRecords.length > 0) {
      console.log('\n📋 红人列表（前5个）:');
      searchResult.influencerRecords.slice(0, 5).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
      });
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('💡 浏览器保持打开状态');
    console.log('='.repeat(80));
    console.log('   你可以在浏览器中查看搜索结果');
    console.log('   查看完毕后，请手动关闭浏览器窗口');
    console.log('='.repeat(80));
    
    return searchResult;
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    throw error;
  }
}

/**
 * 测试 2: enrichInfluencerProfiles（仅主页提取功能，测试并发）
 * 使用 playwright + CDP + chrome（手动启动，不需要登录状态）
 */
async function testEnrichInfluencerProfiles() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 2: enrichInfluencerProfiles（主页提取 + 并发）');
  console.log('='.repeat(80));
  console.log('💡 使用 playwright + CDP + chrome（手动启动，不需要登录状态）');
  console.log('⚠️  请确保已启动 Chrome 并启用远程调试：');
  console.log('      bash scripts/launch-chrome-remote-debug.sh');
  
  try {
    // 使用模拟数据（实际测试中可以从数据库或之前的搜索结果获取）
    console.log('\n📝 准备测试数据...');
    const mockRecords = [
      { username: 'testuser1', profileUrl: 'https://www.tiktok.com/@testuser1', displayName: 'Test User 1' },
      { username: 'testuser2', profileUrl: 'https://www.tiktok.com/@testuser2', displayName: 'Test User 2' },
      { username: 'testuser3', profileUrl: 'https://www.tiktok.com/@testuser3', displayName: 'Test User 3' },
    ];
    
    console.log(`   准备提取 ${mockRecords.length} 个红人的主页数据`);
    console.log(`   并发数: 3 个标签页/批`);
    
    // 调用主页提取函数（函数内部会连接 CDP）
    console.log('\n🔍 开始提取主页数据（并发模式，使用 CDP 连接）...');
    const startTime = Date.now();
    
    const enrichedResult = await enrichInfluencerProfiles(
      mockRecords,
      {
        onStepUpdate,
        maxCount: 3,
        concurrency: 3, // 3 个标签页并发
        delayBetweenBatches: { min: 5000, max: 10000 }
      }
    );
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ 主页提取完成！');
    console.log(`   耗时: ${duration} 秒`);
    console.log(`   处理记录: ${enrichedResult.length} 个`);
    
    return enrichedResult;
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    throw error;
  }
}

/**
 * 测试 3: searchAndExtractInfluencers（组合调用，测试完整流程）
 */
async function testCombinedFunction() {
  console.log('\n' + '='.repeat(80));
  console.log('测试 3: searchAndExtractInfluencers（组合调用）');
  console.log('='.repeat(80));
  
  try {
    // 生成关键词
    console.log('\n📝 生成搜索关键词...');
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });
    
    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }
    
    console.log(`✅ 生成 ${keywordsResult.search_queries.length} 个关键词`);
    
    // 调用组合函数
    console.log('\n🔍 开始完整流程（搜索 + 主页提取）...');
    console.log('   注意：主页提取将使用 3 个标签页并发模式');
    const startTime = Date.now();
    
    const result = await searchAndExtractInfluencers({
      keywords: { search_queries: keywordsResult.search_queries },
      platforms: testCampaignInfo.platforms,
      countries: testCampaignInfo.countries,
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    }, {
      maxResults: 10,
      onStepUpdate,
      enrichProfileData: true,
      maxEnrichCount: 5, // 只提取前 5 个，加快测试
      concurrency: 3, // 3 个标签页并发
      delayBetweenBatches: { min: 5000, max: 10000 }
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n✅ 完整流程完成！');
    console.log(`   总耗时: ${duration} 秒`);
    console.log(`   提取红人: ${result.influencers.length} 个`);
    console.log(`   提取视频: ${result.videos.length} 个`);
    console.log(`   保存到数据库: ${result.savedCount} 个`);
    
    if (result.influencers.length > 0) {
      console.log('\n📋 红人列表（前5个）:');
      result.influencers.slice(0, 5).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
        console.log(`      粉丝: ${inf.followers || '未知'}`);
      });
    }
    
    return result;
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    throw error;
  }
}

/**
 * 主测试函数
 */
async function main() {
  const testName = process.argv[2] || 'all';
  
  console.log('\n' + '='.repeat(80));
  console.log('🧪 测试拆分后的函数');
  console.log('='.repeat(80));
  console.log(`\n测试模式: ${testName}`);
  console.log('\n⚠️  前置条件：');
  console.log('   1. 确保已启动 Chrome 并启用远程调试：');
  console.log('      bash scripts/launch-chrome-remote-debug.sh');
  console.log('   2. 确保网络连接正常');
  console.log('   3. 确保已登录 TikTok（搜索功能需要登录状态）');
  console.log('\n📁 用户数据目录配置：');
  const userDataDir = process.env.TIKTOK_USER_DATA_DIR || path.join(process.cwd(), '.tiktok-user-data');
  if (process.env.TIKTOK_USER_DATA_DIR) {
    console.log(`   ✅ 使用环境变量: ${process.env.TIKTOK_USER_DATA_DIR}`);
  } else {
    console.log(`   ⚠️  使用默认目录: ${userDataDir}`);
    console.log(`   💡 提示: 如需使用已登录的目录，请在 .env 中设置 TIKTOK_USER_DATA_DIR`);
    console.log(`   💡 示例: TIKTOK_USER_DATA_DIR=/path/to/your/chrome/user-data`);
  }
  
  try {
    switch (testName) {
      case 'search':
        await testSearchInfluencersByKeyword();
        break;
        
      case 'enrich':
        await testEnrichInfluencerProfiles();
        break;
        
      case 'combined':
        await testCombinedFunction();
        break;
        
      case 'all':
      default:
        console.log('\n📦 运行所有测试...\n');
        await testSearchInfluencersByKeyword();
        await new Promise(resolve => setTimeout(resolve, 3000)); // 等待 3 秒
        await testEnrichInfluencerProfiles();
        await new Promise(resolve => setTimeout(resolve, 3000)); // 等待 3 秒
        await testCombinedFunction();
        break;
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ 所有测试完成！');
    console.log('='.repeat(80));
    
  } catch (error) {
    console.error('\n' + '='.repeat(80));
    console.error('❌ 测试失败');
    console.error('='.repeat(80));
    console.error('\n错误信息:', error.message);
    console.error('\n错误堆栈:');
    console.error(error.stack);
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);

