#!/usr/bin/env node

/**
 * 测试脚本：提取用户主页数据
 */

// 原 HTML 解析版提取函数 extractUserProfile 已废弃。
// 如需测试用户主页提取，请改用 CDP 版本 extractUserProfileFromPageCDP。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testUsername = 'kathryn.mueller';
const testUrl = `https://www.tiktok.com/@${testUsername}`;

async function main() {
  console.log('='.repeat(60));
  console.log('测试：提取用户主页数据');
  console.log('='.repeat(60));
  console.log(`用户主页: ${testUrl}`);
  console.log('');
  
  const onStepUpdate = ({ step, message }) => {
    console.log(`[${step}] ${message}`);
  };
  
  try {
    const result = await extractUserProfile(
      { profileUrl: testUrl },
      { onStepUpdate }
    );
    
    console.log('');
    console.log('='.repeat(60));
    console.log('提取结果');
    console.log('='.repeat(60));
    
    if (result.success) {
      console.log('✅ 提取成功');
      console.log('');
      
      // 用户信息
      console.log('用户信息:');
      console.log(`  用户名: ${result.userInfo.username}`);
      console.log(`  显示名: ${result.userInfo.displayName || '未提取到'}`);
      console.log(`  粉丝数: ${result.userInfo.followers?.display || '未提取到'}`);
      console.log(`  关注数: ${result.userInfo.following?.display || '未提取到'}`);
      console.log(`  获赞数: ${result.userInfo.likes?.display || '未提取到'}`);
      console.log(`  视频数: ${result.userInfo.postsCount?.display || '未提取到'}`);
      console.log(`  认证: ${result.userInfo.verified ? '是' : '否'}`);
      console.log(`  简介: ${result.userInfo.bio || '未提取到'}`);
      console.log(`  邮箱: ${result.userInfo.email || '未提取到'}`);
      console.log(`  头像: ${result.userInfo.avatarUrl ? '已提取' : '未提取到'}`);
      console.log('');
      
      // 视频统计
      console.log('视频统计:');
      console.log(`  视频数量: ${result.statistics.videoCount}`);
      console.log(`  平均播放量: ${result.statistics.avgViews?.toLocaleString() || '未提取到'}`);
      console.log(`  平均点赞量: ${result.statistics.avgLikes?.toLocaleString() || '未提取到'}`);
      console.log(`  平均评论量: ${result.statistics.avgComments?.toLocaleString() || '未提取到'}`);
      console.log(`  平均收藏量: ${result.statistics.avgFavorites?.toLocaleString() || '未提取到'}`);
      console.log('');
      
      
      // 缺失数据
      if (result.missingData) {
        console.log('缺失数据说明:');
        Object.entries(result.missingData).forEach(([key, value]) => {
          if (value) {
            console.log(`  ${key}: ${value}`);
          }
        });
        console.log('');
      }
      
      // 提取说明
      if (result.extractionNotes) {
        console.log('提取说明:');
        console.log(`  方法: ${result.extractionNotes.method}`);
        console.log(`  健壮性: ${result.extractionNotes.robustness}`);
        console.log('  限制:');
        result.extractionNotes.limitations.forEach(limitation => {
          console.log(`    - ${limitation}`);
        });
        console.log('');
      }
      
      // 保存结果到 JSON
      const logsDir = path.join(__dirname, '../logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const resultFile = path.join(logsDir, `user-profile-${testUsername}-${timestamp}.json`);
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`✅ 结果已保存到: ${resultFile}`);
      
      // 显示前 5 个视频的详细信息
      console.log('');
      console.log('前 5 个视频详情:');
      result.videos.slice(0, 5).forEach((video, idx) => {
        console.log(`\n${idx + 1}. 视频 ${video.videoId}`);
        console.log(`   URL: ${video.videoUrl}`);
        console.log(`   播放量: ${video.views?.display || '未提取到'}`);
        console.log(`   点赞量: ${video.likes?.display || '未提取到'}`);
        console.log(`   评论量: ${video.comments?.display || '未提取到'}`);
        console.log(`   收藏量: ${video.favorites?.display || '未提取到'}`);
        console.log(`   文案: ${video.caption || video.description || '未提取到'}`);
        console.log(`   标签: ${video.hashtags?.join(', ') || '无'}`);
        console.log(`   @提及: ${video.mentions?.join(', ') || '无'}`);
      });
      
    } else {
      console.log('❌ 提取失败');
      console.log(`错误: ${result.error}`);
    }
    
  } catch (error) {
    console.error('❌ 发生错误:', error);
    process.exit(1);
  }
}

