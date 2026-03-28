#!/usr/bin/env node

/**
 * 测试 search-and-extract-influencers.js 函数
 * 
 * 使用方法：
 * node test-search-and-extract-influencers.js
 */

import { searchAndExtractInfluencers } from './lib/tools/influencer-functions/search-and-extract-influencers.js';
import { generateSearchKeywords } from './lib/tools/influencer-functions/generate-search-keywords.js';
import dotenv from 'dotenv';

// 加载环境变量
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

/**
 * 主测试函数
 */
async function main() {
  console.log('='.repeat(60));
  console.log('测试 search-and-extract-influencers.js');
  console.log('='.repeat(60));
  console.log('');

  // 步骤更新回调函数（用于显示进度）
  const onStepUpdate = (update) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${update.step || update.action || '执行中'}: ${update.message || update.result || ''}`);
  };

  try {
    // 步骤1: 生成搜索关键词
    console.log('步骤1: 生成搜索关键词...');
    console.log('');
    
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });

    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }

    console.log(`✅ 成功生成 ${keywordsResult.search_queries.length} 个搜索关键词:`);
    keywordsResult.search_queries.forEach((q, i) => {
      console.log(`   ${i + 1}. ${q}`);
    });
    console.log('');

    // 步骤2: 搜索并提取红人数据
    console.log('步骤2: 搜索并提取红人数据...');
    console.log('');
    console.log('⚠️  注意：浏览器将自动打开，请确保：');
    console.log('   1. 已登录 TikTok 账号（如果需要）');
    console.log('   2. 网络连接正常');
    console.log('   3. 有足够的等待时间（可能需要1-2分钟）');
    console.log('');

    const searchResult = await searchAndExtractInfluencers({
      keywords: {
        search_queries: keywordsResult.search_queries
      },
      platforms: testCampaignInfo.platforms,
      countries: testCampaignInfo.countries,
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    }, {
      maxResults: 20,
      onStepUpdate: onStepUpdate
    });

    console.log('');
    console.log('='.repeat(60));
    console.log('测试结果');
    console.log('='.repeat(60));
    console.log('');

    if (searchResult.success) {
      console.log(`✅ 成功提取 ${searchResult.influencers.length} 个红人`);
      console.log(`✅ 成功提取 ${searchResult.videos.length} 个视频`);
      console.log(`✅ 成功保存 ${searchResult.savedCount} 个红人到数据库`);
      console.log('');
      console.log('📊 统计信息:');
      console.log(`   总耗时: ${searchResult.stats.totalTime} 秒`);
      console.log(`   LLM 耗时: ${searchResult.stats.llmTime} 秒`);
      console.log('');
      console.log('👥 红人列表（前10个）:');
      searchResult.influencers.slice(0, 10).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
        console.log(`      主页: ${inf.profileUrl}`);
      });
      console.log('');
      
      if (searchResult.influencers.length > 10) {
        console.log(`   ... 还有 ${searchResult.influencers.length - 10} 个红人`);
      }
      
      console.log('');
      console.log('✅ 测试成功！');
      console.log('');
      console.log('💡 提示：');
      console.log('   - 红人数据已保存到数据库');
      console.log('   - 可以在数据库中查看保存的数据');
      console.log('   - followers、views、isRecommended、reason 等字段将在后续函数中补充');
      
    } else {
      console.error('❌ 测试失败');
      console.error(`错误: ${searchResult.error || '未知错误'}`);
    }

  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('❌ 测试出错');
    console.error('='.repeat(60));
    console.error('');
    console.error('错误信息:', error.message);
    console.error('');
    console.error('错误堆栈:');
    console.error(error.stack);
    console.error('');
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);
/**
 * 测试 search-and-extract-influencers.js 函数
 * 
 * 使用方法：
 * node test-search-and-extract-influencers.js
 */

import { searchAndExtractInfluencers } from './lib/tools/influencer-functions/search-and-extract-influencers.js';
import { generateSearchKeywords } from './lib/tools/influencer-functions/generate-search-keywords.js';
import dotenv from 'dotenv';

// 加载环境变量
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

/**
 * 主测试函数
 */
async function main() {
  console.log('='.repeat(60));
  console.log('测试 search-and-extract-influencers.js');
  console.log('='.repeat(60));
  console.log('');

  // 步骤更新回调函数（用于显示进度）
  const onStepUpdate = (update) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${update.step || update.action || '执行中'}: ${update.message || update.result || ''}`);
  };

  try {
    // 步骤1: 生成搜索关键词
    console.log('步骤1: 生成搜索关键词...');
    console.log('');
    
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });

    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }

    console.log(`✅ 成功生成 ${keywordsResult.search_queries.length} 个搜索关键词:`);
    keywordsResult.search_queries.forEach((q, i) => {
      console.log(`   ${i + 1}. ${q}`);
    });
    console.log('');

    // 步骤2: 搜索并提取红人数据
    console.log('步骤2: 搜索并提取红人数据...');
    console.log('');
    console.log('⚠️  注意：浏览器将自动打开，请确保：');
    console.log('   1. 已登录 TikTok 账号（如果需要）');
    console.log('   2. 网络连接正常');
    console.log('   3. 有足够的等待时间（可能需要1-2分钟）');
    console.log('');

    const searchResult = await searchAndExtractInfluencers({
      keywords: {
        search_queries: keywordsResult.search_queries
      },
      platforms: testCampaignInfo.platforms,
      countries: testCampaignInfo.countries,
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    }, {
      maxResults: 20,
      onStepUpdate: onStepUpdate
    });

    console.log('');
    console.log('='.repeat(60));
    console.log('测试结果');
    console.log('='.repeat(60));
    console.log('');

    if (searchResult.success) {
      console.log(`✅ 成功提取 ${searchResult.influencers.length} 个红人`);
      console.log(`✅ 成功提取 ${searchResult.videos.length} 个视频`);
      console.log(`✅ 成功保存 ${searchResult.savedCount} 个红人到数据库`);
      console.log('');
      console.log('📊 统计信息:');
      console.log(`   总耗时: ${searchResult.stats.totalTime} 秒`);
      console.log(`   LLM 耗时: ${searchResult.stats.llmTime} 秒`);
      console.log('');
      console.log('👥 红人列表（前10个）:');
      searchResult.influencers.slice(0, 10).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
        console.log(`      主页: ${inf.profileUrl}`);
      });
      console.log('');
      
      if (searchResult.influencers.length > 10) {
        console.log(`   ... 还有 ${searchResult.influencers.length - 10} 个红人`);
      }
      
      console.log('');
      console.log('✅ 测试成功！');
      console.log('');
      console.log('💡 提示：');
      console.log('   - 红人数据已保存到数据库');
      console.log('   - 可以在数据库中查看保存的数据');
      console.log('   - followers、views、isRecommended、reason 等字段将在后续函数中补充');
      
    } else {
      console.error('❌ 测试失败');
      console.error(`错误: ${searchResult.error || '未知错误'}`);
    }

  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('❌ 测试出错');
    console.error('='.repeat(60));
    console.error('');
    console.error('错误信息:', error.message);
    console.error('');
    console.error('错误堆栈:');
    console.error(error.stack);
    console.error('');
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);
/**
 * 测试 search-and-extract-influencers.js 函数
 * 
 * 使用方法：
 * node test-search-and-extract-influencers.js
 */