main();
/**
 * 测试脚本：提取用户主页数据
 */

// legacy: extractUserProfile 已移除；保留此脚本仅作参考，实际提取请使用 CDP 版本。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testUsername = 'kathryn.mueller';
const testUrl = `https://www.tiktok.com/@${testUsername}`;

async function main() {
  console.log('='.repeat(60));
  console.log('测试：提取用户主页数据');
  console.log('='.repeat(60));
  console.log(`用户主页: ${testUrl}`);
  console.log('');
  
  const onStepUpdate = ({ step, message }) => {
    console.log(`[${step}] ${message}`);
  };
  
  try {
    const result = await extractUserProfile(
      { profileUrl: testUrl },
      { onStepUpdate }
    );
    
    console.log('');
    console.log('='.repeat(60));
    console.log('提取结果');
    console.log('='.repeat(60));
    
    if (result.success) {
      console.log('✅ 提取成功');
      console.log('');
      
      // 用户信息
      console.log('用户信息:');
      console.log(`  用户名: ${result.userInfo.username}`);
      console.log(`  显示名: ${result.userInfo.displayName || '未提取到'}`);
      console.log(`  粉丝数: ${result.userInfo.followers?.display || '未提取到'}`);
      console.log(`  关注数: ${result.userInfo.following?.display || '未提取到'}`);
      console.log(`  获赞数: ${result.userInfo.likes?.display || '未提取到'}`);
      console.log(`  视频数: ${result.userInfo.postsCount?.display || '未提取到'}`);
      console.log(`  认证: ${result.userInfo.verified ? '是' : '否'}`);
      console.log(`  简介: ${result.userInfo.bio || '未提取到'}`);
      console.log(`  邮箱: ${result.userInfo.email || '未提取到'}`);
      console.log(`  头像: ${result.userInfo.avatarUrl ? '已提取' : '未提取到'}`);
      console.log('');
      
      // 视频统计
      console.log('视频统计:');
      console.log(`  视频数量: ${result.statistics.videoCount}`);
      console.log(`  平均播放量: ${result.statistics.avgViews?.toLocaleString() || '未提取到'}`);
      console.log(`  平均点赞量: ${result.statistics.avgLikes?.toLocaleString() || '未提取到'}`);
      console.log(`  平均评论量: ${result.statistics.avgComments?.toLocaleString() || '未提取到'}`);
      console.log(`  平均收藏量: ${result.statistics.avgFavorites?.toLocaleString() || '未提取到'}`);
      console.log('');
      
      
      // 缺失数据
      if (result.missingData) {
        console.log('缺失数据说明:');
        Object.entries(result.missingData).forEach(([key, value]) => {
          if (value) {
            console.log(`  ${key}: ${value}`);
          }
        });
        console.log('');
      }
      
      // 提取说明
      if (result.extractionNotes) {
        console.log('提取说明:');
        console.log(`  方法: ${result.extractionNotes.method}`);
        console.log(`  健壮性: ${result.extractionNotes.robustness}`);
        console.log('  限制:');
        result.extractionNotes.limitations.forEach(limitation => {
          console.log(`    - ${limitation}`);
        });
        console.log('');
      }
      
      // 保存结果到 JSON
      const logsDir = path.join(__dirname, '../logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const resultFile = path.join(logsDir, `user-profile-${testUsername}-${timestamp}.json`);
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`✅ 结果已保存到: ${resultFile}`);
      
      // 显示前 5 个视频的详细信息
      console.log('');
      console.log('前 5 个视频详情:');
      result.videos.slice(0, 5).forEach((video, idx) => {
        console.log(`\n${idx + 1}. 视频 ${video.videoId}`);
        console.log(`   URL: ${video.videoUrl}`);
        console.log(`   播放量: ${video.views?.display || '未提取到'}`);
        console.log(`   点赞量: ${video.likes?.display || '未提取到'}`);
        console.log(`   评论量: ${video.comments?.display || '未提取到'}`);
        console.log(`   收藏量: ${video.favorites?.display || '未提取到'}`);
        console.log(`   文案: ${video.caption || video.description || '未提取到'}`);
        console.log(`   标签: ${video.hashtags?.join(', ') || '无'}`);
        console.log(`   @提及: ${video.mentions?.join(', ') || '无'}`);
      });
      
    } else {
      console.log('❌ 提取失败');
      console.log(`错误: ${result.error}`);
    }
    
  } catch (error) {
    console.error('❌ 发生错误:', error);
    process.exit(1);
  }
}

main();
/**
 * 测试脚本：提取用户主页数据
 */

import { extractUserProfile } from '../lib/tools/influencer-functions/extract-user-profile.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testUsername = 'kathryn.mueller';
const testUrl = `https://www.tiktok.com/@${testUsername}`;

async function main() {
  console.log('='.repeat(60));
  console.log('测试：提取用户主页数据');
  console.log('='.repeat(60));
  console.log(`用户主页: ${testUrl}`);
  console.log('');
  
  const onStepUpdate = ({ step, message }) => {
    console.log(`[${step}] ${message}`);
  };
  
  try {
    const result = await extractUserProfile(
      { profileUrl: testUrl },
      { onStepUpdate }
    );
    
    console.log('');
    console.log('='.repeat(60));
    console.log('提取结果');
    console.log('='.repeat(60));
    
    if (result.success) {
      console.log('✅ 提取成功');
      console.log('');
      
      // 用户信息
      console.log('用户信息:');
      console.log(`  用户名: ${result.userInfo.username}`);
      console.log(`  显示名: ${result.userInfo.displayName || '未提取到'}`);
      console.log(`  粉丝数: ${result.userInfo.followers?.display || '未提取到'}`);
      console.log(`  关注数: ${result.userInfo.following?.display || '未提取到'}`);
      console.log(`  获赞数: ${result.userInfo.likes?.display || '未提取到'}`);
      console.log(`  视频数: ${result.userInfo.postsCount?.display || '未提取到'}`);
      console.log(`  认证: ${result.userInfo.verified ? '是' : '否'}`);
      console.log(`  简介: ${result.userInfo.bio || '未提取到'}`);
      console.log(`  邮箱: ${result.userInfo.email || '未提取到'}`);
      console.log(`  头像: ${result.userInfo.avatarUrl ? '已提取' : '未提取到'}`);
      console.log('');
      
      // 视频统计
      console.log('视频统计:');
      console.log(`  视频数量: ${result.statistics.videoCount}`);
      console.log(`  平均播放量: ${result.statistics.avgViews?.toLocaleString() || '未提取到'}`);
      console.log(`  平均点赞量: ${result.statistics.avgLikes?.toLocaleString() || '未提取到'}`);
      console.log(`  平均评论量: ${result.statistics.avgComments?.toLocaleString() || '未提取到'}`);
      console.log(`  平均收藏量: ${result.statistics.avgFavorites?.toLocaleString() || '未提取到'}`);
      console.log('');
      
      
      // 缺失数据
      if (result.missingData) {
        console.log('缺失数据说明:');
        Object.entries(result.missingData).forEach(([key, value]) => {
          if (value) {
            console.log(`  ${key}: ${value}`);
          }
        });
        console.log('');
      }
      
      // 提取说明
      if (result.extractionNotes) {
        console.log('提取说明:');
        console.log(`  方法: ${result.extractionNotes.method}`);
        console.log(`  健壮性: ${result.extractionNotes.robustness}`);
        console.log('  限制:');
        result.extractionNotes.limitations.forEach(limitation => {
          console.log(`    - ${limitation}`);
        });
        console.log('');
      }
      
      // 保存结果到 JSON
      const logsDir = path.join(__dirname, '../logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const resultFile = path.join(logsDir, `user-profile-${testUsername}-${timestamp}.json`);
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`✅ 结果已保存到: ${resultFile}`);
      
      // 显示前 5 个视频的详细信息
      console.log('');
      console.log('前 5 个视频详情:');
      result.videos.slice(0, 5).forEach((video, idx) => {
        console.log(`\n${idx + 1}. 视频 ${video.videoId}`);
        console.log(`   URL: ${video.videoUrl}`);
        console.log(`   播放量: ${video.views?.display || '未提取到'}`);
        console.log(`   点赞量: ${video.likes?.display || '未提取到'}`);
        console.log(`   评论量: ${video.comments?.display || '未提取到'}`);
        console.log(`   收藏量: ${video.favorites?.display || '未提取到'}`);
        console.log(`   文案: ${video.caption || video.description || '未提取到'}`);
        console.log(`   标签: ${video.hashtags?.join(', ') || '无'}`);
        console.log(`   @提及: ${video.mentions?.join(', ') || '无'}`);
      });
      
    } else {
      console.log('❌ 提取失败');
      console.log(`错误: ${result.error}`);
    }
    
  } catch (error) {
    console.error('❌ 发生错误:', error);
    process.exit(1);
  }
}