import { searchAndExtractInfluencers } from './lib/tools/influencer-functions/search-and-extract-influencers.js';
import { generateSearchKeywords } from './lib/tools/influencer-functions/generate-search-keywords.js';
import dotenv from 'dotenv';

// 加载环境变量
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

/**
 * 主测试函数
 */
async function main() {
  console.log('='.repeat(60));
  console.log('测试 search-and-extract-influencers.js');
  console.log('='.repeat(60));
  console.log('');

  // 步骤更新回调函数（用于显示进度）
  const onStepUpdate = (update) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${update.step || update.action || '执行中'}: ${update.message || update.result || ''}`);
  };

  try {
    // 步骤1: 生成搜索关键词
    console.log('步骤1: 生成搜索关键词...');
    console.log('');
    
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });

    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }

    console.log(`✅ 成功生成 ${keywordsResult.search_queries.length} 个搜索关键词:`);
    keywordsResult.search_queries.forEach((q, i) => {
      console.log(`   ${i + 1}. ${q}`);
    });
    console.log('');

    // 步骤2: 搜索并提取红人数据
    console.log('步骤2: 搜索并提取红人数据...');
    console.log('');
    console.log('⚠️  注意：浏览器将自动打开，请确保：');
    console.log('   1. 已登录 TikTok 账号（如果需要）');
    console.log('   2. 网络连接正常');
    console.log('   3. 有足够的等待时间（可能需要1-2分钟）');
    console.log('');

    const searchResult = await searchAndExtractInfluencers({
      keywords: {
        search_queries: keywordsResult.search_queries
      },
      platforms: testCampaignInfo.platforms,
      countries: testCampaignInfo.countries,
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    }, {
      maxResults: 20,
      onStepUpdate: onStepUpdate
    });

    console.log('');
    console.log('='.repeat(60));
    console.log('测试结果');
    console.log('='.repeat(60));
    console.log('');

    if (searchResult.success) {
      console.log(`✅ 成功提取 ${searchResult.influencers.length} 个红人`);
      console.log(`✅ 成功提取 ${searchResult.videos.length} 个视频`);
      console.log(`✅ 成功保存 ${searchResult.savedCount} 个红人到数据库`);
      console.log('');
      console.log('📊 统计信息:');
      console.log(`   总耗时: ${searchResult.stats.totalTime} 秒`);
      console.log(`   LLM 耗时: ${searchResult.stats.llmTime} 秒`);
      console.log('');
      console.log('👥 红人列表（前10个）:');
      searchResult.influencers.slice(0, 10).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
        console.log(`      主页: ${inf.profileUrl}`);
      });
      console.log('');
      
      if (searchResult.influencers.length > 10) {
        console.log(`   ... 还有 ${searchResult.influencers.length - 10} 个红人`);
      }
      
      console.log('');
      console.log('✅ 测试成功！');
      console.log('');
      console.log('💡 提示：');
      console.log('   - 红人数据已保存到数据库');
      console.log('   - 可以在数据库中查看保存的数据');
      console.log('   - followers、views、isRecommended、reason 等字段将在后续函数中补充');
      
    } else {
      console.error('❌ 测试失败');
      console.error(`错误: ${searchResult.error || '未知错误'}`);
    }

  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('❌ 测试出错');
    console.error('='.repeat(60));
    console.error('');
    console.error('错误信息:', error.message);
    console.error('');
    console.error('错误堆栈:');
    console.error(error.stack);
    console.error('');
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);
/**
 * 测试 search-and-extract-influencers.js 函数
 * 
 * 使用方法：
 * node test-search-and-extract-influencers.js
 */

import { searchAndExtractInfluencers } from './lib/tools/influencer-functions/search-and-extract-influencers.js';
import { generateSearchKeywords } from './lib/tools/influencer-functions/generate-search-keywords.js';
import dotenv from 'dotenv';

// 加载环境变量
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

/**
 * 主测试函数
 */
async function main() {
  console.log('='.repeat(60));
  console.log('测试 search-and-extract-influencers.js');
  console.log('='.repeat(60));
  console.log('');

  // 步骤更新回调函数（用于显示进度）
  const onStepUpdate = (update) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${update.step || update.action || '执行中'}: ${update.message || update.result || ''}`);
  };

  try {
    // 步骤1: 生成搜索关键词
    console.log('步骤1: 生成搜索关键词...');
    console.log('');
    
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });

    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }

    console.log(`✅ 成功生成 ${keywordsResult.search_queries.length} 个搜索关键词:`);
    keywordsResult.search_queries.forEach((q, i) => {
      console.log(`   ${i + 1}. ${q}`);
    });
    console.log('');

    // 步骤2: 搜索并提取红人数据
    console.log('步骤2: 搜索并提取红人数据...');
    console.log('');
    console.log('⚠️  注意：浏览器将自动打开，请确保：');
    console.log('   1. 已登录 TikTok 账号（如果需要）');
    console.log('   2. 网络连接正常');
    console.log('   3. 有足够的等待时间（可能需要1-2分钟）');
    console.log('');

    const searchResult = await searchAndExtractInfluencers({
      keywords: {
        search_queries: keywordsResult.search_queries
      },
      platforms: testCampaignInfo.platforms,
      countries: testCampaignInfo.countries,
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    }, {
      maxResults: 20,
      onStepUpdate: onStepUpdate
    });

    console.log('');
    console.log('='.repeat(60));
    console.log('测试结果');
    console.log('='.repeat(60));
    console.log('');

    if (searchResult.success) {
      console.log(`✅ 成功提取 ${searchResult.influencers.length} 个红人`);
      console.log(`✅ 成功提取 ${searchResult.videos.length} 个视频`);
      console.log(`✅ 成功保存 ${searchResult.savedCount} 个红人到数据库`);
      console.log('');
      console.log('📊 统计信息:');
      console.log(`   总耗时: ${searchResult.stats.totalTime} 秒`);
      console.log(`   LLM 耗时: ${searchResult.stats.llmTime} 秒`);
      console.log('');
      console.log('👥 红人列表（前10个）:');
      searchResult.influencers.slice(0, 10).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
        console.log(`      主页: ${inf.profileUrl}`);
      });
      console.log('');
      
      if (searchResult.influencers.length > 10) {
        console.log(`   ... 还有 ${searchResult.influencers.length - 10} 个红人`);
      }
      
      console.log('');
      console.log('✅ 测试成功！');
      console.log('');
      console.log('💡 提示：');
      console.log('   - 红人数据已保存到数据库');
      console.log('   - 可以在数据库中查看保存的数据');
      console.log('   - followers、views、isRecommended、reason 等字段将在后续函数中补充');
      
    } else {
      console.error('❌ 测试失败');
      console.error(`错误: ${searchResult.error || '未知错误'}`);
    }

  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('❌ 测试出错');
    console.error('='.repeat(60));
    console.error('');
    console.error('错误信息:', error.message);
    console.error('');
    console.error('错误堆栈:');
    console.error(error.stack);
    console.error('');
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);
/**
 * 测试 search-and-extract-influencers.js 函数
 * 
 * 使用方法：
 * node test-search-and-extract-influencers.js
 */