main();
/**
 * 测试脚本：提取用户主页数据
 */

import { extractUserProfile } from '../lib/tools/influencer-functions/extract-user-profile.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testUsername = 'kathryn.mueller';
const testUrl = `https://www.tiktok.com/@${testUsername}`;

async function main() {
  console.log('='.repeat(60));
  console.log('测试：提取用户主页数据');
  console.log('='.repeat(60));
  console.log(`用户主页: ${testUrl}`);
  console.log('');
  
  const onStepUpdate = ({ step, message }) => {
    console.log(`[${step}] ${message}`);
  };
  
  try {
    const result = await extractUserProfile(
      { profileUrl: testUrl },
      { onStepUpdate }
    );
    
    console.log('');
    console.log('='.repeat(60));
    console.log('提取结果');
    console.log('='.repeat(60));
    
    if (result.success) {
      console.log('✅ 提取成功');
      console.log('');
      
      // 用户信息
      console.log('用户信息:');
      console.log(`  用户名: ${result.userInfo.username}`);
      console.log(`  显示名: ${result.userInfo.displayName || '未提取到'}`);
      console.log(`  粉丝数: ${result.userInfo.followers?.display || '未提取到'}`);
      console.log(`  关注数: ${result.userInfo.following?.display || '未提取到'}`);
      console.log(`  获赞数: ${result.userInfo.likes?.display || '未提取到'}`);
      console.log(`  视频数: ${result.userInfo.postsCount?.display || '未提取到'}`);
      console.log(`  认证: ${result.userInfo.verified ? '是' : '否'}`);
      console.log(`  简介: ${result.userInfo.bio || '未提取到'}`);
      console.log(`  邮箱: ${result.userInfo.email || '未提取到'}`);
      console.log(`  头像: ${result.userInfo.avatarUrl ? '已提取' : '未提取到'}`);
      console.log('');
      
      // 视频统计
      console.log('视频统计:');
      console.log(`  视频数量: ${result.statistics.videoCount}`);
      console.log(`  平均播放量: ${result.statistics.avgViews?.toLocaleString() || '未提取到'}`);
      console.log(`  平均点赞量: ${result.statistics.avgLikes?.toLocaleString() || '未提取到'}`);
      console.log(`  平均评论量: ${result.statistics.avgComments?.toLocaleString() || '未提取到'}`);
      console.log(`  平均收藏量: ${result.statistics.avgFavorites?.toLocaleString() || '未提取到'}`);
      console.log('');
      
      
      // 缺失数据
      if (result.missingData) {
        console.log('缺失数据说明:');
        Object.entries(result.missingData).forEach(([key, value]) => {
          if (value) {
            console.log(`  ${key}: ${value}`);
          }
        });
        console.log('');
      }
      
      // 提取说明
      if (result.extractionNotes) {
        console.log('提取说明:');
        console.log(`  方法: ${result.extractionNotes.method}`);
        console.log(`  健壮性: ${result.extractionNotes.robustness}`);
        console.log('  限制:');
        result.extractionNotes.limitations.forEach(limitation => {
          console.log(`    - ${limitation}`);
        });
        console.log('');
      }
      
      // 保存结果到 JSON
      const logsDir = path.join(__dirname, '../logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const resultFile = path.join(logsDir, `user-profile-${testUsername}-${timestamp}.json`);
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`✅ 结果已保存到: ${resultFile}`);
      
      // 显示前 5 个视频的详细信息
      console.log('');
      console.log('前 5 个视频详情:');
      result.videos.slice(0, 5).forEach((video, idx) => {
        console.log(`\n${idx + 1}. 视频 ${video.videoId}`);
        console.log(`   URL: ${video.videoUrl}`);
        console.log(`   播放量: ${video.views?.display || '未提取到'}`);
        console.log(`   点赞量: ${video.likes?.display || '未提取到'}`);
        console.log(`   评论量: ${video.comments?.display || '未提取到'}`);
        console.log(`   收藏量: ${video.favorites?.display || '未提取到'}`);
        console.log(`   文案: ${video.caption || video.description || '未提取到'}`);
        console.log(`   标签: ${video.hashtags?.join(', ') || '无'}`);
        console.log(`   @提及: ${video.mentions?.join(', ') || '无'}`);
      });
      
    } else {
      console.log('❌ 提取失败');
      console.log(`错误: ${result.error}`);
    }
    
  } catch (error) {
    console.error('❌ 发生错误:', error);
    process.exit(1);
  }
}

main();
/**
 * 测试脚本：提取用户主页数据
 */

import { extractUserProfile } from '../lib/tools/influencer-functions/extract-user-profile.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testUsername = 'kathryn.mueller';
const testUrl = `https://www.tiktok.com/@${testUsername}`;

async function main() {
  console.log('='.repeat(60));
  console.log('测试：提取用户主页数据');
  console.log('='.repeat(60));
  console.log(`用户主页: ${testUrl}`);
  console.log('');
  
  const onStepUpdate = ({ step, message }) => {
    console.log(`[${step}] ${message}`);
  };
  
  try {
    const result = await extractUserProfile(
      { profileUrl: testUrl },
      { onStepUpdate }
    );
    
    console.log('');
    console.log('='.repeat(60));
    console.log('提取结果');
    console.log('='.repeat(60));
    
    if (result.success) {
      console.log('✅ 提取成功');
      console.log('');
      
      // 用户信息
      console.log('用户信息:');
      console.log(`  用户名: ${result.userInfo.username}`);
      console.log(`  显示名: ${result.userInfo.displayName || '未提取到'}`);
      console.log(`  粉丝数: ${result.userInfo.followers?.display || '未提取到'}`);
      console.log(`  关注数: ${result.userInfo.following?.display || '未提取到'}`);
      console.log(`  获赞数: ${result.userInfo.likes?.display || '未提取到'}`);
      console.log(`  视频数: ${result.userInfo.postsCount?.display || '未提取到'}`);
      console.log(`  认证: ${result.userInfo.verified ? '是' : '否'}`);
      console.log(`  简介: ${result.userInfo.bio || '未提取到'}`);
      console.log(`  邮箱: ${result.userInfo.email || '未提取到'}`);
      console.log(`  头像: ${result.userInfo.avatarUrl ? '已提取' : '未提取到'}`);
      console.log('');
      
      // 视频统计
      console.log('视频统计:');
      console.log(`  视频数量: ${result.statistics.videoCount}`);
      console.log(`  平均播放量: ${result.statistics.avgViews?.toLocaleString() || '未提取到'}`);
      console.log(`  平均点赞量: ${result.statistics.avgLikes?.toLocaleString() || '未提取到'}`);
      console.log(`  平均评论量: ${result.statistics.avgComments?.toLocaleString() || '未提取到'}`);
      console.log(`  平均收藏量: ${result.statistics.avgFavorites?.toLocaleString() || '未提取到'}`);
      console.log('');
      
      
      // 缺失数据
      if (result.missingData) {
        console.log('缺失数据说明:');
        Object.entries(result.missingData).forEach(([key, value]) => {
          if (value) {
            console.log(`  ${key}: ${value}`);
          }
        });
        console.log('');
      }
      
      // 提取说明
      if (result.extractionNotes) {
        console.log('提取说明:');
        console.log(`  方法: ${result.extractionNotes.method}`);
        console.log(`  健壮性: ${result.extractionNotes.robustness}`);
        console.log('  限制:');
        result.extractionNotes.limitations.forEach(limitation => {
          console.log(`    - ${limitation}`);
        });
        console.log('');
      }
      
      // 保存结果到 JSON
      const logsDir = path.join(__dirname, '../logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const resultFile = path.join(logsDir, `user-profile-${testUsername}-${timestamp}.json`);
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`✅ 结果已保存到: ${resultFile}`);
      
      // 显示前 5 个视频的详细信息
      console.log('');
      console.log('前 5 个视频详情:');
      result.videos.slice(0, 5).forEach((video, idx) => {
        console.log(`\n${idx + 1}. 视频 ${video.videoId}`);
        console.log(`   URL: ${video.videoUrl}`);
        console.log(`   播放量: ${video.views?.display || '未提取到'}`);
        console.log(`   点赞量: ${video.likes?.display || '未提取到'}`);
        console.log(`   评论量: ${video.comments?.display || '未提取到'}`);
        console.log(`   收藏量: ${video.favorites?.display || '未提取到'}`);
        console.log(`   文案: ${video.caption || video.description || '未提取到'}`);
        console.log(`   标签: ${video.hashtags?.join(', ') || '无'}`);
        console.log(`   @提及: ${video.mentions?.join(', ') || '无'}`);
      });
      
    } else {
      console.log('❌ 提取失败');
      console.log(`错误: ${result.error}`);
    }
    
  } catch (error) {
    console.error('❌ 发生错误:', error);
    process.exit(1);
  }
}