import { searchAndExtractInfluencers } from './lib/tools/influencer-functions/search-and-extract-influencers.js';
import { generateSearchKeywords } from './lib/tools/influencer-functions/generate-search-keywords.js';
import dotenv from 'dotenv';

// 加载环境变量
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

/**
 * 主测试函数
 */
async function main() {
  console.log('='.repeat(60));
  console.log('测试 search-and-extract-influencers.js');
  console.log('='.repeat(60));
  console.log('');

  // 步骤更新回调函数（用于显示进度）
  const onStepUpdate = (update) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${update.step || update.action || '执行中'}: ${update.message || update.result || ''}`);
  };

  try {
    // 步骤1: 生成搜索关键词
    console.log('步骤1: 生成搜索关键词...');
    console.log('');
    
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });

    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }

    console.log(`✅ 成功生成 ${keywordsResult.search_queries.length} 个搜索关键词:`);
    keywordsResult.search_queries.forEach((q, i) => {
      console.log(`   ${i + 1}. ${q}`);
    });
    console.log('');

    // 步骤2: 搜索并提取红人数据
    console.log('步骤2: 搜索并提取红人数据...');
    console.log('');
    console.log('⚠️  注意：浏览器将自动打开，请确保：');
    console.log('   1. 已登录 TikTok 账号（如果需要）');
    console.log('   2. 网络连接正常');
    console.log('   3. 有足够的等待时间（可能需要1-2分钟）');
    console.log('');

    const searchResult = await searchAndExtractInfluencers({
      keywords: {
        search_queries: keywordsResult.search_queries
      },
      platforms: testCampaignInfo.platforms,
      countries: testCampaignInfo.countries,
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    }, {
      maxResults: 20,
      onStepUpdate: onStepUpdate
    });

    console.log('');
    console.log('='.repeat(60));
    console.log('测试结果');
    console.log('='.repeat(60));
    console.log('');

    if (searchResult.success) {
      console.log(`✅ 成功提取 ${searchResult.influencers.length} 个红人`);
      console.log(`✅ 成功提取 ${searchResult.videos.length} 个视频`);
      console.log(`✅ 成功保存 ${searchResult.savedCount} 个红人到数据库`);
      console.log('');
      console.log('📊 统计信息:');
      console.log(`   总耗时: ${searchResult.stats.totalTime} 秒`);
      console.log(`   LLM 耗时: ${searchResult.stats.llmTime} 秒`);
      console.log('');
      console.log('👥 红人列表（前10个）:');
      searchResult.influencers.slice(0, 10).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
        console.log(`      主页: ${inf.profileUrl}`);
      });
      console.log('');
      
      if (searchResult.influencers.length > 10) {
        console.log(`   ... 还有 ${searchResult.influencers.length - 10} 个红人`);
      }
      
      console.log('');
      console.log('✅ 测试成功！');
      console.log('');
      console.log('💡 提示：');
      console.log('   - 红人数据已保存到数据库');
      console.log('   - 可以在数据库中查看保存的数据');
      console.log('   - followers、views、isRecommended、reason 等字段将在后续函数中补充');
      
    } else {
      console.error('❌ 测试失败');
      console.error(`错误: ${searchResult.error || '未知错误'}`);
    }

  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('❌ 测试出错');
    console.error('='.repeat(60));
    console.error('');
    console.error('错误信息:', error.message);
    console.error('');
    console.error('错误堆栈:');
    console.error(error.stack);
    console.error('');
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);
/**
 * 测试 search-and-extract-influencers.js 函数
 * 
 * 使用方法：
 * node test-search-and-extract-influencers.js
 */

import { searchAndExtractInfluencers } from './lib/tools/influencer-functions/search-and-extract-influencers.js';
import { generateSearchKeywords } from './lib/tools/influencer-functions/generate-search-keywords.js';
import dotenv from 'dotenv';

// 加载环境变量
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

/**
 * 主测试函数
 */
async function main() {
  console.log('='.repeat(60));
  console.log('测试 search-and-extract-influencers.js');
  console.log('='.repeat(60));
  console.log('');

  // 步骤更新回调函数（用于显示进度）
  const onStepUpdate = (update) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${update.step || update.action || '执行中'}: ${update.message || update.result || ''}`);
  };

  try {
    // 步骤1: 生成搜索关键词
    console.log('步骤1: 生成搜索关键词...');
    console.log('');
    
    const keywordsResult = await generateSearchKeywords({
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    });

    if (!keywordsResult.success || !keywordsResult.search_queries || keywordsResult.search_queries.length === 0) {
      throw new Error('关键词生成失败');
    }

    console.log(`✅ 成功生成 ${keywordsResult.search_queries.length} 个搜索关键词:`);
    keywordsResult.search_queries.forEach((q, i) => {
      console.log(`   ${i + 1}. ${q}`);
    });
    console.log('');

    // 步骤2: 搜索并提取红人数据
    console.log('步骤2: 搜索并提取红人数据...');
    console.log('');
    console.log('⚠️  注意：浏览器将自动打开，请确保：');
    console.log('   1. 已登录 TikTok 账号（如果需要）');
    console.log('   2. 网络连接正常');
    console.log('   3. 有足够的等待时间（可能需要1-2分钟）');
    console.log('');

    const searchResult = await searchAndExtractInfluencers({
      keywords: {
        search_queries: keywordsResult.search_queries
      },
      platforms: testCampaignInfo.platforms,
      countries: testCampaignInfo.countries,
      productInfo: testProductInfo,
      campaignInfo: testCampaignInfo,
      influencerProfile: testInfluencerProfile
    }, {
      maxResults: 20,
      onStepUpdate: onStepUpdate
    });

    console.log('');
    console.log('='.repeat(60));
    console.log('测试结果');
    console.log('='.repeat(60));
    console.log('');

    if (searchResult.success) {
      console.log(`✅ 成功提取 ${searchResult.influencers.length} 个红人`);
      console.log(`✅ 成功提取 ${searchResult.videos.length} 个视频`);
      console.log(`✅ 成功保存 ${searchResult.savedCount} 个红人到数据库`);
      console.log('');
      console.log('📊 统计信息:');
      console.log(`   总耗时: ${searchResult.stats.totalTime} 秒`);
      console.log(`   LLM 耗时: ${searchResult.stats.llmTime} 秒`);
      console.log('');
      console.log('👥 红人列表（前10个）:');
      searchResult.influencers.slice(0, 10).forEach((inf, i) => {
        console.log(`   ${i + 1}. @${inf.username} - ${inf.displayName || '无显示名'}`);
        console.log(`      主页: ${inf.profileUrl}`);
      });
      console.log('');
      
      if (searchResult.influencers.length > 10) {
        console.log(`   ... 还有 ${searchResult.influencers.length - 10} 个红人`);
      }
      
      console.log('');
      console.log('✅ 测试成功！');
      console.log('');
      console.log('💡 提示：');
      console.log('   - 红人数据已保存到数据库');
      console.log('   - 可以在数据库中查看保存的数据');
      console.log('   - followers、views、isRecommended、reason 等字段将在后续函数中补充');
      
    } else {
      console.error('❌ 测试失败');
      console.error(`错误: ${searchResult.error || '未知错误'}`);
    }

  } catch (error) {
    console.error('');
    console.error('='.repeat(60));
    console.error('❌ 测试出错');
    console.error('='.repeat(60));
    console.error('');
    console.error('错误信息:', error.message);
    console.error('');
    console.error('错误堆栈:');
    console.error(error.stack);
    console.error('');
    process.exit(1);
  }
}

// 运行测试
main().catch(console.error);