main();
/**
 * 测试脚本：提取用户主页数据
 */

import { extractUserProfile } from '../lib/tools/influencer-functions/extract-user-profile.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testUsername = 'kathryn.mueller';
const testUrl = `https://www.tiktok.com/@${testUsername}`;

async function main() {
  console.log('='.repeat(60));
  console.log('测试：提取用户主页数据');
  console.log('='.repeat(60));
  console.log(`用户主页: ${testUrl}`);
  console.log('');
  
  const onStepUpdate = ({ step, message }) => {
    console.log(`[${step}] ${message}`);
  };
  
  try {
    const result = await extractUserProfile(
      { profileUrl: testUrl },
      { onStepUpdate }
    );
    
    console.log('');
    console.log('='.repeat(60));
    console.log('提取结果');
    console.log('='.repeat(60));
    
    if (result.success) {
      console.log('✅ 提取成功');
      console.log('');
      
      // 用户信息
      console.log('用户信息:');
      console.log(`  用户名: ${result.userInfo.username}`);
      console.log(`  显示名: ${result.userInfo.displayName || '未提取到'}`);
      console.log(`  粉丝数: ${result.userInfo.followers?.display || '未提取到'}`);
      console.log(`  关注数: ${result.userInfo.following?.display || '未提取到'}`);
      console.log(`  获赞数: ${result.userInfo.likes?.display || '未提取到'}`);
      console.log(`  视频数: ${result.userInfo.postsCount?.display || '未提取到'}`);
      console.log(`  认证: ${result.userInfo.verified ? '是' : '否'}`);
      console.log(`  简介: ${result.userInfo.bio || '未提取到'}`);
      console.log(`  邮箱: ${result.userInfo.email || '未提取到'}`);
      console.log(`  头像: ${result.userInfo.avatarUrl ? '已提取' : '未提取到'}`);
      console.log('');
      
      // 视频统计
      console.log('视频统计:');
      console.log(`  视频数量: ${result.statistics.videoCount}`);
      console.log(`  平均播放量: ${result.statistics.avgViews?.toLocaleString() || '未提取到'}`);
      console.log(`  平均点赞量: ${result.statistics.avgLikes?.toLocaleString() || '未提取到'}`);
      console.log(`  平均评论量: ${result.statistics.avgComments?.toLocaleString() || '未提取到'}`);
      console.log(`  平均收藏量: ${result.statistics.avgFavorites?.toLocaleString() || '未提取到'}`);
      console.log('');
      
      
      // 缺失数据
      if (result.missingData) {
        console.log('缺失数据说明:');
        Object.entries(result.missingData).forEach(([key, value]) => {
          if (value) {
            console.log(`  ${key}: ${value}`);
          }
        });
        console.log('');
      }
      
      // 提取说明
      if (result.extractionNotes) {
        console.log('提取说明:');
        console.log(`  方法: ${result.extractionNotes.method}`);
        console.log(`  健壮性: ${result.extractionNotes.robustness}`);
        console.log('  限制:');
        result.extractionNotes.limitations.forEach(limitation => {
          console.log(`    - ${limitation}`);
        });
        console.log('');
      }
      
      // 保存结果到 JSON
      const logsDir = path.join(__dirname, '../logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const resultFile = path.join(logsDir, `user-profile-${testUsername}-${timestamp}.json`);
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
      console.log(`✅ 结果已保存到: ${resultFile}`);
      
      // 显示前 5 个视频的详细信息
      console.log('');
      console.log('前 5 个视频详情:');
      result.videos.slice(0, 5).forEach((video, idx) => {
        console.log(`\n${idx + 1}. 视频 ${video.videoId}`);
        console.log(`   URL: ${video.videoUrl}`);
        console.log(`   播放量: ${video.views?.display || '未提取到'}`);
        console.log(`   点赞量: ${video.likes?.display || '未提取到'}`);
        console.log(`   评论量: ${video.comments?.display || '未提取到'}`);
        console.log(`   收藏量: ${video.favorites?.display || '未提取到'}`);
        console.log(`   文案: ${video.caption || video.description || '未提取到'}`);
        console.log(`   标签: ${video.hashtags?.join(', ') || '无'}`);
        console.log(`   @提及: ${video.mentions?.join(', ') || '无'}`);
      });
      
    } else {
      console.log('❌ 提取失败');
      console.log(`错误: ${result.error}`);
    }
    
  } catch (error) {
    console.error('❌ 发生错误:', error);
    process.exit(1);
  }
}

main();