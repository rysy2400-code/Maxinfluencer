#!/usr/bin/env node

/**
 * TikTok 浏览器启动脚本
 * 
 * 用途：打开持久化浏览器上下文并访问 TikTok 搜索页面
 * 
 * 使用方法：
 * 1. 设置用户数据目录环境变量：
 *    export TIKTOK_USER_DATA_DIR=/path/to/tiktok-user-data
 * 
 * 2. 运行脚本：
 *    node scripts/tiktok-login.js
 * 
 * 3. 浏览器会打开指定的搜索页面
 * 
 * 4. 按 Enter 键关闭浏览器
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import fs from 'fs';
import { callDeepSeekLLM } from '../lib/utils/llm-client.js';
import { shouldTriggerRuleUpdate } from '../lib/html-extraction/rules-trigger.js';
import { updateRulesWithRetry } from '../lib/html-extraction/rules-updater.js';
import { extractWithRules } from '../lib/html-extraction/extraction-engine.js';

// 加载环境变量
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 获取用户数据目录
const userDataDir = process.env.TIKTOK_USER_DATA_DIR || path.join(__dirname, '../.tiktok-user-data');

console.log('='.repeat(60));
console.log('TikTok 浏览器启动脚本');
console.log('='.repeat(60));
console.log(`用户数据目录: ${userDataDir}`);
console.log('');

if (!process.env.TIKTOK_USER_DATA_DIR) {
  console.log('提示: 可以通过设置 TIKTOK_USER_DATA_DIR 环境变量指定用户数据目录');
  console.log(`当前使用默认目录: ${userDataDir}`);
  console.log('');
}

let context = null;
let page = null;

async function main() {
  try {
    console.log('正在启动浏览器（非 headless 模式）...');
    
    // 创建持久化浏览器上下文（非 headless，以便手动登录）
    // 使用增强的反检测措施
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // 显示浏览器，以便手动登录
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.tiktok.com/',
        'Origin': 'https://www.tiktok.com',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0'
      }
    });

    console.log('浏览器已启动');
    console.log('');

    // 创建新页面
    page = await context.newPage();
    
    // 添加反检测脚本（隐藏自动化特征）
    await page.addInitScript(() => {
      // 隐藏 webdriver 属性
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false
      });

      // 覆盖 plugins 属性
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });

      // 覆盖 languages 属性
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });

      // 覆盖 permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // 覆盖 chrome 对象
      window.chrome = {
        runtime: {}
      };

      // 覆盖 permissions
      Object.defineProperty(navigator, 'permissions', {
        get: () => ({
          query: async (parameters) => {
            return { state: 'granted' };
          }
        })
      });
    });

    // 访问 TikTok 搜索页面
    console.log('正在访问 TikTok 搜索页面...');
    await page.goto('https://www.tiktok.com/search/video?q=g4free&t=1771358977782', { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 // 增加超时时间到60秒
    });
    await page.waitForTimeout(5000); // 等待页面完全加载
    
    console.log('');
    console.log('='.repeat(60));
    console.log('浏览器已打开搜索页面');
    console.log('开始获取视频和红人信息...');
    console.log('='.repeat(60));
    console.log('');

    // 使用 AI Agent 提取视频和红人信息（一次调用）
    const results = await extractVideosAndInfluencersWithAI(page);
    
    // 检查是否为测试模式（只测试 Markdown 转换）
    const isTestMode = results.markdown !== undefined;
    
    if (isTestMode) {
      // 测试模式：只显示 Markdown 转换结果
      console.log('');
      console.log('='.repeat(60));
      console.log('✅ Markdown 转换测试完成');
      console.log('='.repeat(60));
      console.log(`📊 统计信息：`);
      console.log(`   - 视频数量: ${results.stats.videoCount}`);
      console.log(`   - 用户数量: ${results.stats.influencerCount}`);
      console.log(`   - Markdown 长度: ${results.markdown.length.toLocaleString()} 字符`);
      console.log(`   - 估算 Token: ${results.stats.tokenEstimate.markdown.toLocaleString()}`);
      console.log(`   - 总耗时: ${results.stats.totalTime} 秒`);
      console.log('');
      console.log('💡 提示：查看 logs/markdown-input-*.md 文件检查 Markdown 内容');
      console.log('💡 提示：检查 Markdown 中是否包含播放量、点赞数等信息');
    } else {
      // 正常模式：显示完整提取结果
      console.log('');
      console.log('='.repeat(60));
      console.log('提取结果汇总');
      console.log('='.repeat(60));
      console.log(`✅ 成功提取 ${results.videos.length} 个视频`);
      console.log(`✅ 成功提取 ${results.influencers.length} 个红人信息`);
      console.log('');
      
      // 打印统计信息
      console.log('='.repeat(60));
      console.log('提取统计信息');
      console.log('='.repeat(60));
      console.log(`总耗时: ${results.stats.totalTime} 秒`);
      console.log(`LLM 调用耗时: ${results.stats.llmTime} 秒`);
      console.log('');
      console.log('HTML 信息:');
      console.log(`  原始长度: ${results.stats.htmlLength.original.toLocaleString()} 字符`);
      console.log(`  优化后长度: ${results.stats.htmlLength.optimized.toLocaleString()} 字符`);
      console.log(`  减少: ${results.stats.htmlLength.reduction}`);
      console.log('');
      console.log('Token 估算:');
      console.log(`  原始 HTML: ${results.stats.tokenEstimate.original.toLocaleString()} tokens`);
      console.log(`  优化后 HTML: ${results.stats.tokenEstimate.optimized.toLocaleString()} tokens`);
      console.log(`  完整 Prompt: ${results.stats.tokenEstimate.prompt.toLocaleString()} tokens`);
      console.log('');
      
      // 打印优化建议
      if (results.stats.optimizationSuggestions.length > 0) {
        console.log('='.repeat(60));
        console.log('优化建议');
        console.log('='.repeat(60));
        results.stats.optimizationSuggestions.forEach((suggestion, index) => {
          console.log(`\n${index + 1}. [${suggestion.level.toUpperCase()}] ${suggestion.message}`);
          if (suggestion.actions) {
            suggestion.actions.forEach(action => console.log(`   ${action}`));
          } else if (suggestion.action) {
            console.log(`   ${suggestion.action}`);
          }
        });
        console.log('');
      }
      
      // 打印前5个视频信息
      if (results.videos.length > 0) {
        console.log('='.repeat(60));
        console.log('前5个视频信息');
        console.log('='.repeat(60));
        results.videos.slice(0, 5).forEach((video, index) => {
          console.log(`\n${index + 1}. 视频ID: ${video.videoId || '未知'}`);
          console.log(`   作者: @${video.username || '未知'}`);
          console.log(`   播放量: ${video.views?.display || '0'}`);
          console.log(`   点赞数: ${video.likes?.display || '0'}`);
          console.log(`   链接: ${video.videoUrl || '未知'}`);
        });
      }
      
      // 打印前5个红人信息
      if (results.influencers.length > 0) {
        console.log('\n' + '='.repeat(60));
        console.log('前5个红人信息');
        console.log('='.repeat(60));
        results.influencers.slice(0, 5).forEach((influencer, index) => {
          console.log(`\n${index + 1}. 用户名: @${influencer.username || '未知'}`);
          console.log(`   显示名称: ${influencer.displayName || '未知'}`);
          console.log(`   粉丝数: ${influencer.followers?.display || '未知'}`);
          console.log(`   主页链接: ${influencer.profileUrl || '未知'}`);
        });
      }
    }
    
    console.log('');
    console.log('='.repeat(60));
    console.log('按 Enter 键关闭浏览器...');
    console.log('='.repeat(60));
    console.log('');

    // 等待用户按 Enter 键关闭浏览器
    await waitForEnter();

  } catch (error) {
    console.error('❌ 发生错误:', error.message);
    console.error(error.stack);
  } finally {
    // 关闭浏览器
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // 忽略错误
      }
    }
    if (context) {
      try {
        await context.close();
      } catch (e) {
        // 忽略错误
      }
    }
    console.log('');
    console.log('浏览器已关闭');
  }
}

/**
 * 解析粉丝数字符串（如 "1.2M", "500K", "1.5万"）
 * @param {string} text - 粉丝数字符串
 * @returns {Object} - { count: number, display: string }
 */
function parseFollowersCount(text) {
  if (!text || typeof text !== 'string') {
    return { count: 0, display: '0' };
  }

  const cleaned = text.trim().toLowerCase();
  
  // 处理中文单位
  if (cleaned.includes('万')) {
    const num = parseFloat(cleaned.replace('万', ''));
    const count = Math.round(num * 10000);
    return { count, display: cleaned };
  }
  
  // 处理 K
  if (cleaned.includes('k')) {
    const num = parseFloat(cleaned.replace('k', ''));
    const count = Math.round(num * 1000);
    return { count, display: cleaned };
  }
  
  // 处理 M
  if (cleaned.includes('m')) {
    const num = parseFloat(cleaned.replace('m', ''));
    const count = Math.round(num * 1000000);
    return { count, display: cleaned };
  }
  
  // 处理纯数字
  const num = parseFloat(cleaned.replace(/[^\d.]/g, ''));
  const count = isNaN(num) ? 0 : Math.round(num);
  return { count, display: count.toString() };
}

/**
 * 清理和优化 HTML，减少大小
 * @param {string} html - 原始 HTML
 * @returns {string} - 优化后的 HTML
 */
function optimizeHTML(html) {
  // 1. 移除脚本和样式（最优先）
  let optimized = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  optimized = optimized.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  
  // 2. 移除注释
  optimized = optimized.replace(/<!--[\s\S]*?-->/g, '');
  
  // 3. 移除noscript标签
  optimized = optimized.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  
  // 4. 移除meta标签（除了必要的）
  optimized = optimized.replace(/<meta[^>]*>/gi, '');
  
  // 5. 移除SVG（通常很大且不包含关键信息）
  optimized = optimized.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
  
  // 6. 移除iframe
  optimized = optimized.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
  
  // 7. 移除不必要的属性，只保留关键属性
  // 保留：href, src, alt, class, id, data-e2e, data-testid
  optimized = optimized.replace(/\s+(on\w+)=["'][^"']*["']/gi, '');
  optimized = optimized.replace(/\s+(style|onclick|onerror|onload|aria-\w+|role|tabindex|data-\w+(?!-e2e|-testid))=["'][^"']*["']/gi, '');
  
  // 8. 移除空的div/span等标签
  optimized = optimized.replace(/<(div|span|p|section|article|header|footer|nav|aside)[^>]*>\s*<\/(div|span|p|section|article|header|footer|nav|aside)>/gi, '');
  
  // 9. 压缩空白字符
  optimized = optimized.replace(/\s+/g, ' ');
  optimized = optimized.replace(/>\s+</g, '><');
  
  // 10. 移除多余的换行和空白
  optimized = optimized.replace(/\n\s*\n/g, '\n');
  
  return optimized.trim();
}

/**
 * 基于 HTML 长度给出优化建议
 * @param {number} htmlLength - HTML 长度（字符数）
 * @param {number} videoCount - 视频数量
 * @returns {Object} - { suggestions: Array, optimizedLength: number }
 */
function getOptimizationSuggestions(htmlLength, videoCount) {
  const suggestions = [];
  const avgLengthPerVideo = htmlLength / Math.max(videoCount, 1);
  
  // 估算 token 数量（粗略：1 token ≈ 4 字符）
  const estimatedTokens = Math.ceil(htmlLength / 4);
  
  console.log(`[优化建议] HTML 长度: ${htmlLength.toLocaleString()} 字符`);
  console.log(`[优化建议] 估算 Token 数: ${estimatedTokens.toLocaleString()}`);
  console.log(`[优化建议] 平均每个视频: ${avgLengthPerVideo.toLocaleString()} 字符`);
  
  // 检查是否超过常见模型的 token 限制
  if (estimatedTokens > 100000) {
    suggestions.push({
      level: 'high',
      message: `HTML 过大（${estimatedTokens.toLocaleString()} tokens），可能超过模型限制`,
      action: '建议：大幅减少 HTML 大小，移除不必要的元素'
    });
  } else if (estimatedTokens > 50000) {
    suggestions.push({
      level: 'medium',
      message: `HTML 较大（${estimatedTokens.toLocaleString()} tokens），可能影响处理速度`,
      action: '建议：优化 HTML，移除脚本、样式等不必要内容'
    });
  }
  
  // 检查平均每个视频的 HTML 大小
  if (avgLengthPerVideo > 50000) {
    suggestions.push({
      level: 'medium',
      message: `平均每个视频 HTML 过大（${avgLengthPerVideo.toLocaleString()} 字符）`,
      action: '建议：只提取视频卡片区域，移除页面其他部分'
    });
  }
  
  // 优化建议
  if (htmlLength > 200000) {
    suggestions.push({
      level: 'high',
      message: 'HTML 超过 200KB，建议优化',
      actions: [
        '1. 只提取包含视频的区域（移除页头、页脚、侧边栏等）',
        '2. 移除所有 script 和 style 标签',
        '3. 移除不必要的属性（只保留 href, src, class, data-e2e 等关键属性）',
        '4. 压缩空白字符',
        '5. 考虑使用截图代替 HTML（如果模型支持）'
      ]
    });
  } else if (htmlLength > 100000) {
    suggestions.push({
      level: 'medium',
      message: 'HTML 超过 100KB，建议优化',
      actions: [
        '1. 移除 script 和 style 标签',
        '2. 压缩空白字符',
        '3. 只保留关键属性'
      ]
    });
  }
  
  // 计算优化后的预估大小
  const optimizedLength = Math.ceil(htmlLength * 0.3); // 假设优化后减少 70%
  const optimizedTokens = Math.ceil(optimizedLength / 4);
  
  return {
    suggestions,
    originalLength: htmlLength,
    originalTokens: estimatedTokens,
    optimizedLength,
    optimizedTokens,
    reduction: ((htmlLength - optimizedLength) / htmlLength * 100).toFixed(1)
  };
}

// 通用 displayName 文本，应过滤掉
const GENERIC_DISPLAY_NAMES = new Set([
  'profile', 'view profile', 'view', 'see more', 'more', 'link',
  'profile picture', 'avatar', 'user', 'creator', 'author',
  'x-signature', 'css-', 'styled', 'tiktok', 'video', 'signature'
]);

// 无效的显示名模式（CSS 类名、HTML 属性值等）
const INVALID_DISPLAY_NAME_PATTERNS = [
  /^css-/,  // CSS 类名
  /^t-[A-Za-z0-9]+$/,  // Tailwind 类名
  /^[a-z]+-[a-z0-9]+-[a-z0-9]+$/,  // CSS 类名模式
  /^x-signature$/i,  // URL 签名参数
  /^[a-f0-9]{32,}$/i,  // MD5 哈希
  /^[A-Za-z0-9_-]{20,}$/,  // 长随机字符串
  /^[A-Z][a-z]+[A-Z]/,  // 驼峰命名（可能是类名）
  /--/,  // CSS 类名中的双破折号
  /^[a-z]+-[a-z]+-[a-z]+-[a-z]+/,  // 多个连字符（CSS 类名）
];

/**
 * 判断是否为有效的红人显示名（非通用文本、CSS 类名等）
 */
function isValidDisplayName(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 2 || t.length > 80) return false;
  
  const lower = t.toLowerCase();
  if (GENERIC_DISPLAY_NAMES.has(lower)) return false;
  if (/^\d+$/.test(t)) return false; // 纯数字
  if (/^[@#]?\w+$/.test(t) && t === t.replace('@', '')) return false; // 仅 @username 格式
  
  // 检查无效模式
  for (const pattern of INVALID_DISPLAY_NAME_PATTERNS) {
    if (pattern.test(t)) return false;
  }
  
  // 不能包含 URL 特征
  if (t.includes('http') || t.includes('://') || t.includes('www.')) return false;
  
  // 不能是纯技术标识符
  if (/^[a-z0-9_-]+$/i.test(t) && t.length > 15 && !/[aeiouAEIOU]/.test(t)) return false;
  
  return true;
}

/**
 * 从 HTML 上下文中提取红人显示名（在 @username 附近查找）
 * 改进：更智能地过滤 CSS 类名、HTML 属性值、时间信息等
 */
function extractDisplayNameFromContext(html, username, searchRadius = 800) {
  const usernamePattern = new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
  const match = html.match(usernamePattern);
  if (!match) return null;
  
  const idx = html.indexOf(match[0]);
  const start = Math.max(0, idx - searchRadius);
  const end = Math.min(html.length, idx + match[0].length + searchRadius);
  const context = html.substring(start, end);
  
  // 移除 HTML 标签和属性
  let textOnly = context.replace(/<[^>]+>/g, ' ');
  // 移除常见的 HTML 属性值模式
  textOnly = textOnly.replace(/class=["'][^"']*["']/gi, ' ');
  textOnly = textOnly.replace(/id=["'][^"']*["']/gi, ' ');
  textOnly = textOnly.replace(/data-[^=]*=["'][^"']*["']/gi, ' ');
  textOnly = textOnly.replace(/\s+/g, ' ').trim();
  
  // 移除时间信息（如 "1d ago", "2h ago", "23h ago" 等）
  textOnly = textOnly.replace(/\d+[hdwm]\s*(?:ago|前)/gi, ' ');
  textOnly = textOnly.replace(/\d+-\d+/g, ' '); // 移除 "2-3", "2-6" 等
  textOnly = textOnly.replace(/\s+/g, ' ').trim();
  
  // 查找可能的显示名：在用户名之后出现的文本
  const usernameIndex = textOnly.toLowerCase().indexOf(`@${username.toLowerCase()}`);
  if (usernameIndex === -1) return null;
  
  const afterUsername = textOnly.substring(usernameIndex + username.length + 1); // +1 for @
  
  // 查找显示名候选（排除包含用户名、时间、URL 等的内容）
  const candidates = afterUsername.match(/\b([A-Za-z][A-Za-z0-9\s\-_.']{2,50})\b/g);
  
  if (candidates) {
    for (const c of candidates) {
      const cleaned = c.trim();
      
      // 排除包含用户名的情况
      if (cleaned.toLowerCase().includes(username.toLowerCase())) continue;
      
      // 排除包含时间模式的情况
      if (/\d+[hdwm]\s*(?:ago|前)/i.test(cleaned)) continue;
      if (/\d+-\d+/.test(cleaned)) continue;
      
      // 排除包含常见操作词的情况
      if (/upload|profile|view|see|more|link|click/i.test(cleaned)) continue;
      
      // 排除看起来像 CSS 类名的情况
      if (/^[a-z]+-[a-z]+-[a-z]+/.test(cleaned.toLowerCase())) continue;
      if (/^[a-z]+[A-Z]/.test(cleaned) && cleaned.length < 10) continue; // 短驼峰命名
      
      if (isValidDisplayName(cleaned) && 
          cleaned.length >= 2 &&
          cleaned.length <= 50 &&
          !cleaned.match(/^\d+/) &&  // 不以数字开头
          !cleaned.includes('@') &&  // 不包含 @
          !cleaned.includes('#') &&  // 不包含 #
          !cleaned.includes('http') &&  // 不包含 URL
          !cleaned.includes('://')) {  // 不包含协议
        return cleaned;
      }
    }
  }
  
  // 备用：在整个上下文中查找，但更严格
  const allCandidates = textOnly.match(/\b([A-Z][A-Za-z0-9\s\-_.']{2,50})\b/g); // 只匹配以大写字母开头的
  if (allCandidates) {
    for (const c of allCandidates) {
      const cleaned = c.trim();
      
      // 排除包含用户名的情况
      if (cleaned.toLowerCase().includes(username.toLowerCase())) continue;
      
      // 排除时间信息
      if (/\d+[hdwm]\s*(?:ago|前)/i.test(cleaned)) continue;
      
      if (isValidDisplayName(cleaned) && 
          !cleaned.includes('@') &&
          !cleaned.includes('#') &&
          !cleaned.includes('http') &&
          cleaned.length >= 2 &&
          cleaned.length <= 50) {
        return cleaned;
      }
    }
  }
  
  return null;
}

/**
 * 缩短封面 URL（移除 query 参数，减少 token）
 */
function shortenCoverUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const qIdx = url.indexOf('?');
  return qIdx > 0 ? url.substring(0, qIdx) : url;
}

/**
 * 将 HTML 转换为超精简 Markdown，只保留视频和红人相关的关键信息
 * 目标：完整保留视频数据、红人数据（含红人显示名等）
 * @param {string} html - 原始或已优化的 HTML
 * @returns {string} - 超精简后的 Markdown 文本
 */
function htmlToCompactMarkdown(html) {
  if (!html || typeof html !== 'string') return '';

  const extractedData = {
    videos: [],
    users: [],  // Map: username -> { username, profileUrl, displayName, followers, avatarUrl }
    images: []
  };

  // 1. 提取所有视频链接（包含视频ID和用户名）
  const videoLinkRegex = /<a[^>]*href=["']([^"']*\/video\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  const seenVideoIds = new Set();
  
  while ((match = videoLinkRegex.exec(html)) !== null) {
    const fullUrl = match[1];
    const videoId = match[2];
    const linkText = match[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    
    if (!seenVideoIds.has(videoId)) {
      seenVideoIds.add(videoId);
      
      const usernameMatch = fullUrl.match(/@([^\/]+)/);
      const username = usernameMatch ? usernameMatch[1] : null;
      
      const numberMatch = linkText.match(/^(\d+\.?\d*)\s*([KMkm]?)$/);
      let possibleStat = null;
      if (numberMatch) {
        const num = parseFloat(numberMatch[1]);
        const unit = numberMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          possibleStat = { count: Math.round(count), display: linkText };
        }
      }
      
      extractedData.videos.push({
        videoId,
        videoUrl: fullUrl.startsWith('http') ? fullUrl : `https://www.tiktok.com${fullUrl}`,
        username,
        linkText: numberMatch ? null : linkText,
        possibleStat
      });
    }
  }

  // 2. 提取所有用户链接（@username 格式），并合并视频作者
  const userMap = new Map(); // username -> userObj
  
  // 2.1 从 profile 链接提取
  const userLinkRegex = /<a[^>]*href=["']([^"']*\/@([^\/\?"']+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = userLinkRegex.exec(html)) !== null) {
    const fullUrl = match[1];
    const username = match[2];
    let linkText = match[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    
    // 清理 linkText：移除时间信息、用户名等
    linkText = linkText.replace(/\d+[hdwm]\s*(?:ago|前)/gi, '').trim();
    linkText = linkText.replace(new RegExp(`@?${username}`, 'gi'), '').trim();
    linkText = linkText.replace(/^\d+-\d+\s*/, '').trim(); // 移除开头的 "2-3" 等
    
    if (!fullUrl.includes('/video/') && username) {
      const profileUrl = fullUrl.startsWith('http') ? fullUrl : `https://www.tiktok.com${fullUrl}`;
      let displayName = linkText && isValidDisplayName(linkText) ? linkText : null;
      
      // 如果 linkText 包含用户名，不将其作为显示名
      if (displayName && displayName.toLowerCase().includes(username.toLowerCase())) {
        displayName = null;
      }
      
      if (!userMap.has(username)) {
        userMap.set(username, {
          username,
          profileUrl,
          displayName,
          followers: null,
          avatarUrl: null
        });
      } else if (displayName && isValidDisplayName(displayName)) {
        // 只在显示名有效时才更新
        userMap.get(username).displayName = displayName;
      }
    }
  }
  
  // 2.2 确保所有视频作者都在用户列表中
  extractedData.videos.forEach(v => {
    if (v.username && !userMap.has(v.username)) {
      userMap.set(v.username, {
        username: v.username,
        profileUrl: `https://www.tiktok.com/@${v.username}`,
        displayName: null,
        followers: null,
        avatarUrl: null
      });
    }
  });
  
  extractedData.users = Array.from(userMap.values());

  // 3. 提取图片（视频封面和头像）
  const imageRegex = /<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi;
  const seenImages = new Set();
  
  while ((match = imageRegex.exec(html)) !== null) {
    const src = match[1];
    const alt = match[2] || '';
    
    // 只保留看起来像视频封面或头像的图片（包含特定关键词）
    if (src && !seenImages.has(src) && 
        (src.includes('tiktok') || src.includes('video') || src.includes('avatar') || src.includes('user'))) {
      seenImages.add(src);
      extractedData.images.push({ src, alt });
    }
  }

  // 4. 为每个视频提取数据（基于 DOM 结构，仅提取 HTML 中实际存在的数据）
  // 参考：docs/tiktok-search-html-data-analysis.md
  // 搜索页 HTML 中：仅有点赞数(video-count)、无播放量/评论/收藏
  extractedData.videos.forEach((video, idx) => {
    const videoUrlPattern = new RegExp(video.videoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const videoMatch = html.match(videoUrlPattern);
    
    if (videoMatch) {
      const matchIndex = html.indexOf(videoMatch[0]);
      const start = Math.max(0, matchIndex - 500);
      const end = Math.min(html.length, matchIndex + videoMatch[0].length + 2500);
      const context = html.substring(start, end);
      
      // 4.1 点赞数：来自 strong.video-count / StrongVideoCount（HTML 中唯一的统计数字）
      const likesMatch = context.match(/video-count[^>]*>(\d+)<\/strong>|StrongVideoCount[^>]*>(\d+)<\/strong>/i);
      if (likesMatch) {
        const likesNum = parseInt(likesMatch[1] || likesMatch[2], 10);
        if (!isNaN(likesNum) && likesNum >= 0) {
          video.likes = { count: likesNum, display: String(likesNum) };
        }
      }
      
      // 4.2 视频描述：来自封面 img 的 alt（最完整，含 caption+hashtags+@mentions+音乐）
      const imgAltMatches = context.matchAll(/<img[^>]*alt=["']([^"']{10,})["'][^>]*>/gi);
      for (const imgMatch of imgAltMatches) {
        const imgSrc = imgMatch[0].match(/src=["']([^"']+)["']/);
        const alt = imgMatch[1];
        if (!alt || alt.length < 10) continue;
        const isAvatar = imgSrc && (imgSrc[1].includes('avt-') || imgSrc[1].includes('avatar'));
        if (isAvatar) continue; // 跳过头像
        video.description = alt;
        break;
      }
      
      // 4.3 解析描述：提取 caption、hashtags、@mentions、音乐
      if (video.description) {
        const desc = video.description;
        const hashtags = desc.match(/#[\w\u4e00-\u9fa5]+/g);
        if (hashtags) video.hashtags = [...new Set(hashtags)];
        const mentions = desc.match(/@[\w]+(?:\s+[\w]+)*/g);
        if (mentions) video.mentions = [...new Set(mentions)];
        const createdBy = desc.match(/created by (.+?) with/i);
        if (createdBy) video.creator = createdBy[1].trim();
        const musicMatch = desc.match(/with ([^']+(?:'s original sound)?)/i);
        if (musicMatch) video.music = musicMatch[1].trim();
        const captionEnd = desc.search(/#|@|created by/i);
        if (captionEnd > 0) {
          video.caption = desc.substring(0, captionEnd).trim();
        } else if (captionEnd === -1) {
          video.caption = desc;
        }
      }
      
      // 4.4 发布时间：来自 DivTimeTag
      const timeMatch = context.match(/DivTimeTag[^>]*>([^<]+)</i) || 
                        context.match(/eh1ph4315[^>]*>([^<]+)</i);
      if (timeMatch) {
        const t = timeMatch[1].trim();
        if (t && /^\d+[hdwm]?\s*(?:ago|前)?$/i.test(t) || /^\d+-\d+$/.test(t) || /just now|刚刚|刚才/i.test(t)) {
          video.postedTime = t;
        }
      }
      
      // 4.5 封面图：非头像的 tiktok 图片
      const coverImgMatch = context.match(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi);
      if (coverImgMatch) {
        for (const imgTag of coverImgMatch) {
          const srcMatch = imgTag.match(/src=["']([^"']+)["']/);
          if (!srcMatch) continue;
          const src = srcMatch[1];
          const isAvatar = src.includes('avt-') || src.includes('avatar');
          if (src.includes('tiktok') && !isAvatar) {
            video.thumbnail = src;
            break;
          }
        }
      }
      
      // 注意：HTML 中无播放量、评论数、分享数、收藏数，不输出
    }
  });

  // 5. 为每个用户提取粉丝数、显示名、头像、认证状态等
  extractedData.users.forEach((user) => {
    // 5.1 若尚无 displayName，从 HTML 上下文中尝试提取（使用改进的提取逻辑）
    if (!user.displayName || !isValidDisplayName(user.displayName)) {
      const ctxDisplayName = extractDisplayNameFromContext(html, user.username, 1000);
      if (ctxDisplayName && isValidDisplayName(ctxDisplayName)) {
        user.displayName = ctxDisplayName;
      } else {
        user.displayName = null; // 清除无效的显示名
      }
    }
    
    // 5.2 从用户链接附近提取粉丝数、头像、认证状态等
    const userUrlPattern = new RegExp(`/@${user.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|"|'|\\s|$)`, 'i');
    const userMatch = html.match(userUrlPattern);
    
    if (userMatch) {
      const matchIndex = html.indexOf(userMatch[0]);
      const start = Math.max(0, matchIndex - 600);
      const end = Math.min(html.length, matchIndex + userMatch[0].length + 600);
      const context = html.substring(start, end);
      const contextText = context.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      
      // 提取粉丝数
      const followersMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:followers?|粉丝|关注者)/i);
      if (followersMatch) {
        const num = parseFloat(followersMatch[1]);
        const unit = followersMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.followers = { count: Math.round(count), display: followersMatch[0].trim() };
        }
      }
      
      // 提取关注数（following）
      const followingMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:following|关注)/i);
      if (followingMatch) {
        const num = parseFloat(followingMatch[1]);
        const unit = followingMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.following = { count: Math.round(count), display: followingMatch[0].trim() };
        }
      }
      
      // 提取获赞数（likes）
      const likesMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:likes?|获赞)/i);
      if (likesMatch) {
        const num = parseFloat(likesMatch[1]);
        const unit = likesMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.totalLikes = { count: Math.round(count), display: likesMatch[0].trim() };
        }
      }
      
      // 提取认证状态（verified badge）
      const verifiedPatterns = [
        /verified/i,
        /认证/i,
        /verified account/i,
        /checkmark/i,
        /✓/,
        /data-e2e=["']verified["']/i,
      ];
      
      for (const pattern of verifiedPatterns) {
        if (pattern.test(context)) {
          user.verified = true;
          break;
        }
      }
      
      // 提取头像（缩短 URL）
      const avatarMatches = context.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi);
      for (const avatarMatch of avatarMatches) {
        const imgSrc = avatarMatch[1];
        if (imgSrc && (imgSrc.includes('avatar') || imgSrc.includes('avt-') || imgSrc.includes('user') || 
            imgSrc.includes('profile') || imgSrc.includes('head'))) {
          user.avatarUrl = shortenCoverUrl(imgSrc);
          break;
        }
      }
      
      // 提取用户简介（bio）
      const bioPatterns = [
        /bio[:\s]+([^@#\n]{5,200})/i,
        /简介[:\s]+([^@#\n]{5,200})/i,
        /description[:\s]+([^@#\n]{5,200})/i,
      ];
      
      for (const pattern of bioPatterns) {
        const bioMatch = contextText.match(pattern);
        if (bioMatch && bioMatch[1]) {
          const bio = bioMatch[1].trim();
          if (bio.length >= 5 && bio.length <= 200 && !bio.match(/^\d+$/)) {
            user.bio = bio;
            break;
          }
        }
      }
    }
  });

  // 6. 构建精简的 Markdown（紧凑格式）
  let md = '';

  // 视频列表（仅输出 HTML 中实际存在的数据，不臆造）
  if (extractedData.videos.length > 0) {
    md += `# 视频列表 (${extractedData.videos.length}个)\n`;
    md += `注：搜索页仅展示点赞数，无播放量/评论/收藏\n\n`;
    extractedData.videos.forEach((video, idx) => {
      md += `## ${idx + 1}. 视频 ${video.videoId}\n`;
      md += `- URL: ${video.videoUrl}\n`;
      if (video.username) md += `- 作者: @${video.username}\n`;
      if (video.caption) {
        md += `- 文案: ${video.caption.substring(0, 200)}${video.caption.length > 200 ? '...' : ''}\n`;
      } else if (video.description) {
        md += `- 描述: ${video.description.substring(0, 200)}${video.description.length > 200 ? '...' : ''}\n`;
      }
      if (video.postedTime) md += `- 发布时间: ${video.postedTime}\n`;
      if (video.likes) md += `- 点赞: ${video.likes.display}\n`;
      if (video.hashtags && video.hashtags.length > 0) md += `- 标签: ${video.hashtags.join(' ')}\n`;
      if (video.mentions && video.mentions.length > 0) md += `- @提及: ${video.mentions.join(' ')}\n`;
      if (video.creator) md += `- 创作者: ${video.creator}\n`;
      if (video.music) md += `- 音乐: ${video.music.substring(0, 80)}${video.music.length > 80 ? '...' : ''}\n`;
      if (video.thumbnail) md += `- 封面: ${shortenCoverUrl(video.thumbnail)}\n`;
      md += '\n';
    });
  }

  // 用户列表（红人列表，含显示名、粉丝、认证状态等）
  if (extractedData.users.length > 0) {
    md += `# 用户列表 (${extractedData.users.length}个)\n\n`;
    extractedData.users.forEach((user, idx) => {
      md += `## ${idx + 1}. @${user.username}`;
      if (user.verified) {
        md += ` ✓`; // 认证标记
      }
      md += `\n`;
      md += `- 主页: ${user.profileUrl}\n`;
      // 仅在有有效显示名时输出（过滤 CSS 类名、HTML 属性值等）
      if (user.displayName && isValidDisplayName(user.displayName) && user.displayName !== user.username) {
        md += `- 显示名: ${user.displayName}\n`;
      }
      if (user.bio) {
        md += `- 简介: ${user.bio.substring(0, 150)}${user.bio.length > 150 ? '...' : ''}\n`;
      }
      if (user.followers) {
        md += `- 粉丝: ${user.followers.display} (${user.followers.count.toLocaleString()})\n`;
      }
      if (user.following) {
        md += `- 关注: ${user.following.display} (${user.following.count.toLocaleString()})\n`;
      }
      if (user.totalLikes) {
        md += `- 获赞: ${user.totalLikes.display} (${user.totalLikes.count.toLocaleString()})\n`;
      }
      if (user.avatarUrl) {
        md += `- 头像: ${shortenCoverUrl(user.avatarUrl)}\n`;
      }
      md += '\n';
    });
  }

  // 如果提取到的视频数量较少，回退到原始方法（但更精简）
  if (extractedData.videos.length < 10) {
    console.warn('[Markdown转换] 智能提取的视频数量较少，使用备用方法...');
    
    // 备用方法：提取包含 /video/ 的链接及其上下文
    let backupMd = html;
    
    // 移除所有 script/style
    backupMd = backupMd.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    backupMd = backupMd.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    
    // 只保留包含视频链接的部分
    const videoSections = [];
    const videoLinkMatches = html.matchAll(/<a[^>]*href=["'][^"']*\/video\/\d+[^"']*["'][^>]*>[\s\S]*?<\/a>/gi);
    
    for (const linkMatch of videoLinkMatches) {
      const linkHtml = linkMatch[0];
      // 提取链接和文本
      const hrefMatch = linkHtml.match(/href=["']([^"']+)["']/);
      const textMatch = linkHtml.match(/>([\s\S]*?)<\/a>/);
      
      if (hrefMatch) {
        const href = hrefMatch[1];
        const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        videoSections.push(`- [${text || '视频'}](${href})`);
      }
    }
    
    if (videoSections.length > 0) {
      md = '# 视频链接\n\n' + videoSections.join('\n') + '\n\n';
    }
  }

  return md.trim() || '未提取到视频信息';
}

/**
 * 使用 AI Agent 提取所有视频和红人信息（一次调用）
 * @param {Object} page - Playwright Page 对象
 * @returns {Promise<Object>} - { videos: Array, influencers: Array, stats: Object }
 */
async function extractVideosAndInfluencersWithAI(page) {
  console.log('[AI提取] [方案B] 开始使用 AI Agent 提取视频和红人信息（不依赖 CSS 选择器）...');
  const startTime = Date.now();
  
  // 1. 等待页面加载并滚动以触发懒加载，直到获取到至少50个视频
  console.log('[AI提取] 等待页面加载...');
  await page.waitForTimeout(3000);
  
  // 2. 滚动页面以加载更多内容，直到获取到至少50个视频
  console.log('[AI提取] 滚动页面以加载至少50个视频（模拟人类行为，降低被检测风险）...');
  const targetVideoCount = 50;
  let currentVideoCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 30; // 最多滚动30次，防止无限循环
  
  // 随机延迟函数：模拟人类的不规律行为
  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  // 滚动函数：使用平滑滚动和随机行为，模拟人类操作
  async function performScroll() {
    // 随机选择滚动方式（70% 使用鼠标滚轮，30% 使用键盘）
    const useMouseWheel = Math.random() > 0.3;
    
    if (useMouseWheel) {
      // 方法1: 鼠标滚轮滚动（最像人类操作）
      // 随机移动鼠标位置（模拟用户鼠标位置变化）
      const mouseX = randomDelay(300, 700);
      const mouseY = randomDelay(300, 600);
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(randomDelay(100, 300)); // 小停顿
      
      // 随机滚动距离（不完全滚动一屏，更像人类）
      const scrollDistance = randomDelay(400, 800);
      await page.mouse.wheel(0, scrollDistance);
      
      // 偶尔添加第二次小滚动（模拟用户调整位置）
      if (Math.random() > 0.7) {
        await page.waitForTimeout(randomDelay(200, 500));
        await page.mouse.wheel(0, randomDelay(100, 300));
      }
    } else {
      // 方法2: 键盘 PageDown（偶尔使用）
      await page.keyboard.press('PageDown');
    }
    
    // 方法3: 同时更新容器滚动位置（确保内容加载）
    const scrolled = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="search-result-list"]',
        '[data-e2e="search_video-item-list"]',
        '[class*="SearchResult"]',
        '[class*="search-result"]',
        'main',
        '[role="main"]',
        '.css-1qb12g8-DivContentContainer',
        '[class*="DivContentContainer"]',
        '[class*="ItemContainer"]'
      ];
      
      // 随机滚动距离（不完全一屏）
      const scrollAmount = Math.floor(window.innerHeight * (0.7 + Math.random() * 0.3));
      
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.scrollHeight > el.clientHeight) {
            el.scrollTop += scrollAmount;
            return { method: 'container', selector: sel };
          }
        } catch (e) {}
      }
      
      // 备用：滚动 window
      const before = window.scrollY;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      if (window.scrollY !== before) {
        return { method: 'window' };
      }
      
      document.documentElement.scrollTop += scrollAmount;
      return { method: 'documentElement' };
    });
    
    return scrolled;
  }
  
  while (currentVideoCount < targetVideoCount && scrollAttempts < maxScrollAttempts) {
    // 执行滚动（模拟人类行为）
    const scrollResult = await performScroll();
    if (scrollAttempts === 0) {
      console.log(`[AI提取] 使用的滚动方式: ${scrollResult?.method || 'mouse'}${scrollResult?.selector ? ` (${scrollResult.selector})` : ''}`);
    }
    
    // 随机等待时间（2-4秒），模拟人类阅读和浏览时间
    const waitTime = randomDelay(2000, 4000);
    await page.waitForTimeout(waitTime);
    
    // 偶尔添加额外停顿（10% 概率，模拟用户被内容吸引）
    if (Math.random() > 0.9) {
      const extraWait = randomDelay(1000, 3000);
      console.log(`[AI提取] 模拟用户浏览停顿 ${extraWait}ms...`);
      await page.waitForTimeout(extraWait);
    }
    
    // 检查当前页面上的视频数量
    currentVideoCount = await page.evaluate(() => {
      const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const uniqueVideoIds = new Set();
      videoLinks.forEach(link => {
        const href = link.getAttribute('href');
        const match = href.match(/\/video\/(\d+)/);
        if (match) {
          uniqueVideoIds.add(match[1]);
        }
      });
      return uniqueVideoIds.size;
    });
    
    scrollAttempts++;
    console.log(`[AI提取] 滚动第 ${scrollAttempts} 次，当前视频数量: ${currentVideoCount}`);
    
    // 如果视频数量没有增加，可能已经到底了
    if (scrollAttempts > 5 && currentVideoCount === 0) {
      console.warn('[AI提取] ⚠️ 未检测到视频，可能页面结构已变化');
      break;
    }
    
    // 如果连续多次滚动视频数不变，可能已到底
    if (scrollAttempts > 10 && scrollAttempts % 5 === 1) {
      const prevCount = currentVideoCount;
      await page.waitForTimeout(1000);
      const afterCount = await page.evaluate(() => {
        const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
        const uniqueVideoIds = new Set();
        videoLinks.forEach(link => {
          const href = link.getAttribute('href');
          const match = href.match(/\/video\/(\d+)/);
          if (match) uniqueVideoIds.add(match[1]);
        });
        return uniqueVideoIds.size;
      });
      if (afterCount === prevCount && prevCount > 0) {
        console.log(`[AI提取] 视频数量稳定在 ${prevCount}，可能已加载完毕`);
        if (scrollAttempts > 15) break;
      }
    }
  }
  
  console.log(`[AI提取] ✅ 滚动完成，共找到 ${currentVideoCount} 个视频`);
  
  // 3. 等待内容稳定
  await page.waitForTimeout(3000);
  
  // 4. 方案B：直接提取整个页面 HTML（不依赖 CSS 选择器和 DOM 结构识别）
  console.log('[AI提取] [方案B] 提取整个页面 HTML（不依赖选择器）...');
  
  const rawHTML = await page.content();
  const rawHTMLLength = rawHTML.length;
  console.log(`[AI提取] 原始 HTML 长度: ${rawHTMLLength.toLocaleString()} 字符`);
  
  // 5. 优化 HTML（减少大小，移除脚本、样式等）
  console.log('[AI提取] 优化 HTML（移除脚本、样式等无关内容）...');
  const optimizedHTML = optimizeHTML(rawHTML);
  const optimizedHTMLLength = optimizedHTML.length;
  console.log(`[AI提取] 优化后 HTML 长度: ${optimizedHTMLLength.toLocaleString()} 字符`);
  console.log(`[AI提取] HTML 减少: ${((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1)}%`);
  
  // 6. 获取优化建议
  const videoCount = (optimizedHTML.match(/\/video\//g) || []).length;
  const optimizationInfo = getOptimizationSuggestions(optimizedHTMLLength, videoCount);
  
  console.log(`[AI提取] 检测到约 ${videoCount} 个视频链接`);
  if (optimizationInfo.suggestions.length > 0) {
    console.log('[AI提取] 优化建议:');
    optimizationInfo.suggestions.forEach((suggestion, index) => {
      console.log(`  ${index + 1}. [${suggestion.level.toUpperCase()}] ${suggestion.message}`);
      if (suggestion.actions) {
        suggestion.actions.forEach(action => console.log(`     ${action}`));
      } else if (suggestion.action) {
        console.log(`     ${suggestion.action}`);
      }
    });
  }

  // 7.1 将 HTML 转换为精简 Markdown，进一步减少 Token 并提高可读性
  console.log('[AI提取] [方案B] 将页面 HTML 转为精简 Markdown...');
  const markdownContent = htmlToCompactMarkdown(optimizedHTML);
  const markdownLength = markdownContent.length;
  console.log(`[AI提取] Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Markdown Token 数: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
  
  // 保存精简 Markdown 到日志（供检查）
  const logsDir = path.join(__dirname, '../logs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const markdownLogPath = path.join(logsDir, `markdown-input-${timestamp}.md`);
    fs.writeFileSync(markdownLogPath, markdownContent, 'utf-8');
    console.log(`[AI提取] 精简 Markdown 已保存到: ${markdownLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 Markdown 日志失败:', e.message);
  }
  
  // ========== 测试模式：只测试 Markdown 转换，跳过 LLM 调用 ==========
  const TEST_MARKDOWN_ONLY = true; // 设置为 true 只测试 Markdown，false 继续调用 LLM
  
  if (TEST_MARKDOWN_ONLY) {
    console.log('');
    console.log('='.repeat(80));
    console.log('🧪 测试模式：只测试 Markdown 转换效果');
    console.log('='.repeat(80));
    console.log('');
    console.log('Markdown 内容预览（前2000字符）：');
    console.log('-'.repeat(80));
    console.log(markdownContent.substring(0, 2000));
    console.log('-'.repeat(80));
    console.log('');
    console.log(`✅ Markdown 转换完成！`);
    console.log(`📊 统计信息：`);
    console.log(`   - 视频数量: ${(markdownContent.match(/## \d+\. 视频/g) || []).length}`);
    console.log(`   - 用户数量: ${(markdownContent.match(/## \d+\. @/g) || []).length}`);
    console.log(`   - Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
    console.log(`   - 估算 Token: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
    console.log('');
    console.log('💡 提示：检查 logs/markdown-input-*.md 文件查看完整 Markdown');
    console.log('');
    
    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);
    
    return {
      videos: [],
      influencers: [],
      markdown: markdownContent,
      stats: {
        totalTime: totalTime,
        llmTime: '0',
        htmlLength: {
          original: rawHTMLLength,
          optimized: optimizedHTMLLength,
          reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
        },
        tokenEstimate: {
          original: Math.ceil(rawHTMLLength / 4),
          optimized: Math.ceil(optimizedHTMLLength / 4),
          prompt: Math.ceil(markdownLength / 4),
          markdown: Math.ceil(markdownLength / 4)
        },
        videoCount: (markdownContent.match(/## \d+\. 视频/g) || []).length,
        influencerCount: (markdownContent.match(/## \d+\. @/g) || []).length,
        optimizationSuggestions: optimizationInfo.suggestions
      }
    };
  }
  
  // ========== 正常模式：继续调用 LLM ==========
  
  // 8. 构建 LLM Prompt（基于精简 Markdown，方案B）
  console.log('[AI提取] [方案B] 构建 LLM Prompt（让 LLM 自己识别视频）...');
  const prompt = `你是一个专业的社交媒体数据分析专家。请分析下面这个 TikTok 搜索结果页面的完整内容（Markdown 格式），**自己识别并提取**所有视频和对应的红人（创作者）信息。

**方案B说明**：
- 我们直接提供了整个页面的精简 Markdown 内容
- 你需要自己识别哪些是视频卡片，哪些是视频信息，哪些是红人信息
- 不依赖特定的 HTML 结构或 CSS 选择器
- 通过内容语义来识别（如视频链接、用户名链接、播放量、点赞数等）

下面是已经提取并转换好的**精简版 Markdown 内容**（只包含与视频和红人相关的信息，不包含样式、脚本等）：

${markdownContent.substring(0, 200000)}  // 限制长度避免超过 token 限制

请**自己识别并提取**以下信息：

**视频信息**（每个视频）：
1. videoId: 视频ID（从链接中提取，格式如 /video/1234567890）
2. videoUrl: 视频完整链接（如 https://www.tiktok.com/@username/video/1234567890）
3. username: 作者用户名（从链接中提取，格式如 /@username，只返回 username 部分，不要包含 @ 符号）
4. profileUrl: 作者主页链接（如 https://www.tiktok.com/@username）
5. views: 播放量（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，如 { count: 1200000, display: "1.2M" }）
6. likes: 点赞数（如果有显示，格式同上）
7. thumbnail: 视频封面图片 URL

**红人信息**（每个红人，去重）：
1. username: 用户名（从链接中提取）
2. displayName: 显示名称（创作者的名字）
3. profileUrl: 个人主页链接
4. avatarUrl: 头像图片 URL
5. followers: 粉丝数（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，否则为 null）
6. bio: 个人简介（如果有）
7. verified: 是否认证（true/false）

**重要提示**：
- 提取页面中所有视频，有多少条就提取多少条（20条就20条，50条就50条）
- 用户名必须从链接中提取，格式为 /@username，只返回 username 部分
- 所有字段如果找不到，返回 null 或空字符串
- 播放量、点赞数、粉丝数需要解析（如 "1.2M" → { count: 1200000, display: "1.2M" }）
- 红人信息需要去重（相同用户名只保留一个）
- 只返回 JSON 格式，不要其他文字说明

请返回 JSON 格式：
{
  "videos": [
    {
      "videoId": "视频ID或null",
      "videoUrl": "完整URL或null",
      "username": "用户名或null",
      "profileUrl": "主页URL或null",
      "views": { "count": 数字或0, "display": "显示文本或'0'" },
      "likes": { "count": 数字或0, "display": "显示文本或'0'" },
      "thumbnail": "图片URL或null"
    },
    ...
  ],
  "influencers": [
    {
      "username": "用户名或null",
      "displayName": "显示名称或null",
      "profileUrl": "主页URL或null",
      "avatarUrl": "头像URL或null",
      "followers": { "count": 数字或null, "display": "显示文本或null" },
      "bio": "简介或null",
      "verified": true或false,
      "platform": "TikTok"
    },
    ...
  ]
}`;

  const promptLength = prompt.length;
  console.log(`[AI提取] Prompt 长度: ${promptLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Token 数: ${Math.ceil(promptLength / 4).toLocaleString()}`);
  
  // 9. 调用 LLM（DeepSeek API 最大支持 8192 tokens）
  console.log('[AI提取] 调用 LLM API（max_tokens=8192）...');
  const llmStartTime = Date.now();
  const llmResult = await callDeepSeekLLM(
    [{ role: "user", content: prompt }],
    "你是一个专业的社交媒体数据分析专家，擅长从网页 HTML 中提取结构化信息。只返回 JSON 格式，不要其他文字。",
    { maxTokens: 8192, returnFullResponse: true }
  );
  const llmEndTime = Date.now();
  const llmResponse = llmResult.content;
  const finishReason = llmResult.finishReason;
  const usage = llmResult.usage || {};
  
  console.log(`[AI提取] LLM 调用耗时: ${((llmEndTime - llmStartTime) / 1000).toFixed(2)} 秒`);
  console.log(`[AI提取] LLM 响应长度: ${llmResponse.length.toLocaleString()} 字符`);
  console.log(`[AI提取] finish_reason: ${finishReason}（length=输出被 token 限制截断）`);
  console.log(`[AI提取] Token 使用: 输入=${usage.prompt_tokens || '未知'}, 输出=${usage.completion_tokens || '未知'}`);
  console.log(`[AI提取] LLM 响应预览: ${llmResponse.substring(0, 300)}...`);
  
  if (finishReason === 'length') {
    console.warn('[AI提取] ⚠️ 输出被 token 限制截断！请增加 max_tokens 或减少视频数量');
  }
  
  // 10. 保存原始 LLM 响应到日志（供检查）
  const responseLogPath = path.join(logsDir, `llm-response-raw-${timestamp}.json`);
  try {
    fs.writeFileSync(responseLogPath, llmResponse, 'utf-8');
    console.log(`[AI提取] LLM 原始响应已保存到: ${responseLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 LLM 响应失败:', e.message);
  }
  
  // 10. 解析 JSON 响应（改进的解析逻辑）
  console.log('[AI提取] 解析 LLM 响应...');
  let extractedData;
  let parseError = null;
  
  try {
    // 尝试1: 直接解析
    extractedData = JSON.parse(llmResponse);
    console.log('[AI提取] ✅ 直接解析成功');
  } catch (e) {
    parseError = e;
    console.warn('[AI提取] 直接解析失败:', e.message);
    
    try {
      // 尝试2: 移除 markdown 代码块标记
      let cleanedResponse = llmResponse;
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '');
      cleanedResponse = cleanedResponse.replace(/```\s*/g, '');
      cleanedResponse = cleanedResponse.trim();
      
      extractedData = JSON.parse(cleanedResponse);
      console.log('[AI提取] ✅ 移除 markdown 标记后解析成功');
    } catch (e2) {
      console.warn('[AI提取] 移除 markdown 标记后仍失败:', e2.message);
      
      try {
        // 尝试3: 提取 JSON 对象（使用更宽松的正则）
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          let jsonStr = jsonMatch[0];
          
          // 尝试修复常见的 JSON 错误
          // 修复末尾多余的逗号
          jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
          // 修复单引号
          jsonStr = jsonStr.replace(/'/g, '"');
          
          extractedData = JSON.parse(jsonStr);
          console.log('[AI提取] ✅ 提取并修复后解析成功');
        } else {
          throw new Error('无法从响应中提取 JSON 对象');
        }
      } catch (e3) {
        console.warn('[AI提取] ⚠️ 标准解析失败，尝试修复截断的 JSON...');
        
        try {
          // 尝试4: 修复被截断的 JSON（更智能的方法）
          let jsonStr = llmResponse;
          // 移除 markdown 代码块标记
          jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          
          // 策略：从后往前查找，找到最后一个完整的对象
          // 先找到所有完整的 videoId 对象
          const videoIdPattern = /"videoId"\s*:\s*"(\d+)"/g;
          const videoIds = [];
          let match;
          while ((match = videoIdPattern.exec(jsonStr)) !== null) {
            videoIds.push({ id: match[1], index: match.index });
          }
          
          if (videoIds.length === 0) {
            throw new Error('未找到任何视频ID');
          }
          
          // 从最后一个videoId开始，向前查找完整的对象
          let lastValidIndex = jsonStr.length;
          
          // 从后往前查找，找到最后一个完整的对象结束位置
          for (let i = videoIds.length - 1; i >= 0; i--) {
            const videoId = videoIds[i];
            const startIndex = videoId.index;
            
            // 向前查找这个对象的开始（找到最近的 {）
            let objStart = startIndex;
            let braceCount = 0;
            let foundStart = false;
            
            // 向前查找对象开始
            for (let j = startIndex; j >= 0; j--) {
              if (jsonStr[j] === '}') braceCount++;
              else if (jsonStr[j] === '{') {
                braceCount--;
                if (braceCount === 0) {
                  objStart = j;
                  foundStart = true;
                  break;
                }
              }
            }
            
            if (!foundStart) continue;
            
            // 向后查找这个对象的结束
            let objEnd = -1;
            braceCount = 0;
            let inString = false;
            let escapeNext = false;
            
            for (let j = objStart; j < jsonStr.length; j++) {
              const char = jsonStr[j];
              
              if (escapeNext) {
                escapeNext = false;
                continue;
              }
              
              if (char === '\\') {
                escapeNext = true;
                continue;
              }
              
              if (char === '"') {
                inString = !inString;
                continue;
              }
              
              if (inString) continue;
              
              if (char === '{') braceCount++;
              else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  objEnd = j + 1;
                  break;
                }
              }
            }
            
            if (objEnd > 0 && objEnd <= jsonStr.length) {
              // 验证这个对象是否完整（检查是否在字符串中间被截断）
              const objContent = jsonStr.substring(objStart, objEnd);
              
              // 检查对象是否包含未闭合的字符串
              let stringCount = 0;
              let isValid = true;
              for (let j = 0; j < objContent.length; j++) {
                if (objContent[j] === '\\') {
                  j++; // 跳过转义字符
                  continue;
                }
                if (objContent[j] === '"') {
                  stringCount++;
                }
              }
              
              // 如果字符串引号数量是偶数，说明字符串都闭合了
              if (stringCount % 2 === 0) {
                lastValidIndex = objEnd;
                break;
              }
            }
          }
          
          // 提取到最后一个完整对象为止的JSON
          let fixedJson = jsonStr.substring(0, lastValidIndex);
          
          // 移除最后一个对象后的逗号（如果有）
          fixedJson = fixedJson.replace(/,\s*$/, '');
          
          // 找到videos数组的开始位置
          const videosArrayStart = fixedJson.indexOf('"videos"');
          if (videosArrayStart > 0) {
            const arrayStart = fixedJson.indexOf('[', videosArrayStart);
            if (arrayStart > 0) {
              // 计算需要闭合的括号（只计算数组内的）
              const arrayContent = fixedJson.substring(arrayStart);
              const openBraces = (arrayContent.match(/\{/g) || []).length;
              const closeBraces = (arrayContent.match(/\}/g) || []).length;
              const openBrackets = (arrayContent.match(/\[/g) || []).length;
              const closeBrackets = (arrayContent.match(/\]/g) || []).length;
              
              // 添加缺失的闭合括号
              if (closeBraces < openBraces) {
                fixedJson += '}'.repeat(openBraces - closeBraces);
              }
              if (closeBrackets < openBrackets) {
                fixedJson += ']'.repeat(openBrackets - closeBrackets);
              }
              
              // 确保videos数组正确闭合
              if (!fixedJson.endsWith(']')) {
                fixedJson += ']';
              }
            }
          }
          
          // 确保根对象正确闭合
          const rootOpenBraces = (fixedJson.match(/\{/g) || []).length;
          const rootCloseBraces = (fixedJson.match(/\}/g) || []).length;
          if (rootCloseBraces < rootOpenBraces) {
            fixedJson += '}'.repeat(rootOpenBraces - rootCloseBraces);
          }
          
          // 修复常见的 JSON 错误
          fixedJson = fixedJson.replace(/,(\s*[}\]])/g, '$1'); // 移除末尾多余的逗号
          fixedJson = fixedJson.replace(/'/g, '"'); // 修复单引号
          
          // 确保JSON结构完整
          if (!fixedJson.trim().startsWith('{')) {
            const firstBrace = fixedJson.indexOf('{');
            if (firstBrace > 0) {
              fixedJson = fixedJson.substring(firstBrace);
            }
          }
          
          extractedData = JSON.parse(fixedJson);
          console.log('[AI提取] ✅ 修复截断 JSON 后解析成功');
          console.log(`[AI提取] ⚠️ 注意：JSON 可能被截断，只提取了前 ${extractedData.videos?.length || 0} 个视频`);
        } catch (e4) {
          console.error('[AI提取] ❌ 所有解析尝试都失败（包括修复截断 JSON）');
          console.error('[AI提取] 错误详情:', e4.message);
          console.error('[AI提取] 响应位置:', e4.message.match(/position (\d+)/)?.[1] || '未知');
          
          // 输出响应的一部分以便调试
          const errorPos = parseInt(e4.message.match(/position (\d+)/)?.[1] || '0');
          if (errorPos > 0) {
            const start = Math.max(0, errorPos - 200);
            const end = Math.min(llmResponse.length, errorPos + 200);
            console.error('[AI提取] 错误位置附近的响应内容:');
            console.error('='.repeat(80));
            console.error(llmResponse.substring(start, end));
            console.error('='.repeat(80));
          }
          
          throw new Error(`JSON 解析失败: ${e4.message}`);
        }
      }
    }
  }
  
  // 11. 输出原始提取数据并保存到日志（供检查）
  console.log('');
  console.log('='.repeat(80));
  console.log('LLM 原始提取数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(extractedData, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  try {
    const extractedLogPath = path.join(logsDir, `extracted-data-raw-${timestamp}.json`);
    fs.writeFileSync(extractedLogPath, JSON.stringify(extractedData, null, 2), 'utf-8');
    console.log(`[AI提取] 原始提取数据已保存到: ${extractedLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存原始提取数据失败:', e.message);
  }
  
  // 12. 验证和清理数据
  const videos = Array.isArray(extractedData.videos) ? extractedData.videos : [];
  const influencers = Array.isArray(extractedData.influencers) ? extractedData.influencers : [];
  
  // 清理和验证视频数据
  const cleanedVideos = videos.map(video => ({
    videoId: video.videoId || null,
    videoUrl: video.videoUrl || null,
    username: video.username || null,
    profileUrl: video.profileUrl || (video.username ? `https://www.tiktok.com/@${video.username}` : null),
    views: video.views || { count: 0, display: '0' },
    likes: video.likes || { count: 0, display: '0' },
    thumbnail: video.thumbnail || null
  }));
  
  // 清理和验证红人数据（去重）
  const seenUsernames = new Set();
  const cleanedInfluencers = influencers
    .filter(inf => inf.username && !seenUsernames.has(inf.username))
    .map(inf => {
      seenUsernames.add(inf.username);
      return {
        username: inf.username,
        displayName: inf.displayName || inf.username,
        profileUrl: inf.profileUrl || `https://www.tiktok.com/@${inf.username}`,
        avatarUrl: inf.avatarUrl || null,
        followers: inf.followers || null,
        bio: inf.bio || null,
        verified: inf.verified || false,
        platform: 'TikTok'
      };
    });
  
  const endTime = Date.now();
  const totalTime = ((endTime - startTime) / 1000).toFixed(2);
  
  console.log(`[AI提取] ✅ 提取完成！`);
  console.log(`[AI提取] 总耗时: ${totalTime} 秒`);
  console.log(`[AI提取] 提取到 ${cleanedVideos.length} 个视频`);
  console.log(`[AI提取] 提取到 ${cleanedInfluencers.length} 个红人`);
  
  // 14. 检测是否需要更新规则（去重后的用户名数量 < 10）
  const extractionResult = {
    videos: cleanedVideos,
    users: cleanedInfluencers
  };
  
  // 14.1 检测是否需要更新规则（去重后的用户名数量 < 10）
  const shouldUpdate = shouldTriggerRuleUpdate(extractionResult, 50);
  
  if (shouldUpdate) {
    console.log('[规则更新] ⚠️ 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    try {
      // 获取 HTML（用于 LLM 学习）
      const html = await page.content();
      const optimizedHTML = optimizeHTML(html);
      
      // 调用规则更新（最多重试 3 次）
      const updateResult = await updateRulesWithRetry(
        optimizedHTML, 
        extractionResult, 
        50,
        extractWithRules  // 规则引擎函数
      );
      
      if (updateResult.success) {
        console.log('[规则更新] ✅ 规则更新成功，版本:', updateResult.rules.version);
        console.log('[规则更新] 指标:', updateResult.metrics);
        
        // 可选：用新规则重新提取一次（如果需要）
        // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
        // console.log('[规则更新] 新规则提取结果:', newResult.videos.length, '个视频,', newResult.users.length, '个用户');
      } else {
        console.log('[规则更新] ⚠️ 规则更新失败（' + updateResult.attempts + ' 次尝试均失败），继续使用旧规则');
        console.log('[规则更新] 最后失败原因:', updateResult.lastError);
      }
    } catch (e) {
      console.error('[规则更新] ❌ 规则更新过程出错:', e.message);
      console.error('[规则更新] 错误堆栈:', e.stack);
    }
  }
  
  // 13. 输出清理后的完整数据（用于测试）
  console.log('');
  console.log('='.repeat(80));
  console.log('清理后的视频数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedVideos, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  console.log('='.repeat(80));
  console.log('清理后的红人数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedInfluencers, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  // 13.1 保存最终视频和红人数据到日志（供检查）
  try {
    const finalData = { videos: cleanedVideos, influencers: cleanedInfluencers };
    const finalLogPath = path.join(logsDir, `extracted-data-final-${timestamp}.json`);
    fs.writeFileSync(finalLogPath, JSON.stringify(finalData, null, 2), 'utf-8');
    console.log(`[AI提取] 最终视频和红人数据已保存到: ${finalLogPath}`);
    
    // 保存截断说明日志
    const summaryPath = path.join(logsDir, `extraction-summary-${timestamp}.txt`);
    const summary = [
      `=== TikTok 数据提取日志 ${timestamp} ===`,
      '',
      '【截断原因说明】',
      `finish_reason: ${finishReason}`,
      '- stop: 正常完成，未截断',
      '- length: 输出达到 max_tokens 限制被截断（API 默认或设置的输出 token 上限）',
      '- content_filter: 内容被过滤',
      '',
      '【Token 使用】',
      `输入 tokens: ${usage.prompt_tokens || '未知'}`,
      `输出 tokens: ${usage.completion_tokens || '未知'}`,
      '',
      '【数据统计】',
      `视频数量: ${cleanedVideos.length}`,
      `红人数量: ${cleanedInfluencers.length}`,
      `Markdown 长度: ${markdownLength} 字符`,
      `LLM 响应长度: ${llmResponse.length} 字符`,
      '',
      '【日志文件】',
      `- 精简 Markdown 输入: markdown-input-${timestamp}.md`,
      `- LLM 原始 JSON 响应: llm-response-raw-${timestamp}.json`,
      `- 解析后原始数据: extracted-data-raw-${timestamp}.json`,
      `- 最终清理数据: extracted-data-final-${timestamp}.json`
    ].join('\n');
    fs.writeFileSync(summaryPath, summary, 'utf-8');
    console.log(`[AI提取] 提取摘要已保存到: ${summaryPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存最终数据失败:', e.message);
  }
  
  // 14. 返回结果和统计信息
  return {
    videos: cleanedVideos,
    influencers: cleanedInfluencers,
    stats: {
      totalTime: totalTime,
      llmTime: ((llmEndTime - llmStartTime) / 1000).toFixed(2),
      htmlLength: {
        original: rawHTMLLength,
        optimized: optimizedHTMLLength,
        reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
      },
      tokenEstimate: {
        original: Math.ceil(rawHTMLLength / 4),
        optimized: Math.ceil(optimizedHTMLLength / 4),
        prompt: Math.ceil(promptLength / 4)
      },
      videoCount: cleanedVideos.length,
      influencerCount: cleanedInfluencers.length,
      optimizationSuggestions: optimizationInfo.suggestions
    }
  };
}

/**
 * 等待用户按 Enter 键
 */
function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

// 运行主函数
main().catch(console.error);
      // 提取关注数（following）
      const followingMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:following|关注)/i);
      if (followingMatch) {
        const num = parseFloat(followingMatch[1]);
        const unit = followingMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.following = { count: Math.round(count), display: followingMatch[0].trim() };
        }
      }
      
      // 提取获赞数（likes）
      const likesMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:likes?|获赞)/i);
      if (likesMatch) {
        const num = parseFloat(likesMatch[1]);
        const unit = likesMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.totalLikes = { count: Math.round(count), display: likesMatch[0].trim() };
        }
      }
      
      // 提取认证状态（verified badge）
      const verifiedPatterns = [
        /verified/i,
        /认证/i,
        /verified account/i,
        /checkmark/i,
        /✓/,
        /data-e2e=["']verified["']/i,
      ];
      
      for (const pattern of verifiedPatterns) {
        if (pattern.test(context)) {
          user.verified = true;
          break;
        }
      }
      
      // 提取头像（缩短 URL）
      const avatarMatches = context.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi);
      for (const avatarMatch of avatarMatches) {
        const imgSrc = avatarMatch[1];
        if (imgSrc && (imgSrc.includes('avatar') || imgSrc.includes('avt-') || imgSrc.includes('user') || 
            imgSrc.includes('profile') || imgSrc.includes('head'))) {
          user.avatarUrl = shortenCoverUrl(imgSrc);
          break;
        }
      }
      
      // 提取用户简介（bio）
      const bioPatterns = [
        /bio[:\s]+([^@#\n]{5,200})/i,
        /简介[:\s]+([^@#\n]{5,200})/i,
        /description[:\s]+([^@#\n]{5,200})/i,
      ];
      
      for (const pattern of bioPatterns) {
        const bioMatch = contextText.match(pattern);
        if (bioMatch && bioMatch[1]) {
          const bio = bioMatch[1].trim();
          if (bio.length >= 5 && bio.length <= 200 && !bio.match(/^\d+$/)) {
            user.bio = bio;
            break;
          }
        }
      }
    }
  });

  // 6. 构建精简的 Markdown（紧凑格式）
  let md = '';

  // 视频列表（仅输出 HTML 中实际存在的数据，不臆造）
  if (extractedData.videos.length > 0) {
    md += `# 视频列表 (${extractedData.videos.length}个)\n`;
    md += `注：搜索页仅展示点赞数，无播放量/评论/收藏\n\n`;
    extractedData.videos.forEach((video, idx) => {
      md += `## ${idx + 1}. 视频 ${video.videoId}\n`;
      md += `- URL: ${video.videoUrl}\n`;
      if (video.username) md += `- 作者: @${video.username}\n`;
      if (video.caption) {
        md += `- 文案: ${video.caption.substring(0, 200)}${video.caption.length > 200 ? '...' : ''}\n`;
      } else if (video.description) {
        md += `- 描述: ${video.description.substring(0, 200)}${video.description.length > 200 ? '...' : ''}\n`;
      }
      if (video.postedTime) md += `- 发布时间: ${video.postedTime}\n`;
      if (video.likes) md += `- 点赞: ${video.likes.display}\n`;
      if (video.hashtags && video.hashtags.length > 0) md += `- 标签: ${video.hashtags.join(' ')}\n`;
      if (video.mentions && video.mentions.length > 0) md += `- @提及: ${video.mentions.join(' ')}\n`;
      if (video.creator) md += `- 创作者: ${video.creator}\n`;
      if (video.music) md += `- 音乐: ${video.music.substring(0, 80)}${video.music.length > 80 ? '...' : ''}\n`;
      if (video.thumbnail) md += `- 封面: ${shortenCoverUrl(video.thumbnail)}\n`;
      md += '\n';
    });
  }

  // 用户列表（红人列表，含显示名、粉丝、认证状态等）
  if (extractedData.users.length > 0) {
    md += `# 用户列表 (${extractedData.users.length}个)\n\n`;
    extractedData.users.forEach((user, idx) => {
      md += `## ${idx + 1}. @${user.username}`;
      if (user.verified) {
        md += ` ✓`; // 认证标记
      }
      md += `\n`;
      md += `- 主页: ${user.profileUrl}\n`;
      // 仅在有有效显示名时输出（过滤 CSS 类名、HTML 属性值等）
      if (user.displayName && isValidDisplayName(user.displayName) && user.displayName !== user.username) {
        md += `- 显示名: ${user.displayName}\n`;
      }
      if (user.bio) {
        md += `- 简介: ${user.bio.substring(0, 150)}${user.bio.length > 150 ? '...' : ''}\n`;
      }
      if (user.followers) {
        md += `- 粉丝: ${user.followers.display} (${user.followers.count.toLocaleString()})\n`;
      }
      if (user.following) {
        md += `- 关注: ${user.following.display} (${user.following.count.toLocaleString()})\n`;
      }
      if (user.totalLikes) {
        md += `- 获赞: ${user.totalLikes.display} (${user.totalLikes.count.toLocaleString()})\n`;
      }
      if (user.avatarUrl) {
        md += `- 头像: ${shortenCoverUrl(user.avatarUrl)}\n`;
      }
      md += '\n';
    });
  }

  // 如果提取到的视频数量较少，回退到原始方法（但更精简）
  if (extractedData.videos.length < 10) {
    console.warn('[Markdown转换] 智能提取的视频数量较少，使用备用方法...');
    
    // 备用方法：提取包含 /video/ 的链接及其上下文
    let backupMd = html;
    
    // 移除所有 script/style
    backupMd = backupMd.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    backupMd = backupMd.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    
    // 只保留包含视频链接的部分
    const videoSections = [];
    const videoLinkMatches = html.matchAll(/<a[^>]*href=["'][^"']*\/video\/\d+[^"']*["'][^>]*>[\s\S]*?<\/a>/gi);
    
    for (const linkMatch of videoLinkMatches) {
      const linkHtml = linkMatch[0];
      // 提取链接和文本
      const hrefMatch = linkHtml.match(/href=["']([^"']+)["']/);
      const textMatch = linkHtml.match(/>([\s\S]*?)<\/a>/);
      
      if (hrefMatch) {
        const href = hrefMatch[1];
        const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        videoSections.push(`- [${text || '视频'}](${href})`);
      }
    }
    
    if (videoSections.length > 0) {
      md = '# 视频链接\n\n' + videoSections.join('\n') + '\n\n';
    }
  }

  return md.trim() || '未提取到视频信息';
}

/**
 * 使用 AI Agent 提取所有视频和红人信息（一次调用）
 * @param {Object} page - Playwright Page 对象
 * @returns {Promise<Object>} - { videos: Array, influencers: Array, stats: Object }
 */
async function extractVideosAndInfluencersWithAI(page) {
  console.log('[AI提取] [方案B] 开始使用 AI Agent 提取视频和红人信息（不依赖 CSS 选择器）...');
  const startTime = Date.now();
  
  // 1. 等待页面加载并滚动以触发懒加载，直到获取到至少50个视频
  console.log('[AI提取] 等待页面加载...');
  await page.waitForTimeout(3000);
  
  // 2. 滚动页面以加载更多内容，直到获取到至少50个视频
  console.log('[AI提取] 滚动页面以加载至少50个视频（模拟人类行为，降低被检测风险）...');
  const targetVideoCount = 50;
  let currentVideoCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 30; // 最多滚动30次，防止无限循环
  
  // 随机延迟函数：模拟人类的不规律行为
  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  // 滚动函数：使用平滑滚动和随机行为，模拟人类操作
  async function performScroll() {
    // 随机选择滚动方式（70% 使用鼠标滚轮，30% 使用键盘）
    const useMouseWheel = Math.random() > 0.3;
    
    if (useMouseWheel) {
      // 方法1: 鼠标滚轮滚动（最像人类操作）
      // 随机移动鼠标位置（模拟用户鼠标位置变化）
      const mouseX = randomDelay(300, 700);
      const mouseY = randomDelay(300, 600);
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(randomDelay(100, 300)); // 小停顿
      
      // 随机滚动距离（不完全滚动一屏，更像人类）
      const scrollDistance = randomDelay(400, 800);
      await page.mouse.wheel(0, scrollDistance);
      
      // 偶尔添加第二次小滚动（模拟用户调整位置）
      if (Math.random() > 0.7) {
        await page.waitForTimeout(randomDelay(200, 500));
        await page.mouse.wheel(0, randomDelay(100, 300));
      }
    } else {
      // 方法2: 键盘 PageDown（偶尔使用）
      await page.keyboard.press('PageDown');
    }
    
    // 方法3: 同时更新容器滚动位置（确保内容加载）
    const scrolled = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="search-result-list"]',
        '[data-e2e="search_video-item-list"]',
        '[class*="SearchResult"]',
        '[class*="search-result"]',
        'main',
        '[role="main"]',
        '.css-1qb12g8-DivContentContainer',
        '[class*="DivContentContainer"]',
        '[class*="ItemContainer"]'
      ];
      
      // 随机滚动距离（不完全一屏）
      const scrollAmount = Math.floor(window.innerHeight * (0.7 + Math.random() * 0.3));
      
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.scrollHeight > el.clientHeight) {
            el.scrollTop += scrollAmount;
            return { method: 'container', selector: sel };
          }
        } catch (e) {}
      }
      
      // 备用：滚动 window
      const before = window.scrollY;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      if (window.scrollY !== before) {
        return { method: 'window' };
      }
      
      document.documentElement.scrollTop += scrollAmount;
      return { method: 'documentElement' };
    });
    
    return scrolled;
  }
  
  while (currentVideoCount < targetVideoCount && scrollAttempts < maxScrollAttempts) {
    // 执行滚动（模拟人类行为）
    const scrollResult = await performScroll();
    if (scrollAttempts === 0) {
      console.log(`[AI提取] 使用的滚动方式: ${scrollResult?.method || 'mouse'}${scrollResult?.selector ? ` (${scrollResult.selector})` : ''}`);
    }
    
    // 随机等待时间（2-4秒），模拟人类阅读和浏览时间
    const waitTime = randomDelay(2000, 4000);
    await page.waitForTimeout(waitTime);
    
    // 偶尔添加额外停顿（10% 概率，模拟用户被内容吸引）
    if (Math.random() > 0.9) {
      const extraWait = randomDelay(1000, 3000);
      console.log(`[AI提取] 模拟用户浏览停顿 ${extraWait}ms...`);
      await page.waitForTimeout(extraWait);
    }
    
    // 检查当前页面上的视频数量
    currentVideoCount = await page.evaluate(() => {
      const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const uniqueVideoIds = new Set();
      videoLinks.forEach(link => {
        const href = link.getAttribute('href');
        const match = href.match(/\/video\/(\d+)/);
        if (match) {
          uniqueVideoIds.add(match[1]);
        }
      });
      return uniqueVideoIds.size;
    });
    
    scrollAttempts++;
    console.log(`[AI提取] 滚动第 ${scrollAttempts} 次，当前视频数量: ${currentVideoCount}`);
    
    // 如果视频数量没有增加，可能已经到底了
    if (scrollAttempts > 5 && currentVideoCount === 0) {
      console.warn('[AI提取] ⚠️ 未检测到视频，可能页面结构已变化');
      break;
    }
    
    // 如果连续多次滚动视频数不变，可能已到底
    if (scrollAttempts > 10 && scrollAttempts % 5 === 1) {
      const prevCount = currentVideoCount;
      await page.waitForTimeout(1000);
      const afterCount = await page.evaluate(() => {
        const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
        const uniqueVideoIds = new Set();
        videoLinks.forEach(link => {
          const href = link.getAttribute('href');
          const match = href.match(/\/video\/(\d+)/);
          if (match) uniqueVideoIds.add(match[1]);
        });
        return uniqueVideoIds.size;
      });
      if (afterCount === prevCount && prevCount > 0) {
        console.log(`[AI提取] 视频数量稳定在 ${prevCount}，可能已加载完毕`);
        if (scrollAttempts > 15) break;
      }
    }
  }
  
  console.log(`[AI提取] ✅ 滚动完成，共找到 ${currentVideoCount} 个视频`);
  
  // 3. 等待内容稳定
  await page.waitForTimeout(3000);
  
  // 4. 方案B：直接提取整个页面 HTML（不依赖 CSS 选择器和 DOM 结构识别）
  console.log('[AI提取] [方案B] 提取整个页面 HTML（不依赖选择器）...');
  
  const rawHTML = await page.content();
  const rawHTMLLength = rawHTML.length;
  console.log(`[AI提取] 原始 HTML 长度: ${rawHTMLLength.toLocaleString()} 字符`);
  
  // 5. 优化 HTML（减少大小，移除脚本、样式等）
  console.log('[AI提取] 优化 HTML（移除脚本、样式等无关内容）...');
  const optimizedHTML = optimizeHTML(rawHTML);
  const optimizedHTMLLength = optimizedHTML.length;
  console.log(`[AI提取] 优化后 HTML 长度: ${optimizedHTMLLength.toLocaleString()} 字符`);
  console.log(`[AI提取] HTML 减少: ${((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1)}%`);
  
  // 6. 获取优化建议
  const videoCount = (optimizedHTML.match(/\/video\//g) || []).length;
  const optimizationInfo = getOptimizationSuggestions(optimizedHTMLLength, videoCount);
  
  console.log(`[AI提取] 检测到约 ${videoCount} 个视频链接`);
  if (optimizationInfo.suggestions.length > 0) {
    console.log('[AI提取] 优化建议:');
    optimizationInfo.suggestions.forEach((suggestion, index) => {
      console.log(`  ${index + 1}. [${suggestion.level.toUpperCase()}] ${suggestion.message}`);
      if (suggestion.actions) {
        suggestion.actions.forEach(action => console.log(`     ${action}`));
      } else if (suggestion.action) {
        console.log(`     ${suggestion.action}`);
      }
    });
  }

  // 7.1 将 HTML 转换为精简 Markdown，进一步减少 Token 并提高可读性
  console.log('[AI提取] [方案B] 将页面 HTML 转为精简 Markdown...');
  const markdownContent = htmlToCompactMarkdown(optimizedHTML);
  const markdownLength = markdownContent.length;
  console.log(`[AI提取] Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Markdown Token 数: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
  
  // 保存精简 Markdown 到日志（供检查）
  const logsDir = path.join(__dirname, '../logs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const markdownLogPath = path.join(logsDir, `markdown-input-${timestamp}.md`);
    fs.writeFileSync(markdownLogPath, markdownContent, 'utf-8');
    console.log(`[AI提取] 精简 Markdown 已保存到: ${markdownLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 Markdown 日志失败:', e.message);
  }
  
  // ========== 测试模式：只测试 Markdown 转换，跳过 LLM 调用 ==========
  const TEST_MARKDOWN_ONLY = true; // 设置为 true 只测试 Markdown，false 继续调用 LLM
  
  if (TEST_MARKDOWN_ONLY) {
    console.log('');
    console.log('='.repeat(80));
    console.log('🧪 测试模式：只测试 Markdown 转换效果');
    console.log('='.repeat(80));
    console.log('');
    console.log('Markdown 内容预览（前2000字符）：');
    console.log('-'.repeat(80));
    console.log(markdownContent.substring(0, 2000));
    console.log('-'.repeat(80));
    console.log('');
    console.log(`✅ Markdown 转换完成！`);
    console.log(`📊 统计信息：`);
    console.log(`   - 视频数量: ${(markdownContent.match(/## \d+\. 视频/g) || []).length}`);
    console.log(`   - 用户数量: ${(markdownContent.match(/## \d+\. @/g) || []).length}`);
    console.log(`   - Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
    console.log(`   - 估算 Token: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
    console.log('');
    console.log('💡 提示：检查 logs/markdown-input-*.md 文件查看完整 Markdown');
    console.log('');
    
    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);
    
    return {
      videos: [],
      influencers: [],
      markdown: markdownContent,
      stats: {
        totalTime: totalTime,
        llmTime: '0',
        htmlLength: {
          original: rawHTMLLength,
          optimized: optimizedHTMLLength,
          reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
        },
        tokenEstimate: {
          original: Math.ceil(rawHTMLLength / 4),
          optimized: Math.ceil(optimizedHTMLLength / 4),
          prompt: Math.ceil(markdownLength / 4),
          markdown: Math.ceil(markdownLength / 4)
        },
        videoCount: (markdownContent.match(/## \d+\. 视频/g) || []).length,
        influencerCount: (markdownContent.match(/## \d+\. @/g) || []).length,
        optimizationSuggestions: optimizationInfo.suggestions
      }
    };
  }
  
  // ========== 正常模式：继续调用 LLM ==========
  
  // 8. 构建 LLM Prompt（基于精简 Markdown，方案B）
  console.log('[AI提取] [方案B] 构建 LLM Prompt（让 LLM 自己识别视频）...');
  const prompt = `你是一个专业的社交媒体数据分析专家。请分析下面这个 TikTok 搜索结果页面的完整内容（Markdown 格式），**自己识别并提取**所有视频和对应的红人（创作者）信息。

**方案B说明**：
- 我们直接提供了整个页面的精简 Markdown 内容
- 你需要自己识别哪些是视频卡片，哪些是视频信息，哪些是红人信息
- 不依赖特定的 HTML 结构或 CSS 选择器
- 通过内容语义来识别（如视频链接、用户名链接、播放量、点赞数等）

下面是已经提取并转换好的**精简版 Markdown 内容**（只包含与视频和红人相关的信息，不包含样式、脚本等）：

${markdownContent.substring(0, 200000)}  // 限制长度避免超过 token 限制

请**自己识别并提取**以下信息：

**视频信息**（每个视频）：
1. videoId: 视频ID（从链接中提取，格式如 /video/1234567890）
2. videoUrl: 视频完整链接（如 https://www.tiktok.com/@username/video/1234567890）
3. username: 作者用户名（从链接中提取，格式如 /@username，只返回 username 部分，不要包含 @ 符号）
4. profileUrl: 作者主页链接（如 https://www.tiktok.com/@username）
5. views: 播放量（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，如 { count: 1200000, display: "1.2M" }）
6. likes: 点赞数（如果有显示，格式同上）
7. thumbnail: 视频封面图片 URL

**红人信息**（每个红人，去重）：
1. username: 用户名（从链接中提取）
2. displayName: 显示名称（创作者的名字）
3. profileUrl: 个人主页链接
4. avatarUrl: 头像图片 URL
5. followers: 粉丝数（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，否则为 null）
6. bio: 个人简介（如果有）
7. verified: 是否认证（true/false）

**重要提示**：
- 提取页面中所有视频，有多少条就提取多少条（20条就20条，50条就50条）
- 用户名必须从链接中提取，格式为 /@username，只返回 username 部分
- 所有字段如果找不到，返回 null 或空字符串
- 播放量、点赞数、粉丝数需要解析（如 "1.2M" → { count: 1200000, display: "1.2M" }）
- 红人信息需要去重（相同用户名只保留一个）
- 只返回 JSON 格式，不要其他文字说明

请返回 JSON 格式：
{
  "videos": [
    {
      "videoId": "视频ID或null",
      "videoUrl": "完整URL或null",
      "username": "用户名或null",
      "profileUrl": "主页URL或null",
      "views": { "count": 数字或0, "display": "显示文本或'0'" },
      "likes": { "count": 数字或0, "display": "显示文本或'0'" },
      "thumbnail": "图片URL或null"
    },
    ...
  ],
  "influencers": [
    {
      "username": "用户名或null",
      "displayName": "显示名称或null",
      "profileUrl": "主页URL或null",
      "avatarUrl": "头像URL或null",
      "followers": { "count": 数字或null, "display": "显示文本或null" },
      "bio": "简介或null",
      "verified": true或false,
      "platform": "TikTok"
    },
    ...
  ]
}`;

  const promptLength = prompt.length;
  console.log(`[AI提取] Prompt 长度: ${promptLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Token 数: ${Math.ceil(promptLength / 4).toLocaleString()}`);
  
  // 9. 调用 LLM（DeepSeek API 最大支持 8192 tokens）
  console.log('[AI提取] 调用 LLM API（max_tokens=8192）...');
  const llmStartTime = Date.now();
  const llmResult = await callDeepSeekLLM(
    [{ role: "user", content: prompt }],
    "你是一个专业的社交媒体数据分析专家，擅长从网页 HTML 中提取结构化信息。只返回 JSON 格式，不要其他文字。",
    { maxTokens: 8192, returnFullResponse: true }
  );
  const llmEndTime = Date.now();
  const llmResponse = llmResult.content;
  const finishReason = llmResult.finishReason;
  const usage = llmResult.usage || {};
  
  console.log(`[AI提取] LLM 调用耗时: ${((llmEndTime - llmStartTime) / 1000).toFixed(2)} 秒`);
  console.log(`[AI提取] LLM 响应长度: ${llmResponse.length.toLocaleString()} 字符`);
  console.log(`[AI提取] finish_reason: ${finishReason}（length=输出被 token 限制截断）`);
  console.log(`[AI提取] Token 使用: 输入=${usage.prompt_tokens || '未知'}, 输出=${usage.completion_tokens || '未知'}`);
  console.log(`[AI提取] LLM 响应预览: ${llmResponse.substring(0, 300)}...`);
  
  if (finishReason === 'length') {
    console.warn('[AI提取] ⚠️ 输出被 token 限制截断！请增加 max_tokens 或减少视频数量');
  }
  
  // 10. 保存原始 LLM 响应到日志（供检查）
  const responseLogPath = path.join(logsDir, `llm-response-raw-${timestamp}.json`);
  try {
    fs.writeFileSync(responseLogPath, llmResponse, 'utf-8');
    console.log(`[AI提取] LLM 原始响应已保存到: ${responseLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 LLM 响应失败:', e.message);
  }
  
  // 10. 解析 JSON 响应（改进的解析逻辑）
  console.log('[AI提取] 解析 LLM 响应...');
  let extractedData;
  let parseError = null;
  
  try {
    // 尝试1: 直接解析
    extractedData = JSON.parse(llmResponse);
    console.log('[AI提取] ✅ 直接解析成功');
  } catch (e) {
    parseError = e;
    console.warn('[AI提取] 直接解析失败:', e.message);
    
    try {
      // 尝试2: 移除 markdown 代码块标记
      let cleanedResponse = llmResponse;
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '');
      cleanedResponse = cleanedResponse.replace(/```\s*/g, '');
      cleanedResponse = cleanedResponse.trim();
      
      extractedData = JSON.parse(cleanedResponse);
      console.log('[AI提取] ✅ 移除 markdown 标记后解析成功');
    } catch (e2) {
      console.warn('[AI提取] 移除 markdown 标记后仍失败:', e2.message);
      
      try {
        // 尝试3: 提取 JSON 对象（使用更宽松的正则）
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          let jsonStr = jsonMatch[0];
          
          // 尝试修复常见的 JSON 错误
          // 修复末尾多余的逗号
          jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
          // 修复单引号
          jsonStr = jsonStr.replace(/'/g, '"');
          
          extractedData = JSON.parse(jsonStr);
          console.log('[AI提取] ✅ 提取并修复后解析成功');
        } else {
          throw new Error('无法从响应中提取 JSON 对象');
        }
      } catch (e3) {
        console.warn('[AI提取] ⚠️ 标准解析失败，尝试修复截断的 JSON...');
        
        try {
          // 尝试4: 修复被截断的 JSON（更智能的方法）
          let jsonStr = llmResponse;
          // 移除 markdown 代码块标记
          jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          
          // 策略：从后往前查找，找到最后一个完整的对象
          // 先找到所有完整的 videoId 对象
          const videoIdPattern = /"videoId"\s*:\s*"(\d+)"/g;
          const videoIds = [];
          let match;
          while ((match = videoIdPattern.exec(jsonStr)) !== null) {
            videoIds.push({ id: match[1], index: match.index });
          }
          
          if (videoIds.length === 0) {
            throw new Error('未找到任何视频ID');
          }
          
          // 从最后一个videoId开始，向前查找完整的对象
          let lastValidIndex = jsonStr.length;
          
          // 从后往前查找，找到最后一个完整的对象结束位置
          for (let i = videoIds.length - 1; i >= 0; i--) {
            const videoId = videoIds[i];
            const startIndex = videoId.index;
            
            // 向前查找这个对象的开始（找到最近的 {）
            let objStart = startIndex;
            let braceCount = 0;
            let foundStart = false;
            
            // 向前查找对象开始
            for (let j = startIndex; j >= 0; j--) {
              if (jsonStr[j] === '}') braceCount++;
              else if (jsonStr[j] === '{') {
                braceCount--;
                if (braceCount === 0) {
                  objStart = j;
                  foundStart = true;
                  break;
                }
              }
            }
            
            if (!foundStart) continue;
            
            // 向后查找这个对象的结束
            let objEnd = -1;
            braceCount = 0;
            let inString = false;
            let escapeNext = false;
            
            for (let j = objStart; j < jsonStr.length; j++) {
              const char = jsonStr[j];
              
              if (escapeNext) {
                escapeNext = false;
                continue;
              }
              
              if (char === '\\') {
                escapeNext = true;
                continue;
              }
              
              if (char === '"') {
                inString = !inString;
                continue;
              }
              
              if (inString) continue;
              
              if (char === '{') braceCount++;
              else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  objEnd = j + 1;
                  break;
                }
              }
            }
            
            if (objEnd > 0 && objEnd <= jsonStr.length) {
              // 验证这个对象是否完整（检查是否在字符串中间被截断）
              const objContent = jsonStr.substring(objStart, objEnd);
              
              // 检查对象是否包含未闭合的字符串
              let stringCount = 0;
              let isValid = true;
              for (let j = 0; j < objContent.length; j++) {
                if (objContent[j] === '\\') {
                  j++; // 跳过转义字符
                  continue;
                }
                if (objContent[j] === '"') {
                  stringCount++;
                }
              }
              
              // 如果字符串引号数量是偶数，说明字符串都闭合了
              if (stringCount % 2 === 0) {
                lastValidIndex = objEnd;
                break;
              }
            }
          }
          
          // 提取到最后一个完整对象为止的JSON
          let fixedJson = jsonStr.substring(0, lastValidIndex);
          
          // 移除最后一个对象后的逗号（如果有）
          fixedJson = fixedJson.replace(/,\s*$/, '');
          
          // 找到videos数组的开始位置
          const videosArrayStart = fixedJson.indexOf('"videos"');
          if (videosArrayStart > 0) {
            const arrayStart = fixedJson.indexOf('[', videosArrayStart);
            if (arrayStart > 0) {
              // 计算需要闭合的括号（只计算数组内的）
              const arrayContent = fixedJson.substring(arrayStart);
              const openBraces = (arrayContent.match(/\{/g) || []).length;
              const closeBraces = (arrayContent.match(/\}/g) || []).length;
              const openBrackets = (arrayContent.match(/\[/g) || []).length;
              const closeBrackets = (arrayContent.match(/\]/g) || []).length;
              
              // 添加缺失的闭合括号
              if (closeBraces < openBraces) {
                fixedJson += '}'.repeat(openBraces - closeBraces);
              }
              if (closeBrackets < openBrackets) {
                fixedJson += ']'.repeat(openBrackets - closeBrackets);
              }
              
              // 确保videos数组正确闭合
              if (!fixedJson.endsWith(']')) {
                fixedJson += ']';
              }
            }
          }
          
          // 确保根对象正确闭合
          const rootOpenBraces = (fixedJson.match(/\{/g) || []).length;
          const rootCloseBraces = (fixedJson.match(/\}/g) || []).length;
          if (rootCloseBraces < rootOpenBraces) {
            fixedJson += '}'.repeat(rootOpenBraces - rootCloseBraces);
          }
          
          // 修复常见的 JSON 错误
          fixedJson = fixedJson.replace(/,(\s*[}\]])/g, '$1'); // 移除末尾多余的逗号
          fixedJson = fixedJson.replace(/'/g, '"'); // 修复单引号
          
          // 确保JSON结构完整
          if (!fixedJson.trim().startsWith('{')) {
            const firstBrace = fixedJson.indexOf('{');
            if (firstBrace > 0) {
              fixedJson = fixedJson.substring(firstBrace);
            }
          }
          
          extractedData = JSON.parse(fixedJson);
          console.log('[AI提取] ✅ 修复截断 JSON 后解析成功');
          console.log(`[AI提取] ⚠️ 注意：JSON 可能被截断，只提取了前 ${extractedData.videos?.length || 0} 个视频`);
        } catch (e4) {
          console.error('[AI提取] ❌ 所有解析尝试都失败（包括修复截断 JSON）');
          console.error('[AI提取] 错误详情:', e4.message);
          console.error('[AI提取] 响应位置:', e4.message.match(/position (\d+)/)?.[1] || '未知');
          
          // 输出响应的一部分以便调试
          const errorPos = parseInt(e4.message.match(/position (\d+)/)?.[1] || '0');
          if (errorPos > 0) {
            const start = Math.max(0, errorPos - 200);
            const end = Math.min(llmResponse.length, errorPos + 200);
            console.error('[AI提取] 错误位置附近的响应内容:');
            console.error('='.repeat(80));
            console.error(llmResponse.substring(start, end));
            console.error('='.repeat(80));
          }
          
          throw new Error(`JSON 解析失败: ${e4.message}`);
        }
      }
    }
  }
  
  // 11. 输出原始提取数据并保存到日志（供检查）
  console.log('');
  console.log('='.repeat(80));
  console.log('LLM 原始提取数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(extractedData, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  try {
    const extractedLogPath = path.join(logsDir, `extracted-data-raw-${timestamp}.json`);
    fs.writeFileSync(extractedLogPath, JSON.stringify(extractedData, null, 2), 'utf-8');
    console.log(`[AI提取] 原始提取数据已保存到: ${extractedLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存原始提取数据失败:', e.message);
  }
  
  // 12. 验证和清理数据
  const videos = Array.isArray(extractedData.videos) ? extractedData.videos : [];
  const influencers = Array.isArray(extractedData.influencers) ? extractedData.influencers : [];
  
  // 清理和验证视频数据
  const cleanedVideos = videos.map(video => ({
    videoId: video.videoId || null,
    videoUrl: video.videoUrl || null,
    username: video.username || null,
    profileUrl: video.profileUrl || (video.username ? `https://www.tiktok.com/@${video.username}` : null),
    views: video.views || { count: 0, display: '0' },
    likes: video.likes || { count: 0, display: '0' },
    thumbnail: video.thumbnail || null
  }));
  
  // 清理和验证红人数据（去重）
  const seenUsernames = new Set();
  const cleanedInfluencers = influencers
    .filter(inf => inf.username && !seenUsernames.has(inf.username))
    .map(inf => {
      seenUsernames.add(inf.username);
      return {
        username: inf.username,
        displayName: inf.displayName || inf.username,
        profileUrl: inf.profileUrl || `https://www.tiktok.com/@${inf.username}`,
        avatarUrl: inf.avatarUrl || null,
        followers: inf.followers || null,
        bio: inf.bio || null,
        verified: inf.verified || false,
        platform: 'TikTok'
      };
    });
  
  const endTime = Date.now();
  const totalTime = ((endTime - startTime) / 1000).toFixed(2);
  
  console.log(`[AI提取] ✅ 提取完成！`);
  console.log(`[AI提取] 总耗时: ${totalTime} 秒`);
  console.log(`[AI提取] 提取到 ${cleanedVideos.length} 个视频`);
  console.log(`[AI提取] 提取到 ${cleanedInfluencers.length} 个红人`);
  
  // 14. 检测是否需要更新规则（去重后的用户名数量 < 10）
  const extractionResult = {
    videos: cleanedVideos,
    users: cleanedInfluencers
  };
  
  // 14.1 检测是否需要更新规则（去重后的用户名数量 < 10）
  const shouldUpdate = shouldTriggerRuleUpdate(extractionResult, 50);
  
  if (shouldUpdate) {
    console.log('[规则更新] ⚠️ 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    try {
      // 获取 HTML（用于 LLM 学习）
      const html = await page.content();
      const optimizedHTML = optimizeHTML(html);
      
      // 调用规则更新（最多重试 3 次）
      const updateResult = await updateRulesWithRetry(
        optimizedHTML, 
        extractionResult, 
        50,
        extractWithRules  // 规则引擎函数
      );
      
      if (updateResult.success) {
        console.log('[规则更新] ✅ 规则更新成功，版本:', updateResult.rules.version);
        console.log('[规则更新] 指标:', updateResult.metrics);
        
        // 可选：用新规则重新提取一次（如果需要）
        // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
        // console.log('[规则更新] 新规则提取结果:', newResult.videos.length, '个视频,', newResult.users.length, '个用户');
      } else {
        console.log('[规则更新] ⚠️ 规则更新失败（' + updateResult.attempts + ' 次尝试均失败），继续使用旧规则');
        console.log('[规则更新] 最后失败原因:', updateResult.lastError);
      }
    } catch (e) {
      console.error('[规则更新] ❌ 规则更新过程出错:', e.message);
      console.error('[规则更新] 错误堆栈:', e.stack);
    }
  }
  
  // 13. 输出清理后的完整数据（用于测试）
  console.log('');
  console.log('='.repeat(80));
  console.log('清理后的视频数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedVideos, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  console.log('='.repeat(80));
  console.log('清理后的红人数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedInfluencers, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  // 13.1 保存最终视频和红人数据到日志（供检查）
  try {
    const finalData = { videos: cleanedVideos, influencers: cleanedInfluencers };
    const finalLogPath = path.join(logsDir, `extracted-data-final-${timestamp}.json`);
    fs.writeFileSync(finalLogPath, JSON.stringify(finalData, null, 2), 'utf-8');
    console.log(`[AI提取] 最终视频和红人数据已保存到: ${finalLogPath}`);
    
    // 保存截断说明日志
    const summaryPath = path.join(logsDir, `extraction-summary-${timestamp}.txt`);
    const summary = [
      `=== TikTok 数据提取日志 ${timestamp} ===`,
      '',
      '【截断原因说明】',
      `finish_reason: ${finishReason}`,
      '- stop: 正常完成，未截断',
      '- length: 输出达到 max_tokens 限制被截断（API 默认或设置的输出 token 上限）',
      '- content_filter: 内容被过滤',
      '',
      '【Token 使用】',
      `输入 tokens: ${usage.prompt_tokens || '未知'}`,
      `输出 tokens: ${usage.completion_tokens || '未知'}`,
      '',
      '【数据统计】',
      `视频数量: ${cleanedVideos.length}`,
      `红人数量: ${cleanedInfluencers.length}`,
      `Markdown 长度: ${markdownLength} 字符`,
      `LLM 响应长度: ${llmResponse.length} 字符`,
      '',
      '【日志文件】',
      `- 精简 Markdown 输入: markdown-input-${timestamp}.md`,
      `- LLM 原始 JSON 响应: llm-response-raw-${timestamp}.json`,
      `- 解析后原始数据: extracted-data-raw-${timestamp}.json`,
      `- 最终清理数据: extracted-data-final-${timestamp}.json`
    ].join('\n');
    fs.writeFileSync(summaryPath, summary, 'utf-8');
    console.log(`[AI提取] 提取摘要已保存到: ${summaryPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存最终数据失败:', e.message);
  }
  
  // 14. 返回结果和统计信息
  return {
    videos: cleanedVideos,
    influencers: cleanedInfluencers,
    stats: {
      totalTime: totalTime,
      llmTime: ((llmEndTime - llmStartTime) / 1000).toFixed(2),
      htmlLength: {
        original: rawHTMLLength,
        optimized: optimizedHTMLLength,
        reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
      },
      tokenEstimate: {
        original: Math.ceil(rawHTMLLength / 4),
        optimized: Math.ceil(optimizedHTMLLength / 4),
        prompt: Math.ceil(promptLength / 4)
      },
      videoCount: cleanedVideos.length,
      influencerCount: cleanedInfluencers.length,
      optimizationSuggestions: optimizationInfo.suggestions
    }
  };
}

/**
 * 等待用户按 Enter 键
 */
function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

// 运行主函数
main().catch(console.error);
      // 提取关注数（following）
      const followingMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:following|关注)/i);
      if (followingMatch) {
        const num = parseFloat(followingMatch[1]);
        const unit = followingMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.following = { count: Math.round(count), display: followingMatch[0].trim() };
        }
      }
      
      // 提取获赞数（likes）
      const likesMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:likes?|获赞)/i);
      if (likesMatch) {
        const num = parseFloat(likesMatch[1]);
        const unit = likesMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.totalLikes = { count: Math.round(count), display: likesMatch[0].trim() };
        }
      }
      
      // 提取认证状态（verified badge）
      const verifiedPatterns = [
        /verified/i,
        /认证/i,
        /verified account/i,
        /checkmark/i,
        /✓/,
        /data-e2e=["']verified["']/i,
      ];
      
      for (const pattern of verifiedPatterns) {
        if (pattern.test(context)) {
          user.verified = true;
          break;
        }
      }
      
      // 提取头像（缩短 URL）
      const avatarMatches = context.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi);
      for (const avatarMatch of avatarMatches) {
        const imgSrc = avatarMatch[1];
        if (imgSrc && (imgSrc.includes('avatar') || imgSrc.includes('avt-') || imgSrc.includes('user') || 
            imgSrc.includes('profile') || imgSrc.includes('head'))) {
          user.avatarUrl = shortenCoverUrl(imgSrc);
          break;
        }
      }
      
      // 提取用户简介（bio）
      const bioPatterns = [
        /bio[:\s]+([^@#\n]{5,200})/i,
        /简介[:\s]+([^@#\n]{5,200})/i,
        /description[:\s]+([^@#\n]{5,200})/i,
      ];
      
      for (const pattern of bioPatterns) {
        const bioMatch = contextText.match(pattern);
        if (bioMatch && bioMatch[1]) {
          const bio = bioMatch[1].trim();
          if (bio.length >= 5 && bio.length <= 200 && !bio.match(/^\d+$/)) {
            user.bio = bio;
            break;
          }
        }
      }
    }
  });

  // 6. 构建精简的 Markdown（紧凑格式）
  let md = '';

  // 视频列表（仅输出 HTML 中实际存在的数据，不臆造）
  if (extractedData.videos.length > 0) {
    md += `# 视频列表 (${extractedData.videos.length}个)\n`;
    md += `注：搜索页仅展示点赞数，无播放量/评论/收藏\n\n`;
    extractedData.videos.forEach((video, idx) => {
      md += `## ${idx + 1}. 视频 ${video.videoId}\n`;
      md += `- URL: ${video.videoUrl}\n`;
      if (video.username) md += `- 作者: @${video.username}\n`;
      if (video.caption) {
        md += `- 文案: ${video.caption.substring(0, 200)}${video.caption.length > 200 ? '...' : ''}\n`;
      } else if (video.description) {
        md += `- 描述: ${video.description.substring(0, 200)}${video.description.length > 200 ? '...' : ''}\n`;
      }
      if (video.postedTime) md += `- 发布时间: ${video.postedTime}\n`;
      if (video.likes) md += `- 点赞: ${video.likes.display}\n`;
      if (video.hashtags && video.hashtags.length > 0) md += `- 标签: ${video.hashtags.join(' ')}\n`;
      if (video.mentions && video.mentions.length > 0) md += `- @提及: ${video.mentions.join(' ')}\n`;
      if (video.creator) md += `- 创作者: ${video.creator}\n`;
      if (video.music) md += `- 音乐: ${video.music.substring(0, 80)}${video.music.length > 80 ? '...' : ''}\n`;
      if (video.thumbnail) md += `- 封面: ${shortenCoverUrl(video.thumbnail)}\n`;
      md += '\n';
    });
  }

  // 用户列表（红人列表，含显示名、粉丝、认证状态等）
  if (extractedData.users.length > 0) {
    md += `# 用户列表 (${extractedData.users.length}个)\n\n`;
    extractedData.users.forEach((user, idx) => {
      md += `## ${idx + 1}. @${user.username}`;
      if (user.verified) {
        md += ` ✓`; // 认证标记
      }
      md += `\n`;
      md += `- 主页: ${user.profileUrl}\n`;
      // 仅在有有效显示名时输出（过滤 CSS 类名、HTML 属性值等）
      if (user.displayName && isValidDisplayName(user.displayName) && user.displayName !== user.username) {
        md += `- 显示名: ${user.displayName}\n`;
      }
      if (user.bio) {
        md += `- 简介: ${user.bio.substring(0, 150)}${user.bio.length > 150 ? '...' : ''}\n`;
      }
      if (user.followers) {
        md += `- 粉丝: ${user.followers.display} (${user.followers.count.toLocaleString()})\n`;
      }
      if (user.following) {
        md += `- 关注: ${user.following.display} (${user.following.count.toLocaleString()})\n`;
      }
      if (user.totalLikes) {
        md += `- 获赞: ${user.totalLikes.display} (${user.totalLikes.count.toLocaleString()})\n`;
      }
      if (user.avatarUrl) {
        md += `- 头像: ${shortenCoverUrl(user.avatarUrl)}\n`;
      }
      md += '\n';
    });
  }

  // 如果提取到的视频数量较少，回退到原始方法（但更精简）
  if (extractedData.videos.length < 10) {
    console.warn('[Markdown转换] 智能提取的视频数量较少，使用备用方法...');
    
    // 备用方法：提取包含 /video/ 的链接及其上下文
    let backupMd = html;
    
    // 移除所有 script/style
    backupMd = backupMd.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    backupMd = backupMd.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    
    // 只保留包含视频链接的部分
    const videoSections = [];
    const videoLinkMatches = html.matchAll(/<a[^>]*href=["'][^"']*\/video\/\d+[^"']*["'][^>]*>[\s\S]*?<\/a>/gi);
    
    for (const linkMatch of videoLinkMatches) {
      const linkHtml = linkMatch[0];
      // 提取链接和文本
      const hrefMatch = linkHtml.match(/href=["']([^"']+)["']/);
      const textMatch = linkHtml.match(/>([\s\S]*?)<\/a>/);
      
      if (hrefMatch) {
        const href = hrefMatch[1];
        const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        videoSections.push(`- [${text || '视频'}](${href})`);
      }
    }
    
    if (videoSections.length > 0) {
      md = '# 视频链接\n\n' + videoSections.join('\n') + '\n\n';
    }
  }

  return md.trim() || '未提取到视频信息';
}

/**
 * 使用 AI Agent 提取所有视频和红人信息（一次调用）
 * @param {Object} page - Playwright Page 对象
 * @returns {Promise<Object>} - { videos: Array, influencers: Array, stats: Object }
 */
async function extractVideosAndInfluencersWithAI(page) {
  console.log('[AI提取] [方案B] 开始使用 AI Agent 提取视频和红人信息（不依赖 CSS 选择器）...');
  const startTime = Date.now();
  
  // 1. 等待页面加载并滚动以触发懒加载，直到获取到至少50个视频
  console.log('[AI提取] 等待页面加载...');
  await page.waitForTimeout(3000);
  
  // 2. 滚动页面以加载更多内容，直到获取到至少50个视频
  console.log('[AI提取] 滚动页面以加载至少50个视频（模拟人类行为，降低被检测风险）...');
  const targetVideoCount = 50;
  let currentVideoCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 30; // 最多滚动30次，防止无限循环
  
  // 随机延迟函数：模拟人类的不规律行为
  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  // 滚动函数：使用平滑滚动和随机行为，模拟人类操作
  async function performScroll() {
    // 随机选择滚动方式（70% 使用鼠标滚轮，30% 使用键盘）
    const useMouseWheel = Math.random() > 0.3;
    
    if (useMouseWheel) {
      // 方法1: 鼠标滚轮滚动（最像人类操作）
      // 随机移动鼠标位置（模拟用户鼠标位置变化）
      const mouseX = randomDelay(300, 700);
      const mouseY = randomDelay(300, 600);
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(randomDelay(100, 300)); // 小停顿
      
      // 随机滚动距离（不完全滚动一屏，更像人类）
      const scrollDistance = randomDelay(400, 800);
      await page.mouse.wheel(0, scrollDistance);
      
      // 偶尔添加第二次小滚动（模拟用户调整位置）
      if (Math.random() > 0.7) {
        await page.waitForTimeout(randomDelay(200, 500));
        await page.mouse.wheel(0, randomDelay(100, 300));
      }
    } else {
      // 方法2: 键盘 PageDown（偶尔使用）
      await page.keyboard.press('PageDown');
    }
    
    // 方法3: 同时更新容器滚动位置（确保内容加载）
    const scrolled = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="search-result-list"]',
        '[data-e2e="search_video-item-list"]',
        '[class*="SearchResult"]',
        '[class*="search-result"]',
        'main',
        '[role="main"]',
        '.css-1qb12g8-DivContentContainer',
        '[class*="DivContentContainer"]',
        '[class*="ItemContainer"]'
      ];
      
      // 随机滚动距离（不完全一屏）
      const scrollAmount = Math.floor(window.innerHeight * (0.7 + Math.random() * 0.3));
      
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.scrollHeight > el.clientHeight) {
            el.scrollTop += scrollAmount;
            return { method: 'container', selector: sel };
          }
        } catch (e) {}
      }
      
      // 备用：滚动 window
      const before = window.scrollY;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      if (window.scrollY !== before) {
        return { method: 'window' };
      }
      
      document.documentElement.scrollTop += scrollAmount;
      return { method: 'documentElement' };
    });
    
    return scrolled;
  }
  
  while (currentVideoCount < targetVideoCount && scrollAttempts < maxScrollAttempts) {
    // 执行滚动（模拟人类行为）
    const scrollResult = await performScroll();
    if (scrollAttempts === 0) {
      console.log(`[AI提取] 使用的滚动方式: ${scrollResult?.method || 'mouse'}${scrollResult?.selector ? ` (${scrollResult.selector})` : ''}`);
    }
    
    // 随机等待时间（2-4秒），模拟人类阅读和浏览时间
    const waitTime = randomDelay(2000, 4000);
    await page.waitForTimeout(waitTime);
    
    // 偶尔添加额外停顿（10% 概率，模拟用户被内容吸引）
    if (Math.random() > 0.9) {
      const extraWait = randomDelay(1000, 3000);
      console.log(`[AI提取] 模拟用户浏览停顿 ${extraWait}ms...`);
      await page.waitForTimeout(extraWait);
    }
    
    // 检查当前页面上的视频数量
    currentVideoCount = await page.evaluate(() => {
      const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const uniqueVideoIds = new Set();
      videoLinks.forEach(link => {
        const href = link.getAttribute('href');
        const match = href.match(/\/video\/(\d+)/);
        if (match) {
          uniqueVideoIds.add(match[1]);
        }
      });
      return uniqueVideoIds.size;
    });
    
    scrollAttempts++;
    console.log(`[AI提取] 滚动第 ${scrollAttempts} 次，当前视频数量: ${currentVideoCount}`);
    
    // 如果视频数量没有增加，可能已经到底了
    if (scrollAttempts > 5 && currentVideoCount === 0) {
      console.warn('[AI提取] ⚠️ 未检测到视频，可能页面结构已变化');
      break;
    }
    
    // 如果连续多次滚动视频数不变，可能已到底
    if (scrollAttempts > 10 && scrollAttempts % 5 === 1) {
      const prevCount = currentVideoCount;
      await page.waitForTimeout(1000);
      const afterCount = await page.evaluate(() => {
        const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
        const uniqueVideoIds = new Set();
        videoLinks.forEach(link => {
          const href = link.getAttribute('href');
          const match = href.match(/\/video\/(\d+)/);
          if (match) uniqueVideoIds.add(match[1]);
        });
        return uniqueVideoIds.size;
      });
      if (afterCount === prevCount && prevCount > 0) {
        console.log(`[AI提取] 视频数量稳定在 ${prevCount}，可能已加载完毕`);
        if (scrollAttempts > 15) break;
      }
    }
  }
  
  console.log(`[AI提取] ✅ 滚动完成，共找到 ${currentVideoCount} 个视频`);
  
  // 3. 等待内容稳定
  await page.waitForTimeout(3000);
  
  // 4. 方案B：直接提取整个页面 HTML（不依赖 CSS 选择器和 DOM 结构识别）
  console.log('[AI提取] [方案B] 提取整个页面 HTML（不依赖选择器）...');
  
  const rawHTML = await page.content();
  const rawHTMLLength = rawHTML.length;
  console.log(`[AI提取] 原始 HTML 长度: ${rawHTMLLength.toLocaleString()} 字符`);
  
  // 5. 优化 HTML（减少大小，移除脚本、样式等）
  console.log('[AI提取] 优化 HTML（移除脚本、样式等无关内容）...');
  const optimizedHTML = optimizeHTML(rawHTML);
  const optimizedHTMLLength = optimizedHTML.length;
  console.log(`[AI提取] 优化后 HTML 长度: ${optimizedHTMLLength.toLocaleString()} 字符`);
  console.log(`[AI提取] HTML 减少: ${((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1)}%`);
  
  // 6. 获取优化建议
  const videoCount = (optimizedHTML.match(/\/video\//g) || []).length;
  const optimizationInfo = getOptimizationSuggestions(optimizedHTMLLength, videoCount);
  
  console.log(`[AI提取] 检测到约 ${videoCount} 个视频链接`);
  if (optimizationInfo.suggestions.length > 0) {
    console.log('[AI提取] 优化建议:');
    optimizationInfo.suggestions.forEach((suggestion, index) => {
      console.log(`  ${index + 1}. [${suggestion.level.toUpperCase()}] ${suggestion.message}`);
      if (suggestion.actions) {
        suggestion.actions.forEach(action => console.log(`     ${action}`));
      } else if (suggestion.action) {
        console.log(`     ${suggestion.action}`);
      }
    });
  }

  // 7.1 将 HTML 转换为精简 Markdown，进一步减少 Token 并提高可读性
  console.log('[AI提取] [方案B] 将页面 HTML 转为精简 Markdown...');
  const markdownContent = htmlToCompactMarkdown(optimizedHTML);
  const markdownLength = markdownContent.length;
  console.log(`[AI提取] Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Markdown Token 数: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
  
  // 保存精简 Markdown 到日志（供检查）
  const logsDir = path.join(__dirname, '../logs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const markdownLogPath = path.join(logsDir, `markdown-input-${timestamp}.md`);
    fs.writeFileSync(markdownLogPath, markdownContent, 'utf-8');
    console.log(`[AI提取] 精简 Markdown 已保存到: ${markdownLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 Markdown 日志失败:', e.message);
  }
  
  // ========== 测试模式：只测试 Markdown 转换，跳过 LLM 调用 ==========
  const TEST_MARKDOWN_ONLY = true; // 设置为 true 只测试 Markdown，false 继续调用 LLM
  
  if (TEST_MARKDOWN_ONLY) {
    console.log('');
    console.log('='.repeat(80));
    console.log('🧪 测试模式：只测试 Markdown 转换效果');
    console.log('='.repeat(80));
    console.log('');
    console.log('Markdown 内容预览（前2000字符）：');
    console.log('-'.repeat(80));
    console.log(markdownContent.substring(0, 2000));
    console.log('-'.repeat(80));
    console.log('');
    console.log(`✅ Markdown 转换完成！`);
    console.log(`📊 统计信息：`);
    console.log(`   - 视频数量: ${(markdownContent.match(/## \d+\. 视频/g) || []).length}`);
    console.log(`   - 用户数量: ${(markdownContent.match(/## \d+\. @/g) || []).length}`);
    console.log(`   - Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
    console.log(`   - 估算 Token: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
    console.log('');
    console.log('💡 提示：检查 logs/markdown-input-*.md 文件查看完整 Markdown');
    console.log('');
    
    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);
    
    return {
      videos: [],
      influencers: [],
      markdown: markdownContent,
      stats: {
        totalTime: totalTime,
        llmTime: '0',
        htmlLength: {
          original: rawHTMLLength,
          optimized: optimizedHTMLLength,
          reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
        },
        tokenEstimate: {
          original: Math.ceil(rawHTMLLength / 4),
          optimized: Math.ceil(optimizedHTMLLength / 4),
          prompt: Math.ceil(markdownLength / 4),
          markdown: Math.ceil(markdownLength / 4)
        },
        videoCount: (markdownContent.match(/## \d+\. 视频/g) || []).length,
        influencerCount: (markdownContent.match(/## \d+\. @/g) || []).length,
        optimizationSuggestions: optimizationInfo.suggestions
      }
    };
  }
  
  // ========== 正常模式：继续调用 LLM ==========
  
  // 8. 构建 LLM Prompt（基于精简 Markdown，方案B）
  console.log('[AI提取] [方案B] 构建 LLM Prompt（让 LLM 自己识别视频）...');
  const prompt = `你是一个专业的社交媒体数据分析专家。请分析下面这个 TikTok 搜索结果页面的完整内容（Markdown 格式），**自己识别并提取**所有视频和对应的红人（创作者）信息。

**方案B说明**：
- 我们直接提供了整个页面的精简 Markdown 内容
- 你需要自己识别哪些是视频卡片，哪些是视频信息，哪些是红人信息
- 不依赖特定的 HTML 结构或 CSS 选择器
- 通过内容语义来识别（如视频链接、用户名链接、播放量、点赞数等）

下面是已经提取并转换好的**精简版 Markdown 内容**（只包含与视频和红人相关的信息，不包含样式、脚本等）：

${markdownContent.substring(0, 200000)}  // 限制长度避免超过 token 限制

请**自己识别并提取**以下信息：

**视频信息**（每个视频）：
1. videoId: 视频ID（从链接中提取，格式如 /video/1234567890）
2. videoUrl: 视频完整链接（如 https://www.tiktok.com/@username/video/1234567890）
3. username: 作者用户名（从链接中提取，格式如 /@username，只返回 username 部分，不要包含 @ 符号）
4. profileUrl: 作者主页链接（如 https://www.tiktok.com/@username）
5. views: 播放量（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，如 { count: 1200000, display: "1.2M" }）
6. likes: 点赞数（如果有显示，格式同上）
7. thumbnail: 视频封面图片 URL

**红人信息**（每个红人，去重）：
1. username: 用户名（从链接中提取）
2. displayName: 显示名称（创作者的名字）
3. profileUrl: 个人主页链接
4. avatarUrl: 头像图片 URL
5. followers: 粉丝数（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，否则为 null）
6. bio: 个人简介（如果有）
7. verified: 是否认证（true/false）

**重要提示**：
- 提取页面中所有视频，有多少条就提取多少条（20条就20条，50条就50条）
- 用户名必须从链接中提取，格式为 /@username，只返回 username 部分
- 所有字段如果找不到，返回 null 或空字符串
- 播放量、点赞数、粉丝数需要解析（如 "1.2M" → { count: 1200000, display: "1.2M" }）
- 红人信息需要去重（相同用户名只保留一个）
- 只返回 JSON 格式，不要其他文字说明

请返回 JSON 格式：
{
  "videos": [
    {
      "videoId": "视频ID或null",
      "videoUrl": "完整URL或null",
      "username": "用户名或null",
      "profileUrl": "主页URL或null",
      "views": { "count": 数字或0, "display": "显示文本或'0'" },
      "likes": { "count": 数字或0, "display": "显示文本或'0'" },
      "thumbnail": "图片URL或null"
    },
    ...
  ],
  "influencers": [
    {
      "username": "用户名或null",
      "displayName": "显示名称或null",
      "profileUrl": "主页URL或null",
      "avatarUrl": "头像URL或null",
      "followers": { "count": 数字或null, "display": "显示文本或null" },
      "bio": "简介或null",
      "verified": true或false,
      "platform": "TikTok"
    },
    ...
  ]
}`;

  const promptLength = prompt.length;
  console.log(`[AI提取] Prompt 长度: ${promptLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Token 数: ${Math.ceil(promptLength / 4).toLocaleString()}`);
  
  // 9. 调用 LLM（DeepSeek API 最大支持 8192 tokens）
  console.log('[AI提取] 调用 LLM API（max_tokens=8192）...');
  const llmStartTime = Date.now();
  const llmResult = await callDeepSeekLLM(
    [{ role: "user", content: prompt }],
    "你是一个专业的社交媒体数据分析专家，擅长从网页 HTML 中提取结构化信息。只返回 JSON 格式，不要其他文字。",
    { maxTokens: 8192, returnFullResponse: true }
  );
  const llmEndTime = Date.now();
  const llmResponse = llmResult.content;
  const finishReason = llmResult.finishReason;
  const usage = llmResult.usage || {};
  
  console.log(`[AI提取] LLM 调用耗时: ${((llmEndTime - llmStartTime) / 1000).toFixed(2)} 秒`);
  console.log(`[AI提取] LLM 响应长度: ${llmResponse.length.toLocaleString()} 字符`);
  console.log(`[AI提取] finish_reason: ${finishReason}（length=输出被 token 限制截断）`);
  console.log(`[AI提取] Token 使用: 输入=${usage.prompt_tokens || '未知'}, 输出=${usage.completion_tokens || '未知'}`);
  console.log(`[AI提取] LLM 响应预览: ${llmResponse.substring(0, 300)}...`);
  
  if (finishReason === 'length') {
    console.warn('[AI提取] ⚠️ 输出被 token 限制截断！请增加 max_tokens 或减少视频数量');
  }
  
  // 10. 保存原始 LLM 响应到日志（供检查）
  const responseLogPath = path.join(logsDir, `llm-response-raw-${timestamp}.json`);
  try {
    fs.writeFileSync(responseLogPath, llmResponse, 'utf-8');
    console.log(`[AI提取] LLM 原始响应已保存到: ${responseLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 LLM 响应失败:', e.message);
  }
  
  // 10. 解析 JSON 响应（改进的解析逻辑）
  console.log('[AI提取] 解析 LLM 响应...');
  let extractedData;
  let parseError = null;
  
  try {
    // 尝试1: 直接解析
    extractedData = JSON.parse(llmResponse);
    console.log('[AI提取] ✅ 直接解析成功');
  } catch (e) {
    parseError = e;
    console.warn('[AI提取] 直接解析失败:', e.message);
    
    try {
      // 尝试2: 移除 markdown 代码块标记
      let cleanedResponse = llmResponse;
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '');
      cleanedResponse = cleanedResponse.replace(/```\s*/g, '');
      cleanedResponse = cleanedResponse.trim();
      
      extractedData = JSON.parse(cleanedResponse);
      console.log('[AI提取] ✅ 移除 markdown 标记后解析成功');
    } catch (e2) {
      console.warn('[AI提取] 移除 markdown 标记后仍失败:', e2.message);
      
      try {
        // 尝试3: 提取 JSON 对象（使用更宽松的正则）
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          let jsonStr = jsonMatch[0];
          
          // 尝试修复常见的 JSON 错误
          // 修复末尾多余的逗号
          jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
          // 修复单引号
          jsonStr = jsonStr.replace(/'/g, '"');
          
          extractedData = JSON.parse(jsonStr);
          console.log('[AI提取] ✅ 提取并修复后解析成功');
        } else {
          throw new Error('无法从响应中提取 JSON 对象');
        }
      } catch (e3) {
        console.warn('[AI提取] ⚠️ 标准解析失败，尝试修复截断的 JSON...');
        
        try {
          // 尝试4: 修复被截断的 JSON（更智能的方法）
          let jsonStr = llmResponse;
          // 移除 markdown 代码块标记
          jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          
          // 策略：从后往前查找，找到最后一个完整的对象
          // 先找到所有完整的 videoId 对象
          const videoIdPattern = /"videoId"\s*:\s*"(\d+)"/g;
          const videoIds = [];
          let match;
          while ((match = videoIdPattern.exec(jsonStr)) !== null) {
            videoIds.push({ id: match[1], index: match.index });
          }
          
          if (videoIds.length === 0) {
            throw new Error('未找到任何视频ID');
          }
          
          // 从最后一个videoId开始，向前查找完整的对象
          let lastValidIndex = jsonStr.length;
          
          // 从后往前查找，找到最后一个完整的对象结束位置
          for (let i = videoIds.length - 1; i >= 0; i--) {
            const videoId = videoIds[i];
            const startIndex = videoId.index;
            
            // 向前查找这个对象的开始（找到最近的 {）
            let objStart = startIndex;
            let braceCount = 0;
            let foundStart = false;
            
            // 向前查找对象开始
            for (let j = startIndex; j >= 0; j--) {
              if (jsonStr[j] === '}') braceCount++;
              else if (jsonStr[j] === '{') {
                braceCount--;
                if (braceCount === 0) {
                  objStart = j;
                  foundStart = true;
                  break;
                }
              }
            }
            
            if (!foundStart) continue;
            
            // 向后查找这个对象的结束
            let objEnd = -1;
            braceCount = 0;
            let inString = false;
            let escapeNext = false;
            
            for (let j = objStart; j < jsonStr.length; j++) {
              const char = jsonStr[j];
              
              if (escapeNext) {
                escapeNext = false;
                continue;
              }
              
              if (char === '\\') {
                escapeNext = true;
                continue;
              }
              
              if (char === '"') {
                inString = !inString;
                continue;
              }
              
              if (inString) continue;
              
              if (char === '{') braceCount++;
              else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  objEnd = j + 1;
                  break;
                }
              }
            }
            
            if (objEnd > 0 && objEnd <= jsonStr.length) {
              // 验证这个对象是否完整（检查是否在字符串中间被截断）
              const objContent = jsonStr.substring(objStart, objEnd);
              
              // 检查对象是否包含未闭合的字符串
              let stringCount = 0;
              let isValid = true;
              for (let j = 0; j < objContent.length; j++) {
                if (objContent[j] === '\\') {
                  j++; // 跳过转义字符
                  continue;
                }
                if (objContent[j] === '"') {
                  stringCount++;
                }
              }
              
              // 如果字符串引号数量是偶数，说明字符串都闭合了
              if (stringCount % 2 === 0) {
                lastValidIndex = objEnd;
                break;
              }
            }
          }
          
          // 提取到最后一个完整对象为止的JSON
          let fixedJson = jsonStr.substring(0, lastValidIndex);
          
          // 移除最后一个对象后的逗号（如果有）
          fixedJson = fixedJson.replace(/,\s*$/, '');
          
          // 找到videos数组的开始位置
          const videosArrayStart = fixedJson.indexOf('"videos"');
          if (videosArrayStart > 0) {
            const arrayStart = fixedJson.indexOf('[', videosArrayStart);
            if (arrayStart > 0) {
              // 计算需要闭合的括号（只计算数组内的）
              const arrayContent = fixedJson.substring(arrayStart);
              const openBraces = (arrayContent.match(/\{/g) || []).length;
              const closeBraces = (arrayContent.match(/\}/g) || []).length;
              const openBrackets = (arrayContent.match(/\[/g) || []).length;
              const closeBrackets = (arrayContent.match(/\]/g) || []).length;
              
              // 添加缺失的闭合括号
              if (closeBraces < openBraces) {
                fixedJson += '}'.repeat(openBraces - closeBraces);
              }
              if (closeBrackets < openBrackets) {
                fixedJson += ']'.repeat(openBrackets - closeBrackets);
              }
              
              // 确保videos数组正确闭合
              if (!fixedJson.endsWith(']')) {
                fixedJson += ']';
              }
            }
          }
          
          // 确保根对象正确闭合
          const rootOpenBraces = (fixedJson.match(/\{/g) || []).length;
          const rootCloseBraces = (fixedJson.match(/\}/g) || []).length;
          if (rootCloseBraces < rootOpenBraces) {
            fixedJson += '}'.repeat(rootOpenBraces - rootCloseBraces);
          }
          
          // 修复常见的 JSON 错误
          fixedJson = fixedJson.replace(/,(\s*[}\]])/g, '$1'); // 移除末尾多余的逗号
          fixedJson = fixedJson.replace(/'/g, '"'); // 修复单引号
          
          // 确保JSON结构完整
          if (!fixedJson.trim().startsWith('{')) {
            const firstBrace = fixedJson.indexOf('{');
            if (firstBrace > 0) {
              fixedJson = fixedJson.substring(firstBrace);
            }
          }
          
          extractedData = JSON.parse(fixedJson);
          console.log('[AI提取] ✅ 修复截断 JSON 后解析成功');
          console.log(`[AI提取] ⚠️ 注意：JSON 可能被截断，只提取了前 ${extractedData.videos?.length || 0} 个视频`);
        } catch (e4) {
          console.error('[AI提取] ❌ 所有解析尝试都失败（包括修复截断 JSON）');
          console.error('[AI提取] 错误详情:', e4.message);
          console.error('[AI提取] 响应位置:', e4.message.match(/position (\d+)/)?.[1] || '未知');
          
          // 输出响应的一部分以便调试
          const errorPos = parseInt(e4.message.match(/position (\d+)/)?.[1] || '0');
          if (errorPos > 0) {
            const start = Math.max(0, errorPos - 200);
            const end = Math.min(llmResponse.length, errorPos + 200);
            console.error('[AI提取] 错误位置附近的响应内容:');
            console.error('='.repeat(80));
            console.error(llmResponse.substring(start, end));
            console.error('='.repeat(80));
          }
          
          throw new Error(`JSON 解析失败: ${e4.message}`);
        }
      }
    }
  }
  
  // 11. 输出原始提取数据并保存到日志（供检查）
  console.log('');
  console.log('='.repeat(80));
  console.log('LLM 原始提取数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(extractedData, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  try {
    const extractedLogPath = path.join(logsDir, `extracted-data-raw-${timestamp}.json`);
    fs.writeFileSync(extractedLogPath, JSON.stringify(extractedData, null, 2), 'utf-8');
    console.log(`[AI提取] 原始提取数据已保存到: ${extractedLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存原始提取数据失败:', e.message);
  }
  
  // 12. 验证和清理数据
  const videos = Array.isArray(extractedData.videos) ? extractedData.videos : [];
  const influencers = Array.isArray(extractedData.influencers) ? extractedData.influencers : [];
  
  // 清理和验证视频数据
  const cleanedVideos = videos.map(video => ({
    videoId: video.videoId || null,
    videoUrl: video.videoUrl || null,
    username: video.username || null,
    profileUrl: video.profileUrl || (video.username ? `https://www.tiktok.com/@${video.username}` : null),
    views: video.views || { count: 0, display: '0' },
    likes: video.likes || { count: 0, display: '0' },
    thumbnail: video.thumbnail || null
  }));
  
  // 清理和验证红人数据（去重）
  const seenUsernames = new Set();
  const cleanedInfluencers = influencers
    .filter(inf => inf.username && !seenUsernames.has(inf.username))
    .map(inf => {
      seenUsernames.add(inf.username);
      return {
        username: inf.username,
        displayName: inf.displayName || inf.username,
        profileUrl: inf.profileUrl || `https://www.tiktok.com/@${inf.username}`,
        avatarUrl: inf.avatarUrl || null,
        followers: inf.followers || null,
        bio: inf.bio || null,
        verified: inf.verified || false,
        platform: 'TikTok'
      };
    });
  
  const endTime = Date.now();
  const totalTime = ((endTime - startTime) / 1000).toFixed(2);
  
  console.log(`[AI提取] ✅ 提取完成！`);
  console.log(`[AI提取] 总耗时: ${totalTime} 秒`);
  console.log(`[AI提取] 提取到 ${cleanedVideos.length} 个视频`);
  console.log(`[AI提取] 提取到 ${cleanedInfluencers.length} 个红人`);
  
  // 14. 检测是否需要更新规则（去重后的用户名数量 < 10）
  const extractionResult = {
    videos: cleanedVideos,
    users: cleanedInfluencers
  };
  
  // 14.1 检测是否需要更新规则（去重后的用户名数量 < 10）
  const shouldUpdate = shouldTriggerRuleUpdate(extractionResult, 50);
  
  if (shouldUpdate) {
    console.log('[规则更新] ⚠️ 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    try {
      // 获取 HTML（用于 LLM 学习）
      const html = await page.content();
      const optimizedHTML = optimizeHTML(html);
      
      // 调用规则更新（最多重试 3 次）
      const updateResult = await updateRulesWithRetry(
        optimizedHTML, 
        extractionResult, 
        50,
        extractWithRules  // 规则引擎函数
      );
      
      if (updateResult.success) {
        console.log('[规则更新] ✅ 规则更新成功，版本:', updateResult.rules.version);
        console.log('[规则更新] 指标:', updateResult.metrics);
        
        // 可选：用新规则重新提取一次（如果需要）
        // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
        // console.log('[规则更新] 新规则提取结果:', newResult.videos.length, '个视频,', newResult.users.length, '个用户');
      } else {
        console.log('[规则更新] ⚠️ 规则更新失败（' + updateResult.attempts + ' 次尝试均失败），继续使用旧规则');
        console.log('[规则更新] 最后失败原因:', updateResult.lastError);
      }
    } catch (e) {
      console.error('[规则更新] ❌ 规则更新过程出错:', e.message);
      console.error('[规则更新] 错误堆栈:', e.stack);
    }
  }
  
  // 13. 输出清理后的完整数据（用于测试）
  console.log('');
  console.log('='.repeat(80));
  console.log('清理后的视频数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedVideos, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  console.log('='.repeat(80));
  console.log('清理后的红人数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedInfluencers, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  // 13.1 保存最终视频和红人数据到日志（供检查）
  try {
    const finalData = { videos: cleanedVideos, influencers: cleanedInfluencers };
    const finalLogPath = path.join(logsDir, `extracted-data-final-${timestamp}.json`);
    fs.writeFileSync(finalLogPath, JSON.stringify(finalData, null, 2), 'utf-8');
    console.log(`[AI提取] 最终视频和红人数据已保存到: ${finalLogPath}`);
    
    // 保存截断说明日志
    const summaryPath = path.join(logsDir, `extraction-summary-${timestamp}.txt`);
    const summary = [
      `=== TikTok 数据提取日志 ${timestamp} ===`,
      '',
      '【截断原因说明】',
      `finish_reason: ${finishReason}`,
      '- stop: 正常完成，未截断',
      '- length: 输出达到 max_tokens 限制被截断（API 默认或设置的输出 token 上限）',
      '- content_filter: 内容被过滤',
      '',
      '【Token 使用】',
      `输入 tokens: ${usage.prompt_tokens || '未知'}`,
      `输出 tokens: ${usage.completion_tokens || '未知'}`,
      '',
      '【数据统计】',
      `视频数量: ${cleanedVideos.length}`,
      `红人数量: ${cleanedInfluencers.length}`,
      `Markdown 长度: ${markdownLength} 字符`,
      `LLM 响应长度: ${llmResponse.length} 字符`,
      '',
      '【日志文件】',
      `- 精简 Markdown 输入: markdown-input-${timestamp}.md`,
      `- LLM 原始 JSON 响应: llm-response-raw-${timestamp}.json`,
      `- 解析后原始数据: extracted-data-raw-${timestamp}.json`,
      `- 最终清理数据: extracted-data-final-${timestamp}.json`
    ].join('\n');
    fs.writeFileSync(summaryPath, summary, 'utf-8');
    console.log(`[AI提取] 提取摘要已保存到: ${summaryPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存最终数据失败:', e.message);
  }
  
  // 14. 返回结果和统计信息
  return {
    videos: cleanedVideos,
    influencers: cleanedInfluencers,
    stats: {
      totalTime: totalTime,
      llmTime: ((llmEndTime - llmStartTime) / 1000).toFixed(2),
      htmlLength: {
        original: rawHTMLLength,
        optimized: optimizedHTMLLength,
        reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
      },
      tokenEstimate: {
        original: Math.ceil(rawHTMLLength / 4),
        optimized: Math.ceil(optimizedHTMLLength / 4),
        prompt: Math.ceil(promptLength / 4)
      },
      videoCount: cleanedVideos.length,
      influencerCount: cleanedInfluencers.length,
      optimizationSuggestions: optimizationInfo.suggestions
    }
  };
}

/**
 * 等待用户按 Enter 键
 */
function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

// 运行主函数
main().catch(console.error);
      // 提取关注数（following）
      const followingMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:following|关注)/i);
      if (followingMatch) {
        const num = parseFloat(followingMatch[1]);
        const unit = followingMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.following = { count: Math.round(count), display: followingMatch[0].trim() };
        }
      }
      
      // 提取获赞数（likes）
      const likesMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:likes?|获赞)/i);
      if (likesMatch) {
        const num = parseFloat(likesMatch[1]);
        const unit = likesMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.totalLikes = { count: Math.round(count), display: likesMatch[0].trim() };
        }
      }
      
      // 提取认证状态（verified badge）
      const verifiedPatterns = [
        /verified/i,
        /认证/i,
        /verified account/i,
        /checkmark/i,
        /✓/,
        /data-e2e=["']verified["']/i,
      ];
      
      for (const pattern of verifiedPatterns) {
        if (pattern.test(context)) {
          user.verified = true;
          break;
        }
      }
      
      // 提取头像（缩短 URL）
      const avatarMatches = context.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi);
      for (const avatarMatch of avatarMatches) {
        const imgSrc = avatarMatch[1];
        if (imgSrc && (imgSrc.includes('avatar') || imgSrc.includes('avt-') || imgSrc.includes('user') || 
            imgSrc.includes('profile') || imgSrc.includes('head'))) {
          user.avatarUrl = shortenCoverUrl(imgSrc);
          break;
        }
      }
      
      // 提取用户简介（bio）
      const bioPatterns = [
        /bio[:\s]+([^@#\n]{5,200})/i,
        /简介[:\s]+([^@#\n]{5,200})/i,
        /description[:\s]+([^@#\n]{5,200})/i,
      ];
      
      for (const pattern of bioPatterns) {
        const bioMatch = contextText.match(pattern);
        if (bioMatch && bioMatch[1]) {
          const bio = bioMatch[1].trim();
          if (bio.length >= 5 && bio.length <= 200 && !bio.match(/^\d+$/)) {
            user.bio = bio;
            break;
          }
        }
      }
    }
  });

  // 6. 构建精简的 Markdown（紧凑格式）
  let md = '';

  // 视频列表（仅输出 HTML 中实际存在的数据，不臆造）
  if (extractedData.videos.length > 0) {
    md += `# 视频列表 (${extractedData.videos.length}个)\n`;
    md += `注：搜索页仅展示点赞数，无播放量/评论/收藏\n\n`;
    extractedData.videos.forEach((video, idx) => {
      md += `## ${idx + 1}. 视频 ${video.videoId}\n`;
      md += `- URL: ${video.videoUrl}\n`;
      if (video.username) md += `- 作者: @${video.username}\n`;
      if (video.caption) {
        md += `- 文案: ${video.caption.substring(0, 200)}${video.caption.length > 200 ? '...' : ''}\n`;
      } else if (video.description) {
        md += `- 描述: ${video.description.substring(0, 200)}${video.description.length > 200 ? '...' : ''}\n`;
      }
      if (video.postedTime) md += `- 发布时间: ${video.postedTime}\n`;
      if (video.likes) md += `- 点赞: ${video.likes.display}\n`;
      if (video.hashtags && video.hashtags.length > 0) md += `- 标签: ${video.hashtags.join(' ')}\n`;
      if (video.mentions && video.mentions.length > 0) md += `- @提及: ${video.mentions.join(' ')}\n`;
      if (video.creator) md += `- 创作者: ${video.creator}\n`;
      if (video.music) md += `- 音乐: ${video.music.substring(0, 80)}${video.music.length > 80 ? '...' : ''}\n`;
      if (video.thumbnail) md += `- 封面: ${shortenCoverUrl(video.thumbnail)}\n`;
      md += '\n';
    });
  }

  // 用户列表（红人列表，含显示名、粉丝、认证状态等）
  if (extractedData.users.length > 0) {
    md += `# 用户列表 (${extractedData.users.length}个)\n\n`;
    extractedData.users.forEach((user, idx) => {
      md += `## ${idx + 1}. @${user.username}`;
      if (user.verified) {
        md += ` ✓`; // 认证标记
      }
      md += `\n`;
      md += `- 主页: ${user.profileUrl}\n`;
      // 仅在有有效显示名时输出（过滤 CSS 类名、HTML 属性值等）
      if (user.displayName && isValidDisplayName(user.displayName) && user.displayName !== user.username) {
        md += `- 显示名: ${user.displayName}\n`;
      }
      if (user.bio) {
        md += `- 简介: ${user.bio.substring(0, 150)}${user.bio.length > 150 ? '...' : ''}\n`;
      }
      if (user.followers) {
        md += `- 粉丝: ${user.followers.display} (${user.followers.count.toLocaleString()})\n`;
      }
      if (user.following) {
        md += `- 关注: ${user.following.display} (${user.following.count.toLocaleString()})\n`;
      }
      if (user.totalLikes) {
        md += `- 获赞: ${user.totalLikes.display} (${user.totalLikes.count.toLocaleString()})\n`;
      }
      if (user.avatarUrl) {
        md += `- 头像: ${shortenCoverUrl(user.avatarUrl)}\n`;
      }
      md += '\n';
    });
  }

  // 如果提取到的视频数量较少，回退到原始方法（但更精简）
  if (extractedData.videos.length < 10) {
    console.warn('[Markdown转换] 智能提取的视频数量较少，使用备用方法...');
    
    // 备用方法：提取包含 /video/ 的链接及其上下文
    let backupMd = html;
    
    // 移除所有 script/style
    backupMd = backupMd.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    backupMd = backupMd.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    
    // 只保留包含视频链接的部分
    const videoSections = [];
    const videoLinkMatches = html.matchAll(/<a[^>]*href=["'][^"']*\/video\/\d+[^"']*["'][^>]*>[\s\S]*?<\/a>/gi);
    
    for (const linkMatch of videoLinkMatches) {
      const linkHtml = linkMatch[0];
      // 提取链接和文本
      const hrefMatch = linkHtml.match(/href=["']([^"']+)["']/);
      const textMatch = linkHtml.match(/>([\s\S]*?)<\/a>/);
      
      if (hrefMatch) {
        const href = hrefMatch[1];
        const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        videoSections.push(`- [${text || '视频'}](${href})`);
      }
    }
    
    if (videoSections.length > 0) {
      md = '# 视频链接\n\n' + videoSections.join('\n') + '\n\n';
    }
  }

  return md.trim() || '未提取到视频信息';
}

/**
 * 使用 AI Agent 提取所有视频和红人信息（一次调用）
 * @param {Object} page - Playwright Page 对象
 * @returns {Promise<Object>} - { videos: Array, influencers: Array, stats: Object }
 */
async function extractVideosAndInfluencersWithAI(page) {
  console.log('[AI提取] [方案B] 开始使用 AI Agent 提取视频和红人信息（不依赖 CSS 选择器）...');
  const startTime = Date.now();
  
  // 1. 等待页面加载并滚动以触发懒加载，直到获取到至少50个视频
  console.log('[AI提取] 等待页面加载...');
  await page.waitForTimeout(3000);
  
  // 2. 滚动页面以加载更多内容，直到获取到至少50个视频
  console.log('[AI提取] 滚动页面以加载至少50个视频（模拟人类行为，降低被检测风险）...');
  const targetVideoCount = 50;
  let currentVideoCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 30; // 最多滚动30次，防止无限循环
  
  // 随机延迟函数：模拟人类的不规律行为
  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  // 滚动函数：使用平滑滚动和随机行为，模拟人类操作
  async function performScroll() {
    // 随机选择滚动方式（70% 使用鼠标滚轮，30% 使用键盘）
    const useMouseWheel = Math.random() > 0.3;
    
    if (useMouseWheel) {
      // 方法1: 鼠标滚轮滚动（最像人类操作）
      // 随机移动鼠标位置（模拟用户鼠标位置变化）
      const mouseX = randomDelay(300, 700);
      const mouseY = randomDelay(300, 600);
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(randomDelay(100, 300)); // 小停顿
      
      // 随机滚动距离（不完全滚动一屏，更像人类）
      const scrollDistance = randomDelay(400, 800);
      await page.mouse.wheel(0, scrollDistance);
      
      // 偶尔添加第二次小滚动（模拟用户调整位置）
      if (Math.random() > 0.7) {
        await page.waitForTimeout(randomDelay(200, 500));
        await page.mouse.wheel(0, randomDelay(100, 300));
      }
    } else {
      // 方法2: 键盘 PageDown（偶尔使用）
      await page.keyboard.press('PageDown');
    }
    
    // 方法3: 同时更新容器滚动位置（确保内容加载）
    const scrolled = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="search-result-list"]',
        '[data-e2e="search_video-item-list"]',
        '[class*="SearchResult"]',
        '[class*="search-result"]',
        'main',
        '[role="main"]',
        '.css-1qb12g8-DivContentContainer',
        '[class*="DivContentContainer"]',
        '[class*="ItemContainer"]'
      ];
      
      // 随机滚动距离（不完全一屏）
      const scrollAmount = Math.floor(window.innerHeight * (0.7 + Math.random() * 0.3));
      
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.scrollHeight > el.clientHeight) {
            el.scrollTop += scrollAmount;
            return { method: 'container', selector: sel };
          }
        } catch (e) {}
      }
      
      // 备用：滚动 window
      const before = window.scrollY;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      if (window.scrollY !== before) {
        return { method: 'window' };
      }
      
      document.documentElement.scrollTop += scrollAmount;
      return { method: 'documentElement' };
    });
    
    return scrolled;
  }
  
  while (currentVideoCount < targetVideoCount && scrollAttempts < maxScrollAttempts) {
    // 执行滚动（模拟人类行为）
    const scrollResult = await performScroll();
    if (scrollAttempts === 0) {
      console.log(`[AI提取] 使用的滚动方式: ${scrollResult?.method || 'mouse'}${scrollResult?.selector ? ` (${scrollResult.selector})` : ''}`);
    }
    
    // 随机等待时间（2-4秒），模拟人类阅读和浏览时间
    const waitTime = randomDelay(2000, 4000);
    await page.waitForTimeout(waitTime);
    
    // 偶尔添加额外停顿（10% 概率，模拟用户被内容吸引）
    if (Math.random() > 0.9) {
      const extraWait = randomDelay(1000, 3000);
      console.log(`[AI提取] 模拟用户浏览停顿 ${extraWait}ms...`);
      await page.waitForTimeout(extraWait);
    }
    
    // 检查当前页面上的视频数量
    currentVideoCount = await page.evaluate(() => {
      const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const uniqueVideoIds = new Set();
      videoLinks.forEach(link => {
        const href = link.getAttribute('href');
        const match = href.match(/\/video\/(\d+)/);
        if (match) {
          uniqueVideoIds.add(match[1]);
        }
      });
      return uniqueVideoIds.size;
    });
    
    scrollAttempts++;
    console.log(`[AI提取] 滚动第 ${scrollAttempts} 次，当前视频数量: ${currentVideoCount}`);
    
    // 如果视频数量没有增加，可能已经到底了
    if (scrollAttempts > 5 && currentVideoCount === 0) {
      console.warn('[AI提取] ⚠️ 未检测到视频，可能页面结构已变化');
      break;
    }
    
    // 如果连续多次滚动视频数不变，可能已到底
    if (scrollAttempts > 10 && scrollAttempts % 5 === 1) {
      const prevCount = currentVideoCount;
      await page.waitForTimeout(1000);
      const afterCount = await page.evaluate(() => {
        const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
        const uniqueVideoIds = new Set();
        videoLinks.forEach(link => {
          const href = link.getAttribute('href');
          const match = href.match(/\/video\/(\d+)/);
          if (match) uniqueVideoIds.add(match[1]);
        });
        return uniqueVideoIds.size;
      });
      if (afterCount === prevCount && prevCount > 0) {
        console.log(`[AI提取] 视频数量稳定在 ${prevCount}，可能已加载完毕`);
        if (scrollAttempts > 15) break;
      }
    }
  }
  
  console.log(`[AI提取] ✅ 滚动完成，共找到 ${currentVideoCount} 个视频`);
  
  // 3. 等待内容稳定
  await page.waitForTimeout(3000);
  
  // 4. 方案B：直接提取整个页面 HTML（不依赖 CSS 选择器和 DOM 结构识别）
  console.log('[AI提取] [方案B] 提取整个页面 HTML（不依赖选择器）...');
  
  const rawHTML = await page.content();
  const rawHTMLLength = rawHTML.length;
  console.log(`[AI提取] 原始 HTML 长度: ${rawHTMLLength.toLocaleString()} 字符`);
  
  // 5. 优化 HTML（减少大小，移除脚本、样式等）
  console.log('[AI提取] 优化 HTML（移除脚本、样式等无关内容）...');
  const optimizedHTML = optimizeHTML(rawHTML);
  const optimizedHTMLLength = optimizedHTML.length;
  console.log(`[AI提取] 优化后 HTML 长度: ${optimizedHTMLLength.toLocaleString()} 字符`);
  console.log(`[AI提取] HTML 减少: ${((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1)}%`);
  
  // 6. 获取优化建议
  const videoCount = (optimizedHTML.match(/\/video\//g) || []).length;
  const optimizationInfo = getOptimizationSuggestions(optimizedHTMLLength, videoCount);
  
  console.log(`[AI提取] 检测到约 ${videoCount} 个视频链接`);
  if (optimizationInfo.suggestions.length > 0) {
    console.log('[AI提取] 优化建议:');
    optimizationInfo.suggestions.forEach((suggestion, index) => {
      console.log(`  ${index + 1}. [${suggestion.level.toUpperCase()}] ${suggestion.message}`);
      if (suggestion.actions) {
        suggestion.actions.forEach(action => console.log(`     ${action}`));
      } else if (suggestion.action) {
        console.log(`     ${suggestion.action}`);
      }
    });
  }

  // 7.1 将 HTML 转换为精简 Markdown，进一步减少 Token 并提高可读性
  console.log('[AI提取] [方案B] 将页面 HTML 转为精简 Markdown...');
  const markdownContent = htmlToCompactMarkdown(optimizedHTML);
  const markdownLength = markdownContent.length;
  console.log(`[AI提取] Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Markdown Token 数: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
  
  // 保存精简 Markdown 到日志（供检查）
  const logsDir = path.join(__dirname, '../logs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const markdownLogPath = path.join(logsDir, `markdown-input-${timestamp}.md`);
    fs.writeFileSync(markdownLogPath, markdownContent, 'utf-8');
    console.log(`[AI提取] 精简 Markdown 已保存到: ${markdownLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 Markdown 日志失败:', e.message);
  }
  
  // ========== 测试模式：只测试 Markdown 转换，跳过 LLM 调用 ==========
  const TEST_MARKDOWN_ONLY = true; // 设置为 true 只测试 Markdown，false 继续调用 LLM
  
  if (TEST_MARKDOWN_ONLY) {
    console.log('');
    console.log('='.repeat(80));
    console.log('🧪 测试模式：只测试 Markdown 转换效果');
    console.log('='.repeat(80));
    console.log('');
    console.log('Markdown 内容预览（前2000字符）：');
    console.log('-'.repeat(80));
    console.log(markdownContent.substring(0, 2000));
    console.log('-'.repeat(80));
    console.log('');
    console.log(`✅ Markdown 转换完成！`);
    console.log(`📊 统计信息：`);
    console.log(`   - 视频数量: ${(markdownContent.match(/## \d+\. 视频/g) || []).length}`);
    console.log(`   - 用户数量: ${(markdownContent.match(/## \d+\. @/g) || []).length}`);
    console.log(`   - Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
    console.log(`   - 估算 Token: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
    console.log('');
    console.log('💡 提示：检查 logs/markdown-input-*.md 文件查看完整 Markdown');
    console.log('');
    
    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);
    
    return {
      videos: [],
      influencers: [],
      markdown: markdownContent,
      stats: {
        totalTime: totalTime,
        llmTime: '0',
        htmlLength: {
          original: rawHTMLLength,
          optimized: optimizedHTMLLength,
          reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
        },
        tokenEstimate: {
          original: Math.ceil(rawHTMLLength / 4),
          optimized: Math.ceil(optimizedHTMLLength / 4),
          prompt: Math.ceil(markdownLength / 4),
          markdown: Math.ceil(markdownLength / 4)
        },
        videoCount: (markdownContent.match(/## \d+\. 视频/g) || []).length,
        influencerCount: (markdownContent.match(/## \d+\. @/g) || []).length,
        optimizationSuggestions: optimizationInfo.suggestions
      }
    };
  }
  
  // ========== 正常模式：继续调用 LLM ==========
  
  // 8. 构建 LLM Prompt（基于精简 Markdown，方案B）
  console.log('[AI提取] [方案B] 构建 LLM Prompt（让 LLM 自己识别视频）...');
  const prompt = `你是一个专业的社交媒体数据分析专家。请分析下面这个 TikTok 搜索结果页面的完整内容（Markdown 格式），**自己识别并提取**所有视频和对应的红人（创作者）信息。

**方案B说明**：
- 我们直接提供了整个页面的精简 Markdown 内容
- 你需要自己识别哪些是视频卡片，哪些是视频信息，哪些是红人信息
- 不依赖特定的 HTML 结构或 CSS 选择器
- 通过内容语义来识别（如视频链接、用户名链接、播放量、点赞数等）

下面是已经提取并转换好的**精简版 Markdown 内容**（只包含与视频和红人相关的信息，不包含样式、脚本等）：

${markdownContent.substring(0, 200000)}  // 限制长度避免超过 token 限制

请**自己识别并提取**以下信息：

**视频信息**（每个视频）：
1. videoId: 视频ID（从链接中提取，格式如 /video/1234567890）
2. videoUrl: 视频完整链接（如 https://www.tiktok.com/@username/video/1234567890）
3. username: 作者用户名（从链接中提取，格式如 /@username，只返回 username 部分，不要包含 @ 符号）
4. profileUrl: 作者主页链接（如 https://www.tiktok.com/@username）
5. views: 播放量（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，如 { count: 1200000, display: "1.2M" }）
6. likes: 点赞数（如果有显示，格式同上）
7. thumbnail: 视频封面图片 URL

**红人信息**（每个红人，去重）：
1. username: 用户名（从链接中提取）
2. displayName: 显示名称（创作者的名字）
3. profileUrl: 个人主页链接
4. avatarUrl: 头像图片 URL
5. followers: 粉丝数（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，否则为 null）
6. bio: 个人简介（如果有）
7. verified: 是否认证（true/false）

**重要提示**：
- 提取页面中所有视频，有多少条就提取多少条（20条就20条，50条就50条）
- 用户名必须从链接中提取，格式为 /@username，只返回 username 部分
- 所有字段如果找不到，返回 null 或空字符串
- 播放量、点赞数、粉丝数需要解析（如 "1.2M" → { count: 1200000, display: "1.2M" }）
- 红人信息需要去重（相同用户名只保留一个）
- 只返回 JSON 格式，不要其他文字说明

请返回 JSON 格式：
{
  "videos": [
    {
      "videoId": "视频ID或null",
      "videoUrl": "完整URL或null",
      "username": "用户名或null",
      "profileUrl": "主页URL或null",
      "views": { "count": 数字或0, "display": "显示文本或'0'" },
      "likes": { "count": 数字或0, "display": "显示文本或'0'" },
      "thumbnail": "图片URL或null"
    },
    ...
  ],
  "influencers": [
    {
      "username": "用户名或null",
      "displayName": "显示名称或null",
      "profileUrl": "主页URL或null",
      "avatarUrl": "头像URL或null",
      "followers": { "count": 数字或null, "display": "显示文本或null" },
      "bio": "简介或null",
      "verified": true或false,
      "platform": "TikTok"
    },
    ...
  ]
}`;

  const promptLength = prompt.length;
  console.log(`[AI提取] Prompt 长度: ${promptLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Token 数: ${Math.ceil(promptLength / 4).toLocaleString()}`);
  
  // 9. 调用 LLM（DeepSeek API 最大支持 8192 tokens）
  console.log('[AI提取] 调用 LLM API（max_tokens=8192）...');
  const llmStartTime = Date.now();
  const llmResult = await callDeepSeekLLM(
    [{ role: "user", content: prompt }],
    "你是一个专业的社交媒体数据分析专家，擅长从网页 HTML 中提取结构化信息。只返回 JSON 格式，不要其他文字。",
    { maxTokens: 8192, returnFullResponse: true }
  );
  const llmEndTime = Date.now();
  const llmResponse = llmResult.content;
  const finishReason = llmResult.finishReason;
  const usage = llmResult.usage || {};
  
  console.log(`[AI提取] LLM 调用耗时: ${((llmEndTime - llmStartTime) / 1000).toFixed(2)} 秒`);
  console.log(`[AI提取] LLM 响应长度: ${llmResponse.length.toLocaleString()} 字符`);
  console.log(`[AI提取] finish_reason: ${finishReason}（length=输出被 token 限制截断）`);
  console.log(`[AI提取] Token 使用: 输入=${usage.prompt_tokens || '未知'}, 输出=${usage.completion_tokens || '未知'}`);
  console.log(`[AI提取] LLM 响应预览: ${llmResponse.substring(0, 300)}...`);
  
  if (finishReason === 'length') {
    console.warn('[AI提取] ⚠️ 输出被 token 限制截断！请增加 max_tokens 或减少视频数量');
  }
  
  // 10. 保存原始 LLM 响应到日志（供检查）
  const responseLogPath = path.join(logsDir, `llm-response-raw-${timestamp}.json`);
  try {
    fs.writeFileSync(responseLogPath, llmResponse, 'utf-8');
    console.log(`[AI提取] LLM 原始响应已保存到: ${responseLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 LLM 响应失败:', e.message);
  }
  
  // 10. 解析 JSON 响应（改进的解析逻辑）
  console.log('[AI提取] 解析 LLM 响应...');
  let extractedData;
  let parseError = null;
  
  try {
    // 尝试1: 直接解析
    extractedData = JSON.parse(llmResponse);
    console.log('[AI提取] ✅ 直接解析成功');
  } catch (e) {
    parseError = e;
    console.warn('[AI提取] 直接解析失败:', e.message);
    
    try {
      // 尝试2: 移除 markdown 代码块标记
      let cleanedResponse = llmResponse;
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '');
      cleanedResponse = cleanedResponse.replace(/```\s*/g, '');
      cleanedResponse = cleanedResponse.trim();
      
      extractedData = JSON.parse(cleanedResponse);
      console.log('[AI提取] ✅ 移除 markdown 标记后解析成功');
    } catch (e2) {
      console.warn('[AI提取] 移除 markdown 标记后仍失败:', e2.message);
      
      try {
        // 尝试3: 提取 JSON 对象（使用更宽松的正则）
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          let jsonStr = jsonMatch[0];
          
          // 尝试修复常见的 JSON 错误
          // 修复末尾多余的逗号
          jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
          // 修复单引号
          jsonStr = jsonStr.replace(/'/g, '"');
          
          extractedData = JSON.parse(jsonStr);
          console.log('[AI提取] ✅ 提取并修复后解析成功');
        } else {
          throw new Error('无法从响应中提取 JSON 对象');
        }
      } catch (e3) {
        console.warn('[AI提取] ⚠️ 标准解析失败，尝试修复截断的 JSON...');
        
        try {
          // 尝试4: 修复被截断的 JSON（更智能的方法）
          let jsonStr = llmResponse;
          // 移除 markdown 代码块标记
          jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          
          // 策略：从后往前查找，找到最后一个完整的对象
          // 先找到所有完整的 videoId 对象
          const videoIdPattern = /"videoId"\s*:\s*"(\d+)"/g;
          const videoIds = [];
          let match;
          while ((match = videoIdPattern.exec(jsonStr)) !== null) {
            videoIds.push({ id: match[1], index: match.index });
          }
          
          if (videoIds.length === 0) {
            throw new Error('未找到任何视频ID');
          }
          
          // 从最后一个videoId开始，向前查找完整的对象
          let lastValidIndex = jsonStr.length;
          
          // 从后往前查找，找到最后一个完整的对象结束位置
          for (let i = videoIds.length - 1; i >= 0; i--) {
            const videoId = videoIds[i];
            const startIndex = videoId.index;
            
            // 向前查找这个对象的开始（找到最近的 {）
            let objStart = startIndex;
            let braceCount = 0;
            let foundStart = false;
            
            // 向前查找对象开始
            for (let j = startIndex; j >= 0; j--) {
              if (jsonStr[j] === '}') braceCount++;
              else if (jsonStr[j] === '{') {
                braceCount--;
                if (braceCount === 0) {
                  objStart = j;
                  foundStart = true;
                  break;
                }
              }
            }
            
            if (!foundStart) continue;
            
            // 向后查找这个对象的结束
            let objEnd = -1;
            braceCount = 0;
            let inString = false;
            let escapeNext = false;
            
            for (let j = objStart; j < jsonStr.length; j++) {
              const char = jsonStr[j];
              
              if (escapeNext) {
                escapeNext = false;
                continue;
              }
              
              if (char === '\\') {
                escapeNext = true;
                continue;
              }
              
              if (char === '"') {
                inString = !inString;
                continue;
              }
              
              if (inString) continue;
              
              if (char === '{') braceCount++;
              else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  objEnd = j + 1;
                  break;
                }
              }
            }
            
            if (objEnd > 0 && objEnd <= jsonStr.length) {
              // 验证这个对象是否完整（检查是否在字符串中间被截断）
              const objContent = jsonStr.substring(objStart, objEnd);
              
              // 检查对象是否包含未闭合的字符串
              let stringCount = 0;
              let isValid = true;
              for (let j = 0; j < objContent.length; j++) {
                if (objContent[j] === '\\') {
                  j++; // 跳过转义字符
                  continue;
                }
                if (objContent[j] === '"') {
                  stringCount++;
                }
              }
              
              // 如果字符串引号数量是偶数，说明字符串都闭合了
              if (stringCount % 2 === 0) {
                lastValidIndex = objEnd;
                break;
              }
            }
          }
          
          // 提取到最后一个完整对象为止的JSON
          let fixedJson = jsonStr.substring(0, lastValidIndex);
          
          // 移除最后一个对象后的逗号（如果有）
          fixedJson = fixedJson.replace(/,\s*$/, '');
          
          // 找到videos数组的开始位置
          const videosArrayStart = fixedJson.indexOf('"videos"');
          if (videosArrayStart > 0) {
            const arrayStart = fixedJson.indexOf('[', videosArrayStart);
            if (arrayStart > 0) {
              // 计算需要闭合的括号（只计算数组内的）
              const arrayContent = fixedJson.substring(arrayStart);
              const openBraces = (arrayContent.match(/\{/g) || []).length;
              const closeBraces = (arrayContent.match(/\}/g) || []).length;
              const openBrackets = (arrayContent.match(/\[/g) || []).length;
              const closeBrackets = (arrayContent.match(/\]/g) || []).length;
              
              // 添加缺失的闭合括号
              if (closeBraces < openBraces) {
                fixedJson += '}'.repeat(openBraces - closeBraces);
              }
              if (closeBrackets < openBrackets) {
                fixedJson += ']'.repeat(openBrackets - closeBrackets);
              }
              
              // 确保videos数组正确闭合
              if (!fixedJson.endsWith(']')) {
                fixedJson += ']';
              }
            }
          }
          
          // 确保根对象正确闭合
          const rootOpenBraces = (fixedJson.match(/\{/g) || []).length;
          const rootCloseBraces = (fixedJson.match(/\}/g) || []).length;
          if (rootCloseBraces < rootOpenBraces) {
            fixedJson += '}'.repeat(rootOpenBraces - rootCloseBraces);
          }
          
          // 修复常见的 JSON 错误
          fixedJson = fixedJson.replace(/,(\s*[}\]])/g, '$1'); // 移除末尾多余的逗号
          fixedJson = fixedJson.replace(/'/g, '"'); // 修复单引号
          
          // 确保JSON结构完整
          if (!fixedJson.trim().startsWith('{')) {
            const firstBrace = fixedJson.indexOf('{');
            if (firstBrace > 0) {
              fixedJson = fixedJson.substring(firstBrace);
            }
          }
          
          extractedData = JSON.parse(fixedJson);
          console.log('[AI提取] ✅ 修复截断 JSON 后解析成功');
          console.log(`[AI提取] ⚠️ 注意：JSON 可能被截断，只提取了前 ${extractedData.videos?.length || 0} 个视频`);
        } catch (e4) {
          console.error('[AI提取] ❌ 所有解析尝试都失败（包括修复截断 JSON）');
          console.error('[AI提取] 错误详情:', e4.message);
          console.error('[AI提取] 响应位置:', e4.message.match(/position (\d+)/)?.[1] || '未知');
          
          // 输出响应的一部分以便调试
          const errorPos = parseInt(e4.message.match(/position (\d+)/)?.[1] || '0');
          if (errorPos > 0) {
            const start = Math.max(0, errorPos - 200);
            const end = Math.min(llmResponse.length, errorPos + 200);
            console.error('[AI提取] 错误位置附近的响应内容:');
            console.error('='.repeat(80));
            console.error(llmResponse.substring(start, end));
            console.error('='.repeat(80));
          }
          
          throw new Error(`JSON 解析失败: ${e4.message}`);
        }
      }
    }
  }
  
  // 11. 输出原始提取数据并保存到日志（供检查）
  console.log('');
  console.log('='.repeat(80));
  console.log('LLM 原始提取数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(extractedData, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  try {
    const extractedLogPath = path.join(logsDir, `extracted-data-raw-${timestamp}.json`);
    fs.writeFileSync(extractedLogPath, JSON.stringify(extractedData, null, 2), 'utf-8');
    console.log(`[AI提取] 原始提取数据已保存到: ${extractedLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存原始提取数据失败:', e.message);
  }
  
  // 12. 验证和清理数据
  const videos = Array.isArray(extractedData.videos) ? extractedData.videos : [];
  const influencers = Array.isArray(extractedData.influencers) ? extractedData.influencers : [];
  
  // 清理和验证视频数据
  const cleanedVideos = videos.map(video => ({
    videoId: video.videoId || null,
    videoUrl: video.videoUrl || null,
    username: video.username || null,
    profileUrl: video.profileUrl || (video.username ? `https://www.tiktok.com/@${video.username}` : null),
    views: video.views || { count: 0, display: '0' },
    likes: video.likes || { count: 0, display: '0' },
    thumbnail: video.thumbnail || null
  }));
  
  // 清理和验证红人数据（去重）
  const seenUsernames = new Set();
  const cleanedInfluencers = influencers
    .filter(inf => inf.username && !seenUsernames.has(inf.username))
    .map(inf => {
      seenUsernames.add(inf.username);
      return {
        username: inf.username,
        displayName: inf.displayName || inf.username,
        profileUrl: inf.profileUrl || `https://www.tiktok.com/@${inf.username}`,
        avatarUrl: inf.avatarUrl || null,
        followers: inf.followers || null,
        bio: inf.bio || null,
        verified: inf.verified || false,
        platform: 'TikTok'
      };
    });
  
  const endTime = Date.now();
  const totalTime = ((endTime - startTime) / 1000).toFixed(2);
  
  console.log(`[AI提取] ✅ 提取完成！`);
  console.log(`[AI提取] 总耗时: ${totalTime} 秒`);
  console.log(`[AI提取] 提取到 ${cleanedVideos.length} 个视频`);
  console.log(`[AI提取] 提取到 ${cleanedInfluencers.length} 个红人`);
  
  // 14. 检测是否需要更新规则（去重后的用户名数量 < 10）
  const extractionResult = {
    videos: cleanedVideos,
    users: cleanedInfluencers
  };
  
  // 14.1 检测是否需要更新规则（去重后的用户名数量 < 10）
  const shouldUpdate = shouldTriggerRuleUpdate(extractionResult, 50);
  
  if (shouldUpdate) {
    console.log('[规则更新] ⚠️ 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    try {
      // 获取 HTML（用于 LLM 学习）
      const html = await page.content();
      const optimizedHTML = optimizeHTML(html);
      
      // 调用规则更新（最多重试 3 次）
      const updateResult = await updateRulesWithRetry(
        optimizedHTML, 
        extractionResult, 
        50,
        extractWithRules  // 规则引擎函数
      );
      
      if (updateResult.success) {
        console.log('[规则更新] ✅ 规则更新成功，版本:', updateResult.rules.version);
        console.log('[规则更新] 指标:', updateResult.metrics);
        
        // 可选：用新规则重新提取一次（如果需要）
        // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
        // console.log('[规则更新] 新规则提取结果:', newResult.videos.length, '个视频,', newResult.users.length, '个用户');
      } else {
        console.log('[规则更新] ⚠️ 规则更新失败（' + updateResult.attempts + ' 次尝试均失败），继续使用旧规则');
        console.log('[规则更新] 最后失败原因:', updateResult.lastError);
      }
    } catch (e) {
      console.error('[规则更新] ❌ 规则更新过程出错:', e.message);
      console.error('[规则更新] 错误堆栈:', e.stack);
    }
  }
  
  // 13. 输出清理后的完整数据（用于测试）
  console.log('');
  console.log('='.repeat(80));
  console.log('清理后的视频数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedVideos, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  console.log('='.repeat(80));
  console.log('清理后的红人数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedInfluencers, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  // 13.1 保存最终视频和红人数据到日志（供检查）
  try {
    const finalData = { videos: cleanedVideos, influencers: cleanedInfluencers };
    const finalLogPath = path.join(logsDir, `extracted-data-final-${timestamp}.json`);
    fs.writeFileSync(finalLogPath, JSON.stringify(finalData, null, 2), 'utf-8');
    console.log(`[AI提取] 最终视频和红人数据已保存到: ${finalLogPath}`);
    
    // 保存截断说明日志
    const summaryPath = path.join(logsDir, `extraction-summary-${timestamp}.txt`);
    const summary = [
      `=== TikTok 数据提取日志 ${timestamp} ===`,
      '',
      '【截断原因说明】',
      `finish_reason: ${finishReason}`,
      '- stop: 正常完成，未截断',
      '- length: 输出达到 max_tokens 限制被截断（API 默认或设置的输出 token 上限）',
      '- content_filter: 内容被过滤',
      '',
      '【Token 使用】',
      `输入 tokens: ${usage.prompt_tokens || '未知'}`,
      `输出 tokens: ${usage.completion_tokens || '未知'}`,
      '',
      '【数据统计】',
      `视频数量: ${cleanedVideos.length}`,
      `红人数量: ${cleanedInfluencers.length}`,
      `Markdown 长度: ${markdownLength} 字符`,
      `LLM 响应长度: ${llmResponse.length} 字符`,
      '',
      '【日志文件】',
      `- 精简 Markdown 输入: markdown-input-${timestamp}.md`,
      `- LLM 原始 JSON 响应: llm-response-raw-${timestamp}.json`,
      `- 解析后原始数据: extracted-data-raw-${timestamp}.json`,
      `- 最终清理数据: extracted-data-final-${timestamp}.json`
    ].join('\n');
    fs.writeFileSync(summaryPath, summary, 'utf-8');
    console.log(`[AI提取] 提取摘要已保存到: ${summaryPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存最终数据失败:', e.message);
  }
  
  // 14. 返回结果和统计信息
  return {
    videos: cleanedVideos,
    influencers: cleanedInfluencers,
    stats: {
      totalTime: totalTime,
      llmTime: ((llmEndTime - llmStartTime) / 1000).toFixed(2),
      htmlLength: {
        original: rawHTMLLength,
        optimized: optimizedHTMLLength,
        reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
      },
      tokenEstimate: {
        original: Math.ceil(rawHTMLLength / 4),
        optimized: Math.ceil(optimizedHTMLLength / 4),
        prompt: Math.ceil(promptLength / 4)
      },
      videoCount: cleanedVideos.length,
      influencerCount: cleanedInfluencers.length,
      optimizationSuggestions: optimizationInfo.suggestions
    }
  };
}

/**
 * 等待用户按 Enter 键
 */
function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

// 运行主函数
main().catch(console.error);
      // 提取关注数（following）
      const followingMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:following|关注)/i);
      if (followingMatch) {
        const num = parseFloat(followingMatch[1]);
        const unit = followingMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.following = { count: Math.round(count), display: followingMatch[0].trim() };
        }
      }
      
      // 提取获赞数（likes）
      const likesMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:likes?|获赞)/i);
      if (likesMatch) {
        const num = parseFloat(likesMatch[1]);
        const unit = likesMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.totalLikes = { count: Math.round(count), display: likesMatch[0].trim() };
        }
      }
      
      // 提取认证状态（verified badge）
      const verifiedPatterns = [
        /verified/i,
        /认证/i,
        /verified account/i,
        /checkmark/i,
        /✓/,
        /data-e2e=["']verified["']/i,
      ];
      
      for (const pattern of verifiedPatterns) {
        if (pattern.test(context)) {
          user.verified = true;
          break;
        }
      }
      
      // 提取头像（缩短 URL）
      const avatarMatches = context.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi);
      for (const avatarMatch of avatarMatches) {
        const imgSrc = avatarMatch[1];
        if (imgSrc && (imgSrc.includes('avatar') || imgSrc.includes('avt-') || imgSrc.includes('user') || 
            imgSrc.includes('profile') || imgSrc.includes('head'))) {
          user.avatarUrl = shortenCoverUrl(imgSrc);
          break;
        }
      }
      
      // 提取用户简介（bio）
      const bioPatterns = [
        /bio[:\s]+([^@#\n]{5,200})/i,
        /简介[:\s]+([^@#\n]{5,200})/i,
        /description[:\s]+([^@#\n]{5,200})/i,
      ];
      
      for (const pattern of bioPatterns) {
        const bioMatch = contextText.match(pattern);
        if (bioMatch && bioMatch[1]) {
          const bio = bioMatch[1].trim();
          if (bio.length >= 5 && bio.length <= 200 && !bio.match(/^\d+$/)) {
            user.bio = bio;
            break;
          }
        }
      }
    }
  });

  // 6. 构建精简的 Markdown（紧凑格式）
  let md = '';

  // 视频列表（仅输出 HTML 中实际存在的数据，不臆造）
  if (extractedData.videos.length > 0) {
    md += `# 视频列表 (${extractedData.videos.length}个)\n`;
    md += `注：搜索页仅展示点赞数，无播放量/评论/收藏\n\n`;
    extractedData.videos.forEach((video, idx) => {
      md += `## ${idx + 1}. 视频 ${video.videoId}\n`;
      md += `- URL: ${video.videoUrl}\n`;
      if (video.username) md += `- 作者: @${video.username}\n`;
      if (video.caption) {
        md += `- 文案: ${video.caption.substring(0, 200)}${video.caption.length > 200 ? '...' : ''}\n`;
      } else if (video.description) {
        md += `- 描述: ${video.description.substring(0, 200)}${video.description.length > 200 ? '...' : ''}\n`;
      }
      if (video.postedTime) md += `- 发布时间: ${video.postedTime}\n`;
      if (video.likes) md += `- 点赞: ${video.likes.display}\n`;
      if (video.hashtags && video.hashtags.length > 0) md += `- 标签: ${video.hashtags.join(' ')}\n`;
      if (video.mentions && video.mentions.length > 0) md += `- @提及: ${video.mentions.join(' ')}\n`;
      if (video.creator) md += `- 创作者: ${video.creator}\n`;
      if (video.music) md += `- 音乐: ${video.music.substring(0, 80)}${video.music.length > 80 ? '...' : ''}\n`;
      if (video.thumbnail) md += `- 封面: ${shortenCoverUrl(video.thumbnail)}\n`;
      md += '\n';
    });
  }

  // 用户列表（红人列表，含显示名、粉丝、认证状态等）
  if (extractedData.users.length > 0) {
    md += `# 用户列表 (${extractedData.users.length}个)\n\n`;
    extractedData.users.forEach((user, idx) => {
      md += `## ${idx + 1}. @${user.username}`;
      if (user.verified) {
        md += ` ✓`; // 认证标记
      }
      md += `\n`;
      md += `- 主页: ${user.profileUrl}\n`;
      // 仅在有有效显示名时输出（过滤 CSS 类名、HTML 属性值等）
      if (user.displayName && isValidDisplayName(user.displayName) && user.displayName !== user.username) {
        md += `- 显示名: ${user.displayName}\n`;
      }
      if (user.bio) {
        md += `- 简介: ${user.bio.substring(0, 150)}${user.bio.length > 150 ? '...' : ''}\n`;
      }
      if (user.followers) {
        md += `- 粉丝: ${user.followers.display} (${user.followers.count.toLocaleString()})\n`;
      }
      if (user.following) {
        md += `- 关注: ${user.following.display} (${user.following.count.toLocaleString()})\n`;
      }
      if (user.totalLikes) {
        md += `- 获赞: ${user.totalLikes.display} (${user.totalLikes.count.toLocaleString()})\n`;
      }
      if (user.avatarUrl) {
        md += `- 头像: ${shortenCoverUrl(user.avatarUrl)}\n`;
      }
      md += '\n';
    });
  }

  // 如果提取到的视频数量较少，回退到原始方法（但更精简）
  if (extractedData.videos.length < 10) {
    console.warn('[Markdown转换] 智能提取的视频数量较少，使用备用方法...');
    
    // 备用方法：提取包含 /video/ 的链接及其上下文
    let backupMd = html;
    
    // 移除所有 script/style
    backupMd = backupMd.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    backupMd = backupMd.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    
    // 只保留包含视频链接的部分
    const videoSections = [];
    const videoLinkMatches = html.matchAll(/<a[^>]*href=["'][^"']*\/video\/\d+[^"']*["'][^>]*>[\s\S]*?<\/a>/gi);
    
    for (const linkMatch of videoLinkMatches) {
      const linkHtml = linkMatch[0];
      // 提取链接和文本
      const hrefMatch = linkHtml.match(/href=["']([^"']+)["']/);
      const textMatch = linkHtml.match(/>([\s\S]*?)<\/a>/);
      
      if (hrefMatch) {
        const href = hrefMatch[1];
        const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        videoSections.push(`- [${text || '视频'}](${href})`);
      }
    }
    
    if (videoSections.length > 0) {
      md = '# 视频链接\n\n' + videoSections.join('\n') + '\n\n';
    }
  }

  return md.trim() || '未提取到视频信息';
}

/**
 * 使用 AI Agent 提取所有视频和红人信息（一次调用）
 * @param {Object} page - Playwright Page 对象
 * @returns {Promise<Object>} - { videos: Array, influencers: Array, stats: Object }
 */
async function extractVideosAndInfluencersWithAI(page) {
  console.log('[AI提取] [方案B] 开始使用 AI Agent 提取视频和红人信息（不依赖 CSS 选择器）...');
  const startTime = Date.now();
  
  // 1. 等待页面加载并滚动以触发懒加载，直到获取到至少50个视频
  console.log('[AI提取] 等待页面加载...');
  await page.waitForTimeout(3000);
  
  // 2. 滚动页面以加载更多内容，直到获取到至少50个视频
  console.log('[AI提取] 滚动页面以加载至少50个视频（模拟人类行为，降低被检测风险）...');
  const targetVideoCount = 50;
  let currentVideoCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 30; // 最多滚动30次，防止无限循环
  
  // 随机延迟函数：模拟人类的不规律行为
  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  // 滚动函数：使用平滑滚动和随机行为，模拟人类操作
  async function performScroll() {
    // 随机选择滚动方式（70% 使用鼠标滚轮，30% 使用键盘）
    const useMouseWheel = Math.random() > 0.3;
    
    if (useMouseWheel) {
      // 方法1: 鼠标滚轮滚动（最像人类操作）
      // 随机移动鼠标位置（模拟用户鼠标位置变化）
      const mouseX = randomDelay(300, 700);
      const mouseY = randomDelay(300, 600);
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(randomDelay(100, 300)); // 小停顿
      
      // 随机滚动距离（不完全滚动一屏，更像人类）
      const scrollDistance = randomDelay(400, 800);
      await page.mouse.wheel(0, scrollDistance);
      
      // 偶尔添加第二次小滚动（模拟用户调整位置）
      if (Math.random() > 0.7) {
        await page.waitForTimeout(randomDelay(200, 500));
        await page.mouse.wheel(0, randomDelay(100, 300));
      }
    } else {
      // 方法2: 键盘 PageDown（偶尔使用）
      await page.keyboard.press('PageDown');
    }
    
    // 方法3: 同时更新容器滚动位置（确保内容加载）
    const scrolled = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="search-result-list"]',
        '[data-e2e="search_video-item-list"]',
        '[class*="SearchResult"]',
        '[class*="search-result"]',
        'main',
        '[role="main"]',
        '.css-1qb12g8-DivContentContainer',
        '[class*="DivContentContainer"]',
        '[class*="ItemContainer"]'
      ];
      
      // 随机滚动距离（不完全一屏）
      const scrollAmount = Math.floor(window.innerHeight * (0.7 + Math.random() * 0.3));
      
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.scrollHeight > el.clientHeight) {
            el.scrollTop += scrollAmount;
            return { method: 'container', selector: sel };
          }
        } catch (e) {}
      }
      
      // 备用：滚动 window
      const before = window.scrollY;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      if (window.scrollY !== before) {
        return { method: 'window' };
      }
      
      document.documentElement.scrollTop += scrollAmount;
      return { method: 'documentElement' };
    });
    
    return scrolled;
  }
  
  while (currentVideoCount < targetVideoCount && scrollAttempts < maxScrollAttempts) {
    // 执行滚动（模拟人类行为）
    const scrollResult = await performScroll();
    if (scrollAttempts === 0) {
      console.log(`[AI提取] 使用的滚动方式: ${scrollResult?.method || 'mouse'}${scrollResult?.selector ? ` (${scrollResult.selector})` : ''}`);
    }
    
    // 随机等待时间（2-4秒），模拟人类阅读和浏览时间
    const waitTime = randomDelay(2000, 4000);
    await page.waitForTimeout(waitTime);
    
    // 偶尔添加额外停顿（10% 概率，模拟用户被内容吸引）
    if (Math.random() > 0.9) {
      const extraWait = randomDelay(1000, 3000);
      console.log(`[AI提取] 模拟用户浏览停顿 ${extraWait}ms...`);
      await page.waitForTimeout(extraWait);
    }
    
    // 检查当前页面上的视频数量
    currentVideoCount = await page.evaluate(() => {
      const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const uniqueVideoIds = new Set();
      videoLinks.forEach(link => {
        const href = link.getAttribute('href');
        const match = href.match(/\/video\/(\d+)/);
        if (match) {
          uniqueVideoIds.add(match[1]);
        }
      });
      return uniqueVideoIds.size;
    });
    
    scrollAttempts++;
    console.log(`[AI提取] 滚动第 ${scrollAttempts} 次，当前视频数量: ${currentVideoCount}`);
    
    // 如果视频数量没有增加，可能已经到底了
    if (scrollAttempts > 5 && currentVideoCount === 0) {
      console.warn('[AI提取] ⚠️ 未检测到视频，可能页面结构已变化');
      break;
    }
    
    // 如果连续多次滚动视频数不变，可能已到底
    if (scrollAttempts > 10 && scrollAttempts % 5 === 1) {
      const prevCount = currentVideoCount;
      await page.waitForTimeout(1000);
      const afterCount = await page.evaluate(() => {
        const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
        const uniqueVideoIds = new Set();
        videoLinks.forEach(link => {
          const href = link.getAttribute('href');
          const match = href.match(/\/video\/(\d+)/);
          if (match) uniqueVideoIds.add(match[1]);
        });
        return uniqueVideoIds.size;
      });
      if (afterCount === prevCount && prevCount > 0) {
        console.log(`[AI提取] 视频数量稳定在 ${prevCount}，可能已加载完毕`);
        if (scrollAttempts > 15) break;
      }
    }
  }
  
  console.log(`[AI提取] ✅ 滚动完成，共找到 ${currentVideoCount} 个视频`);
  
  // 3. 等待内容稳定
  await page.waitForTimeout(3000);
  
  // 4. 方案B：直接提取整个页面 HTML（不依赖 CSS 选择器和 DOM 结构识别）
  console.log('[AI提取] [方案B] 提取整个页面 HTML（不依赖选择器）...');
  
  const rawHTML = await page.content();
  const rawHTMLLength = rawHTML.length;
  console.log(`[AI提取] 原始 HTML 长度: ${rawHTMLLength.toLocaleString()} 字符`);
  
  // 5. 优化 HTML（减少大小，移除脚本、样式等）
  console.log('[AI提取] 优化 HTML（移除脚本、样式等无关内容）...');
  const optimizedHTML = optimizeHTML(rawHTML);
  const optimizedHTMLLength = optimizedHTML.length;
  console.log(`[AI提取] 优化后 HTML 长度: ${optimizedHTMLLength.toLocaleString()} 字符`);
  console.log(`[AI提取] HTML 减少: ${((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1)}%`);
  
  // 6. 获取优化建议
  const videoCount = (optimizedHTML.match(/\/video\//g) || []).length;
  const optimizationInfo = getOptimizationSuggestions(optimizedHTMLLength, videoCount);
  
  console.log(`[AI提取] 检测到约 ${videoCount} 个视频链接`);
  if (optimizationInfo.suggestions.length > 0) {
    console.log('[AI提取] 优化建议:');
    optimizationInfo.suggestions.forEach((suggestion, index) => {
      console.log(`  ${index + 1}. [${suggestion.level.toUpperCase()}] ${suggestion.message}`);
      if (suggestion.actions) {
        suggestion.actions.forEach(action => console.log(`     ${action}`));
      } else if (suggestion.action) {
        console.log(`     ${suggestion.action}`);
      }
    });
  }

  // 7.1 将 HTML 转换为精简 Markdown，进一步减少 Token 并提高可读性
  console.log('[AI提取] [方案B] 将页面 HTML 转为精简 Markdown...');
  const markdownContent = htmlToCompactMarkdown(optimizedHTML);
  const markdownLength = markdownContent.length;
  console.log(`[AI提取] Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Markdown Token 数: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
  
  // 保存精简 Markdown 到日志（供检查）
  const logsDir = path.join(__dirname, '../logs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const markdownLogPath = path.join(logsDir, `markdown-input-${timestamp}.md`);
    fs.writeFileSync(markdownLogPath, markdownContent, 'utf-8');
    console.log(`[AI提取] 精简 Markdown 已保存到: ${markdownLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 Markdown 日志失败:', e.message);
  }
  
  // ========== 测试模式：只测试 Markdown 转换，跳过 LLM 调用 ==========
  const TEST_MARKDOWN_ONLY = true; // 设置为 true 只测试 Markdown，false 继续调用 LLM
  
  if (TEST_MARKDOWN_ONLY) {
    console.log('');
    console.log('='.repeat(80));
    console.log('🧪 测试模式：只测试 Markdown 转换效果');
    console.log('='.repeat(80));
    console.log('');
    console.log('Markdown 内容预览（前2000字符）：');
    console.log('-'.repeat(80));
    console.log(markdownContent.substring(0, 2000));
    console.log('-'.repeat(80));
    console.log('');
    console.log(`✅ Markdown 转换完成！`);
    console.log(`📊 统计信息：`);
    console.log(`   - 视频数量: ${(markdownContent.match(/## \d+\. 视频/g) || []).length}`);
    console.log(`   - 用户数量: ${(markdownContent.match(/## \d+\. @/g) || []).length}`);
    console.log(`   - Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
    console.log(`   - 估算 Token: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
    console.log('');
    console.log('💡 提示：检查 logs/markdown-input-*.md 文件查看完整 Markdown');
    console.log('');
    
    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);
    
    return {
      videos: [],
      influencers: [],
      markdown: markdownContent,
      stats: {
        totalTime: totalTime,
        llmTime: '0',
        htmlLength: {
          original: rawHTMLLength,
          optimized: optimizedHTMLLength,
          reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
        },
        tokenEstimate: {
          original: Math.ceil(rawHTMLLength / 4),
          optimized: Math.ceil(optimizedHTMLLength / 4),
          prompt: Math.ceil(markdownLength / 4),
          markdown: Math.ceil(markdownLength / 4)
        },
        videoCount: (markdownContent.match(/## \d+\. 视频/g) || []).length,
        influencerCount: (markdownContent.match(/## \d+\. @/g) || []).length,
        optimizationSuggestions: optimizationInfo.suggestions
      }
    };
  }
  
  // ========== 正常模式：继续调用 LLM ==========
  
  // 8. 构建 LLM Prompt（基于精简 Markdown，方案B）
  console.log('[AI提取] [方案B] 构建 LLM Prompt（让 LLM 自己识别视频）...');
  const prompt = `你是一个专业的社交媒体数据分析专家。请分析下面这个 TikTok 搜索结果页面的完整内容（Markdown 格式），**自己识别并提取**所有视频和对应的红人（创作者）信息。

**方案B说明**：
- 我们直接提供了整个页面的精简 Markdown 内容
- 你需要自己识别哪些是视频卡片，哪些是视频信息，哪些是红人信息
- 不依赖特定的 HTML 结构或 CSS 选择器
- 通过内容语义来识别（如视频链接、用户名链接、播放量、点赞数等）

下面是已经提取并转换好的**精简版 Markdown 内容**（只包含与视频和红人相关的信息，不包含样式、脚本等）：

${markdownContent.substring(0, 200000)}  // 限制长度避免超过 token 限制

请**自己识别并提取**以下信息：

**视频信息**（每个视频）：
1. videoId: 视频ID（从链接中提取，格式如 /video/1234567890）
2. videoUrl: 视频完整链接（如 https://www.tiktok.com/@username/video/1234567890）
3. username: 作者用户名（从链接中提取，格式如 /@username，只返回 username 部分，不要包含 @ 符号）
4. profileUrl: 作者主页链接（如 https://www.tiktok.com/@username）
5. views: 播放量（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，如 { count: 1200000, display: "1.2M" }）
6. likes: 点赞数（如果有显示，格式同上）
7. thumbnail: 视频封面图片 URL

**红人信息**（每个红人，去重）：
1. username: 用户名（从链接中提取）
2. displayName: 显示名称（创作者的名字）
3. profileUrl: 个人主页链接
4. avatarUrl: 头像图片 URL
5. followers: 粉丝数（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，否则为 null）
6. bio: 个人简介（如果有）
7. verified: 是否认证（true/false）

**重要提示**：
- 提取页面中所有视频，有多少条就提取多少条（20条就20条，50条就50条）
- 用户名必须从链接中提取，格式为 /@username，只返回 username 部分
- 所有字段如果找不到，返回 null 或空字符串
- 播放量、点赞数、粉丝数需要解析（如 "1.2M" → { count: 1200000, display: "1.2M" }）
- 红人信息需要去重（相同用户名只保留一个）
- 只返回 JSON 格式，不要其他文字说明

请返回 JSON 格式：
{
  "videos": [
    {
      "videoId": "视频ID或null",
      "videoUrl": "完整URL或null",
      "username": "用户名或null",
      "profileUrl": "主页URL或null",
      "views": { "count": 数字或0, "display": "显示文本或'0'" },
      "likes": { "count": 数字或0, "display": "显示文本或'0'" },
      "thumbnail": "图片URL或null"
    },
    ...
  ],
  "influencers": [
    {
      "username": "用户名或null",
      "displayName": "显示名称或null",
      "profileUrl": "主页URL或null",
      "avatarUrl": "头像URL或null",
      "followers": { "count": 数字或null, "display": "显示文本或null" },
      "bio": "简介或null",
      "verified": true或false,
      "platform": "TikTok"
    },
    ...
  ]
}`;

  const promptLength = prompt.length;
  console.log(`[AI提取] Prompt 长度: ${promptLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Token 数: ${Math.ceil(promptLength / 4).toLocaleString()}`);
  
  // 9. 调用 LLM（DeepSeek API 最大支持 8192 tokens）
  console.log('[AI提取] 调用 LLM API（max_tokens=8192）...');
  const llmStartTime = Date.now();
  const llmResult = await callDeepSeekLLM(
    [{ role: "user", content: prompt }],
    "你是一个专业的社交媒体数据分析专家，擅长从网页 HTML 中提取结构化信息。只返回 JSON 格式，不要其他文字。",
    { maxTokens: 8192, returnFullResponse: true }
  );
  const llmEndTime = Date.now();
  const llmResponse = llmResult.content;
  const finishReason = llmResult.finishReason;
  const usage = llmResult.usage || {};
  
  console.log(`[AI提取] LLM 调用耗时: ${((llmEndTime - llmStartTime) / 1000).toFixed(2)} 秒`);
  console.log(`[AI提取] LLM 响应长度: ${llmResponse.length.toLocaleString()} 字符`);
  console.log(`[AI提取] finish_reason: ${finishReason}（length=输出被 token 限制截断）`);
  console.log(`[AI提取] Token 使用: 输入=${usage.prompt_tokens || '未知'}, 输出=${usage.completion_tokens || '未知'}`);
  console.log(`[AI提取] LLM 响应预览: ${llmResponse.substring(0, 300)}...`);
  
  if (finishReason === 'length') {
    console.warn('[AI提取] ⚠️ 输出被 token 限制截断！请增加 max_tokens 或减少视频数量');
  }
  
  // 10. 保存原始 LLM 响应到日志（供检查）
  const responseLogPath = path.join(logsDir, `llm-response-raw-${timestamp}.json`);
  try {
    fs.writeFileSync(responseLogPath, llmResponse, 'utf-8');
    console.log(`[AI提取] LLM 原始响应已保存到: ${responseLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 LLM 响应失败:', e.message);
  }
  
  // 10. 解析 JSON 响应（改进的解析逻辑）
  console.log('[AI提取] 解析 LLM 响应...');
  let extractedData;
  let parseError = null;
  
  try {
    // 尝试1: 直接解析
    extractedData = JSON.parse(llmResponse);
    console.log('[AI提取] ✅ 直接解析成功');
  } catch (e) {
    parseError = e;
    console.warn('[AI提取] 直接解析失败:', e.message);
    
    try {
      // 尝试2: 移除 markdown 代码块标记
      let cleanedResponse = llmResponse;
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '');
      cleanedResponse = cleanedResponse.replace(/```\s*/g, '');
      cleanedResponse = cleanedResponse.trim();
      
      extractedData = JSON.parse(cleanedResponse);
      console.log('[AI提取] ✅ 移除 markdown 标记后解析成功');
    } catch (e2) {
      console.warn('[AI提取] 移除 markdown 标记后仍失败:', e2.message);
      
      try {
        // 尝试3: 提取 JSON 对象（使用更宽松的正则）
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          let jsonStr = jsonMatch[0];
          
          // 尝试修复常见的 JSON 错误
          // 修复末尾多余的逗号
          jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
          // 修复单引号
          jsonStr = jsonStr.replace(/'/g, '"');
          
          extractedData = JSON.parse(jsonStr);
          console.log('[AI提取] ✅ 提取并修复后解析成功');
        } else {
          throw new Error('无法从响应中提取 JSON 对象');
        }
      } catch (e3) {
        console.warn('[AI提取] ⚠️ 标准解析失败，尝试修复截断的 JSON...');
        
        try {
          // 尝试4: 修复被截断的 JSON（更智能的方法）
          let jsonStr = llmResponse;
          // 移除 markdown 代码块标记
          jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          
          // 策略：从后往前查找，找到最后一个完整的对象
          // 先找到所有完整的 videoId 对象
          const videoIdPattern = /"videoId"\s*:\s*"(\d+)"/g;
          const videoIds = [];
          let match;
          while ((match = videoIdPattern.exec(jsonStr)) !== null) {
            videoIds.push({ id: match[1], index: match.index });
          }
          
          if (videoIds.length === 0) {
            throw new Error('未找到任何视频ID');
          }
          
          // 从最后一个videoId开始，向前查找完整的对象
          let lastValidIndex = jsonStr.length;
          
          // 从后往前查找，找到最后一个完整的对象结束位置
          for (let i = videoIds.length - 1; i >= 0; i--) {
            const videoId = videoIds[i];
            const startIndex = videoId.index;
            
            // 向前查找这个对象的开始（找到最近的 {）
            let objStart = startIndex;
            let braceCount = 0;
            let foundStart = false;
            
            // 向前查找对象开始
            for (let j = startIndex; j >= 0; j--) {
              if (jsonStr[j] === '}') braceCount++;
              else if (jsonStr[j] === '{') {
                braceCount--;
                if (braceCount === 0) {
                  objStart = j;
                  foundStart = true;
                  break;
                }
              }
            }
            
            if (!foundStart) continue;
            
            // 向后查找这个对象的结束
            let objEnd = -1;
            braceCount = 0;
            let inString = false;
            let escapeNext = false;
            
            for (let j = objStart; j < jsonStr.length; j++) {
              const char = jsonStr[j];
              
              if (escapeNext) {
                escapeNext = false;
                continue;
              }
              
              if (char === '\\') {
                escapeNext = true;
                continue;
              }
              
              if (char === '"') {
                inString = !inString;
                continue;
              }
              
              if (inString) continue;
              
              if (char === '{') braceCount++;
              else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  objEnd = j + 1;
                  break;
                }
              }
            }
            
            if (objEnd > 0 && objEnd <= jsonStr.length) {
              // 验证这个对象是否完整（检查是否在字符串中间被截断）
              const objContent = jsonStr.substring(objStart, objEnd);
              
              // 检查对象是否包含未闭合的字符串
              let stringCount = 0;
              let isValid = true;
              for (let j = 0; j < objContent.length; j++) {
                if (objContent[j] === '\\') {
                  j++; // 跳过转义字符
                  continue;
                }
                if (objContent[j] === '"') {
                  stringCount++;
                }
              }
              
              // 如果字符串引号数量是偶数，说明字符串都闭合了
              if (stringCount % 2 === 0) {
                lastValidIndex = objEnd;
                break;
              }
            }
          }
          
          // 提取到最后一个完整对象为止的JSON
          let fixedJson = jsonStr.substring(0, lastValidIndex);
          
          // 移除最后一个对象后的逗号（如果有）
          fixedJson = fixedJson.replace(/,\s*$/, '');
          
          // 找到videos数组的开始位置
          const videosArrayStart = fixedJson.indexOf('"videos"');
          if (videosArrayStart > 0) {
            const arrayStart = fixedJson.indexOf('[', videosArrayStart);
            if (arrayStart > 0) {
              // 计算需要闭合的括号（只计算数组内的）
              const arrayContent = fixedJson.substring(arrayStart);
              const openBraces = (arrayContent.match(/\{/g) || []).length;
              const closeBraces = (arrayContent.match(/\}/g) || []).length;
              const openBrackets = (arrayContent.match(/\[/g) || []).length;
              const closeBrackets = (arrayContent.match(/\]/g) || []).length;
              
              // 添加缺失的闭合括号
              if (closeBraces < openBraces) {
                fixedJson += '}'.repeat(openBraces - closeBraces);
              }
              if (closeBrackets < openBrackets) {
                fixedJson += ']'.repeat(openBrackets - closeBrackets);
              }
              
              // 确保videos数组正确闭合
              if (!fixedJson.endsWith(']')) {
                fixedJson += ']';
              }
            }
          }
          
          // 确保根对象正确闭合
          const rootOpenBraces = (fixedJson.match(/\{/g) || []).length;
          const rootCloseBraces = (fixedJson.match(/\}/g) || []).length;
          if (rootCloseBraces < rootOpenBraces) {
            fixedJson += '}'.repeat(rootOpenBraces - rootCloseBraces);
          }
          
          // 修复常见的 JSON 错误
          fixedJson = fixedJson.replace(/,(\s*[}\]])/g, '$1'); // 移除末尾多余的逗号
          fixedJson = fixedJson.replace(/'/g, '"'); // 修复单引号
          
          // 确保JSON结构完整
          if (!fixedJson.trim().startsWith('{')) {
            const firstBrace = fixedJson.indexOf('{');
            if (firstBrace > 0) {
              fixedJson = fixedJson.substring(firstBrace);
            }
          }
          
          extractedData = JSON.parse(fixedJson);
          console.log('[AI提取] ✅ 修复截断 JSON 后解析成功');
          console.log(`[AI提取] ⚠️ 注意：JSON 可能被截断，只提取了前 ${extractedData.videos?.length || 0} 个视频`);
        } catch (e4) {
          console.error('[AI提取] ❌ 所有解析尝试都失败（包括修复截断 JSON）');
          console.error('[AI提取] 错误详情:', e4.message);
          console.error('[AI提取] 响应位置:', e4.message.match(/position (\d+)/)?.[1] || '未知');
          
          // 输出响应的一部分以便调试
          const errorPos = parseInt(e4.message.match(/position (\d+)/)?.[1] || '0');
          if (errorPos > 0) {
            const start = Math.max(0, errorPos - 200);
            const end = Math.min(llmResponse.length, errorPos + 200);
            console.error('[AI提取] 错误位置附近的响应内容:');
            console.error('='.repeat(80));
            console.error(llmResponse.substring(start, end));
            console.error('='.repeat(80));
          }
          
          throw new Error(`JSON 解析失败: ${e4.message}`);
        }
      }
    }
  }
  
  // 11. 输出原始提取数据并保存到日志（供检查）
  console.log('');
  console.log('='.repeat(80));
  console.log('LLM 原始提取数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(extractedData, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  try {
    const extractedLogPath = path.join(logsDir, `extracted-data-raw-${timestamp}.json`);
    fs.writeFileSync(extractedLogPath, JSON.stringify(extractedData, null, 2), 'utf-8');
    console.log(`[AI提取] 原始提取数据已保存到: ${extractedLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存原始提取数据失败:', e.message);
  }
  
  // 12. 验证和清理数据
  const videos = Array.isArray(extractedData.videos) ? extractedData.videos : [];
  const influencers = Array.isArray(extractedData.influencers) ? extractedData.influencers : [];
  
  // 清理和验证视频数据
  const cleanedVideos = videos.map(video => ({
    videoId: video.videoId || null,
    videoUrl: video.videoUrl || null,
    username: video.username || null,
    profileUrl: video.profileUrl || (video.username ? `https://www.tiktok.com/@${video.username}` : null),
    views: video.views || { count: 0, display: '0' },
    likes: video.likes || { count: 0, display: '0' },
    thumbnail: video.thumbnail || null
  }));
  
  // 清理和验证红人数据（去重）
  const seenUsernames = new Set();
  const cleanedInfluencers = influencers
    .filter(inf => inf.username && !seenUsernames.has(inf.username))
    .map(inf => {
      seenUsernames.add(inf.username);
      return {
        username: inf.username,
        displayName: inf.displayName || inf.username,
        profileUrl: inf.profileUrl || `https://www.tiktok.com/@${inf.username}`,
        avatarUrl: inf.avatarUrl || null,
        followers: inf.followers || null,
        bio: inf.bio || null,
        verified: inf.verified || false,
        platform: 'TikTok'
      };
    });
  
  const endTime = Date.now();
  const totalTime = ((endTime - startTime) / 1000).toFixed(2);
  
  console.log(`[AI提取] ✅ 提取完成！`);
  console.log(`[AI提取] 总耗时: ${totalTime} 秒`);
  console.log(`[AI提取] 提取到 ${cleanedVideos.length} 个视频`);
  console.log(`[AI提取] 提取到 ${cleanedInfluencers.length} 个红人`);
  
  // 14. 检测是否需要更新规则（去重后的用户名数量 < 10）
  const extractionResult = {
    videos: cleanedVideos,
    users: cleanedInfluencers
  };
  
  // 14.1 检测是否需要更新规则（去重后的用户名数量 < 10）
  const shouldUpdate = shouldTriggerRuleUpdate(extractionResult, 50);
  
  if (shouldUpdate) {
    console.log('[规则更新] ⚠️ 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    try {
      // 获取 HTML（用于 LLM 学习）
      const html = await page.content();
      const optimizedHTML = optimizeHTML(html);
      
      // 调用规则更新（最多重试 3 次）
      const updateResult = await updateRulesWithRetry(
        optimizedHTML, 
        extractionResult, 
        50,
        extractWithRules  // 规则引擎函数
      );
      
      if (updateResult.success) {
        console.log('[规则更新] ✅ 规则更新成功，版本:', updateResult.rules.version);
        console.log('[规则更新] 指标:', updateResult.metrics);
        
        // 可选：用新规则重新提取一次（如果需要）
        // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
        // console.log('[规则更新] 新规则提取结果:', newResult.videos.length, '个视频,', newResult.users.length, '个用户');
      } else {
        console.log('[规则更新] ⚠️ 规则更新失败（' + updateResult.attempts + ' 次尝试均失败），继续使用旧规则');
        console.log('[规则更新] 最后失败原因:', updateResult.lastError);
      }
    } catch (e) {
      console.error('[规则更新] ❌ 规则更新过程出错:', e.message);
      console.error('[规则更新] 错误堆栈:', e.stack);
    }
  }
  
  // 13. 输出清理后的完整数据（用于测试）
  console.log('');
  console.log('='.repeat(80));
  console.log('清理后的视频数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedVideos, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  console.log('='.repeat(80));
  console.log('清理后的红人数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedInfluencers, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  // 13.1 保存最终视频和红人数据到日志（供检查）
  try {
    const finalData = { videos: cleanedVideos, influencers: cleanedInfluencers };
    const finalLogPath = path.join(logsDir, `extracted-data-final-${timestamp}.json`);
    fs.writeFileSync(finalLogPath, JSON.stringify(finalData, null, 2), 'utf-8');
    console.log(`[AI提取] 最终视频和红人数据已保存到: ${finalLogPath}`);
    
    // 保存截断说明日志
    const summaryPath = path.join(logsDir, `extraction-summary-${timestamp}.txt`);
    const summary = [
      `=== TikTok 数据提取日志 ${timestamp} ===`,
      '',
      '【截断原因说明】',
      `finish_reason: ${finishReason}`,
      '- stop: 正常完成，未截断',
      '- length: 输出达到 max_tokens 限制被截断（API 默认或设置的输出 token 上限）',
      '- content_filter: 内容被过滤',
      '',
      '【Token 使用】',
      `输入 tokens: ${usage.prompt_tokens || '未知'}`,
      `输出 tokens: ${usage.completion_tokens || '未知'}`,
      '',
      '【数据统计】',
      `视频数量: ${cleanedVideos.length}`,
      `红人数量: ${cleanedInfluencers.length}`,
      `Markdown 长度: ${markdownLength} 字符`,
      `LLM 响应长度: ${llmResponse.length} 字符`,
      '',
      '【日志文件】',
      `- 精简 Markdown 输入: markdown-input-${timestamp}.md`,
      `- LLM 原始 JSON 响应: llm-response-raw-${timestamp}.json`,
      `- 解析后原始数据: extracted-data-raw-${timestamp}.json`,
      `- 最终清理数据: extracted-data-final-${timestamp}.json`
    ].join('\n');
    fs.writeFileSync(summaryPath, summary, 'utf-8');
    console.log(`[AI提取] 提取摘要已保存到: ${summaryPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存最终数据失败:', e.message);
  }
  
  // 14. 返回结果和统计信息
  return {
    videos: cleanedVideos,
    influencers: cleanedInfluencers,
    stats: {
      totalTime: totalTime,
      llmTime: ((llmEndTime - llmStartTime) / 1000).toFixed(2),
      htmlLength: {
        original: rawHTMLLength,
        optimized: optimizedHTMLLength,
        reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
      },
      tokenEstimate: {
        original: Math.ceil(rawHTMLLength / 4),
        optimized: Math.ceil(optimizedHTMLLength / 4),
        prompt: Math.ceil(promptLength / 4)
      },
      videoCount: cleanedVideos.length,
      influencerCount: cleanedInfluencers.length,
      optimizationSuggestions: optimizationInfo.suggestions
    }
  };
}

/**
 * 等待用户按 Enter 键
 */
function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

// 运行主函数
main().catch(console.error);
      // 提取关注数（following）
      const followingMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:following|关注)/i);
      if (followingMatch) {
        const num = parseFloat(followingMatch[1]);
        const unit = followingMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.following = { count: Math.round(count), display: followingMatch[0].trim() };
        }
      }
      
      // 提取获赞数（likes）
      const likesMatch = contextText.match(/(\d+\.?\d*)\s*([KMkm]?)\s*(?:likes?|获赞)/i);
      if (likesMatch) {
        const num = parseFloat(likesMatch[1]);
        const unit = likesMatch[2].toUpperCase();
        let count = num;
        if (unit === 'K') count = num * 1000;
        else if (unit === 'M') count = num * 1000000;
        if (count > 0 && count < 1000000000) {
          user.totalLikes = { count: Math.round(count), display: likesMatch[0].trim() };
        }
      }
      
      // 提取认证状态（verified badge）
      const verifiedPatterns = [
        /verified/i,
        /认证/i,
        /verified account/i,
        /checkmark/i,
        /✓/,
        /data-e2e=["']verified["']/i,
      ];
      
      for (const pattern of verifiedPatterns) {
        if (pattern.test(context)) {
          user.verified = true;
          break;
        }
      }
      
      // 提取头像（缩短 URL）
      const avatarMatches = context.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi);
      for (const avatarMatch of avatarMatches) {
        const imgSrc = avatarMatch[1];
        if (imgSrc && (imgSrc.includes('avatar') || imgSrc.includes('avt-') || imgSrc.includes('user') || 
            imgSrc.includes('profile') || imgSrc.includes('head'))) {
          user.avatarUrl = shortenCoverUrl(imgSrc);
          break;
        }
      }
      
      // 提取用户简介（bio）
      const bioPatterns = [
        /bio[:\s]+([^@#\n]{5,200})/i,
        /简介[:\s]+([^@#\n]{5,200})/i,
        /description[:\s]+([^@#\n]{5,200})/i,
      ];
      
      for (const pattern of bioPatterns) {
        const bioMatch = contextText.match(pattern);
        if (bioMatch && bioMatch[1]) {
          const bio = bioMatch[1].trim();
          if (bio.length >= 5 && bio.length <= 200 && !bio.match(/^\d+$/)) {
            user.bio = bio;
            break;
          }
        }
      }
    }
  });

  // 6. 构建精简的 Markdown（紧凑格式）
  let md = '';

  // 视频列表（仅输出 HTML 中实际存在的数据，不臆造）
  if (extractedData.videos.length > 0) {
    md += `# 视频列表 (${extractedData.videos.length}个)\n`;
    md += `注：搜索页仅展示点赞数，无播放量/评论/收藏\n\n`;
    extractedData.videos.forEach((video, idx) => {
      md += `## ${idx + 1}. 视频 ${video.videoId}\n`;
      md += `- URL: ${video.videoUrl}\n`;
      if (video.username) md += `- 作者: @${video.username}\n`;
      if (video.caption) {
        md += `- 文案: ${video.caption.substring(0, 200)}${video.caption.length > 200 ? '...' : ''}\n`;
      } else if (video.description) {
        md += `- 描述: ${video.description.substring(0, 200)}${video.description.length > 200 ? '...' : ''}\n`;
      }
      if (video.postedTime) md += `- 发布时间: ${video.postedTime}\n`;
      if (video.likes) md += `- 点赞: ${video.likes.display}\n`;
      if (video.hashtags && video.hashtags.length > 0) md += `- 标签: ${video.hashtags.join(' ')}\n`;
      if (video.mentions && video.mentions.length > 0) md += `- @提及: ${video.mentions.join(' ')}\n`;
      if (video.creator) md += `- 创作者: ${video.creator}\n`;
      if (video.music) md += `- 音乐: ${video.music.substring(0, 80)}${video.music.length > 80 ? '...' : ''}\n`;
      if (video.thumbnail) md += `- 封面: ${shortenCoverUrl(video.thumbnail)}\n`;
      md += '\n';
    });
  }

  // 用户列表（红人列表，含显示名、粉丝、认证状态等）
  if (extractedData.users.length > 0) {
    md += `# 用户列表 (${extractedData.users.length}个)\n\n`;
    extractedData.users.forEach((user, idx) => {
      md += `## ${idx + 1}. @${user.username}`;
      if (user.verified) {
        md += ` ✓`; // 认证标记
      }
      md += `\n`;
      md += `- 主页: ${user.profileUrl}\n`;
      // 仅在有有效显示名时输出（过滤 CSS 类名、HTML 属性值等）
      if (user.displayName && isValidDisplayName(user.displayName) && user.displayName !== user.username) {
        md += `- 显示名: ${user.displayName}\n`;
      }
      if (user.bio) {
        md += `- 简介: ${user.bio.substring(0, 150)}${user.bio.length > 150 ? '...' : ''}\n`;
      }
      if (user.followers) {
        md += `- 粉丝: ${user.followers.display} (${user.followers.count.toLocaleString()})\n`;
      }
      if (user.following) {
        md += `- 关注: ${user.following.display} (${user.following.count.toLocaleString()})\n`;
      }
      if (user.totalLikes) {
        md += `- 获赞: ${user.totalLikes.display} (${user.totalLikes.count.toLocaleString()})\n`;
      }
      if (user.avatarUrl) {
        md += `- 头像: ${shortenCoverUrl(user.avatarUrl)}\n`;
      }
      md += '\n';
    });
  }

  // 如果提取到的视频数量较少，回退到原始方法（但更精简）
  if (extractedData.videos.length < 10) {
    console.warn('[Markdown转换] 智能提取的视频数量较少，使用备用方法...');
    
    // 备用方法：提取包含 /video/ 的链接及其上下文
    let backupMd = html;
    
    // 移除所有 script/style
    backupMd = backupMd.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    backupMd = backupMd.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    
    // 只保留包含视频链接的部分
    const videoSections = [];
    const videoLinkMatches = html.matchAll(/<a[^>]*href=["'][^"']*\/video\/\d+[^"']*["'][^>]*>[\s\S]*?<\/a>/gi);
    
    for (const linkMatch of videoLinkMatches) {
      const linkHtml = linkMatch[0];
      // 提取链接和文本
      const hrefMatch = linkHtml.match(/href=["']([^"']+)["']/);
      const textMatch = linkHtml.match(/>([\s\S]*?)<\/a>/);
      
      if (hrefMatch) {
        const href = hrefMatch[1];
        const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        videoSections.push(`- [${text || '视频'}](${href})`);
      }
    }
    
    if (videoSections.length > 0) {
      md = '# 视频链接\n\n' + videoSections.join('\n') + '\n\n';
    }
  }

  return md.trim() || '未提取到视频信息';
}

/**
 * 使用 AI Agent 提取所有视频和红人信息（一次调用）
 * @param {Object} page - Playwright Page 对象
 * @returns {Promise<Object>} - { videos: Array, influencers: Array, stats: Object }
 */
async function extractVideosAndInfluencersWithAI(page) {
  console.log('[AI提取] [方案B] 开始使用 AI Agent 提取视频和红人信息（不依赖 CSS 选择器）...');
  const startTime = Date.now();
  
  // 1. 等待页面加载并滚动以触发懒加载，直到获取到至少50个视频
  console.log('[AI提取] 等待页面加载...');
  await page.waitForTimeout(3000);
  
  // 2. 滚动页面以加载更多内容，直到获取到至少50个视频
  console.log('[AI提取] 滚动页面以加载至少50个视频（模拟人类行为，降低被检测风险）...');
  const targetVideoCount = 50;
  let currentVideoCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 30; // 最多滚动30次，防止无限循环
  
  // 随机延迟函数：模拟人类的不规律行为
  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  // 滚动函数：使用平滑滚动和随机行为，模拟人类操作
  async function performScroll() {
    // 随机选择滚动方式（70% 使用鼠标滚轮，30% 使用键盘）
    const useMouseWheel = Math.random() > 0.3;
    
    if (useMouseWheel) {
      // 方法1: 鼠标滚轮滚动（最像人类操作）
      // 随机移动鼠标位置（模拟用户鼠标位置变化）
      const mouseX = randomDelay(300, 700);
      const mouseY = randomDelay(300, 600);
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(randomDelay(100, 300)); // 小停顿
      
      // 随机滚动距离（不完全滚动一屏，更像人类）
      const scrollDistance = randomDelay(400, 800);
      await page.mouse.wheel(0, scrollDistance);
      
      // 偶尔添加第二次小滚动（模拟用户调整位置）
      if (Math.random() > 0.7) {
        await page.waitForTimeout(randomDelay(200, 500));
        await page.mouse.wheel(0, randomDelay(100, 300));
      }
    } else {
      // 方法2: 键盘 PageDown（偶尔使用）
      await page.keyboard.press('PageDown');
    }
    
    // 方法3: 同时更新容器滚动位置（确保内容加载）
    const scrolled = await page.evaluate(() => {
      const selectors = [
        '[data-e2e="search-result-list"]',
        '[data-e2e="search_video-item-list"]',
        '[class*="SearchResult"]',
        '[class*="search-result"]',
        'main',
        '[role="main"]',
        '.css-1qb12g8-DivContentContainer',
        '[class*="DivContentContainer"]',
        '[class*="ItemContainer"]'
      ];
      
      // 随机滚动距离（不完全一屏）
      const scrollAmount = Math.floor(window.innerHeight * (0.7 + Math.random() * 0.3));
      
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.scrollHeight > el.clientHeight) {
            el.scrollTop += scrollAmount;
            return { method: 'container', selector: sel };
          }
        } catch (e) {}
      }
      
      // 备用：滚动 window
      const before = window.scrollY;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      if (window.scrollY !== before) {
        return { method: 'window' };
      }
      
      document.documentElement.scrollTop += scrollAmount;
      return { method: 'documentElement' };
    });
    
    return scrolled;
  }
  
  while (currentVideoCount < targetVideoCount && scrollAttempts < maxScrollAttempts) {
    // 执行滚动（模拟人类行为）
    const scrollResult = await performScroll();
    if (scrollAttempts === 0) {
      console.log(`[AI提取] 使用的滚动方式: ${scrollResult?.method || 'mouse'}${scrollResult?.selector ? ` (${scrollResult.selector})` : ''}`);
    }
    
    // 随机等待时间（2-4秒），模拟人类阅读和浏览时间
    const waitTime = randomDelay(2000, 4000);
    await page.waitForTimeout(waitTime);
    
    // 偶尔添加额外停顿（10% 概率，模拟用户被内容吸引）
    if (Math.random() > 0.9) {
      const extraWait = randomDelay(1000, 3000);
      console.log(`[AI提取] 模拟用户浏览停顿 ${extraWait}ms...`);
      await page.waitForTimeout(extraWait);
    }
    
    // 检查当前页面上的视频数量
    currentVideoCount = await page.evaluate(() => {
      const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const uniqueVideoIds = new Set();
      videoLinks.forEach(link => {
        const href = link.getAttribute('href');
        const match = href.match(/\/video\/(\d+)/);
        if (match) {
          uniqueVideoIds.add(match[1]);
        }
      });
      return uniqueVideoIds.size;
    });
    
    scrollAttempts++;
    console.log(`[AI提取] 滚动第 ${scrollAttempts} 次，当前视频数量: ${currentVideoCount}`);
    
    // 如果视频数量没有增加，可能已经到底了
    if (scrollAttempts > 5 && currentVideoCount === 0) {
      console.warn('[AI提取] ⚠️ 未检测到视频，可能页面结构已变化');
      break;
    }
    
    // 如果连续多次滚动视频数不变，可能已到底
    if (scrollAttempts > 10 && scrollAttempts % 5 === 1) {
      const prevCount = currentVideoCount;
      await page.waitForTimeout(1000);
      const afterCount = await page.evaluate(() => {
        const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
        const uniqueVideoIds = new Set();
        videoLinks.forEach(link => {
          const href = link.getAttribute('href');
          const match = href.match(/\/video\/(\d+)/);
          if (match) uniqueVideoIds.add(match[1]);
        });
        return uniqueVideoIds.size;
      });
      if (afterCount === prevCount && prevCount > 0) {
        console.log(`[AI提取] 视频数量稳定在 ${prevCount}，可能已加载完毕`);
        if (scrollAttempts > 15) break;
      }
    }
  }
  
  console.log(`[AI提取] ✅ 滚动完成，共找到 ${currentVideoCount} 个视频`);
  
  // 3. 等待内容稳定
  await page.waitForTimeout(3000);
  
  // 4. 方案B：直接提取整个页面 HTML（不依赖 CSS 选择器和 DOM 结构识别）
  console.log('[AI提取] [方案B] 提取整个页面 HTML（不依赖选择器）...');
  
  const rawHTML = await page.content();
  const rawHTMLLength = rawHTML.length;
  console.log(`[AI提取] 原始 HTML 长度: ${rawHTMLLength.toLocaleString()} 字符`);
  
  // 5. 优化 HTML（减少大小，移除脚本、样式等）
  console.log('[AI提取] 优化 HTML（移除脚本、样式等无关内容）...');
  const optimizedHTML = optimizeHTML(rawHTML);
  const optimizedHTMLLength = optimizedHTML.length;
  console.log(`[AI提取] 优化后 HTML 长度: ${optimizedHTMLLength.toLocaleString()} 字符`);
  console.log(`[AI提取] HTML 减少: ${((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1)}%`);
  
  // 6. 获取优化建议
  const videoCount = (optimizedHTML.match(/\/video\//g) || []).length;
  const optimizationInfo = getOptimizationSuggestions(optimizedHTMLLength, videoCount);
  
  console.log(`[AI提取] 检测到约 ${videoCount} 个视频链接`);
  if (optimizationInfo.suggestions.length > 0) {
    console.log('[AI提取] 优化建议:');
    optimizationInfo.suggestions.forEach((suggestion, index) => {
      console.log(`  ${index + 1}. [${suggestion.level.toUpperCase()}] ${suggestion.message}`);
      if (suggestion.actions) {
        suggestion.actions.forEach(action => console.log(`     ${action}`));
      } else if (suggestion.action) {
        console.log(`     ${suggestion.action}`);
      }
    });
  }

  // 7.1 将 HTML 转换为精简 Markdown，进一步减少 Token 并提高可读性
  console.log('[AI提取] [方案B] 将页面 HTML 转为精简 Markdown...');
  const markdownContent = htmlToCompactMarkdown(optimizedHTML);
  const markdownLength = markdownContent.length;
  console.log(`[AI提取] Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Markdown Token 数: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
  
  // 保存精简 Markdown 到日志（供检查）
  const logsDir = path.join(__dirname, '../logs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const markdownLogPath = path.join(logsDir, `markdown-input-${timestamp}.md`);
    fs.writeFileSync(markdownLogPath, markdownContent, 'utf-8');
    console.log(`[AI提取] 精简 Markdown 已保存到: ${markdownLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 Markdown 日志失败:', e.message);
  }
  
  // ========== 测试模式：只测试 Markdown 转换，跳过 LLM 调用 ==========
  const TEST_MARKDOWN_ONLY = true; // 设置为 true 只测试 Markdown，false 继续调用 LLM
  
  if (TEST_MARKDOWN_ONLY) {
    console.log('');
    console.log('='.repeat(80));
    console.log('🧪 测试模式：只测试 Markdown 转换效果');
    console.log('='.repeat(80));
    console.log('');
    console.log('Markdown 内容预览（前2000字符）：');
    console.log('-'.repeat(80));
    console.log(markdownContent.substring(0, 2000));
    console.log('-'.repeat(80));
    console.log('');
    console.log(`✅ Markdown 转换完成！`);
    console.log(`📊 统计信息：`);
    console.log(`   - 视频数量: ${(markdownContent.match(/## \d+\. 视频/g) || []).length}`);
    console.log(`   - 用户数量: ${(markdownContent.match(/## \d+\. @/g) || []).length}`);
    console.log(`   - Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
    console.log(`   - 估算 Token: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
    console.log('');
    console.log('💡 提示：检查 logs/markdown-input-*.md 文件查看完整 Markdown');
    console.log('');
    
    const endTime = Date.now();
    const totalTime = ((endTime - startTime) / 1000).toFixed(2);
    
    return {
      videos: [],
      influencers: [],
      markdown: markdownContent,
      stats: {
        totalTime: totalTime,
        llmTime: '0',
        htmlLength: {
          original: rawHTMLLength,
          optimized: optimizedHTMLLength,
          reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
        },
        tokenEstimate: {
          original: Math.ceil(rawHTMLLength / 4),
          optimized: Math.ceil(optimizedHTMLLength / 4),
          prompt: Math.ceil(markdownLength / 4),
          markdown: Math.ceil(markdownLength / 4)
        },
        videoCount: (markdownContent.match(/## \d+\. 视频/g) || []).length,
        influencerCount: (markdownContent.match(/## \d+\. @/g) || []).length,
        optimizationSuggestions: optimizationInfo.suggestions
      }
    };
  }
  
  // ========== 正常模式：继续调用 LLM ==========
  
  // 8. 构建 LLM Prompt（基于精简 Markdown，方案B）
  console.log('[AI提取] [方案B] 构建 LLM Prompt（让 LLM 自己识别视频）...');
  const prompt = `你是一个专业的社交媒体数据分析专家。请分析下面这个 TikTok 搜索结果页面的完整内容（Markdown 格式），**自己识别并提取**所有视频和对应的红人（创作者）信息。

**方案B说明**：
- 我们直接提供了整个页面的精简 Markdown 内容
- 你需要自己识别哪些是视频卡片，哪些是视频信息，哪些是红人信息
- 不依赖特定的 HTML 结构或 CSS 选择器
- 通过内容语义来识别（如视频链接、用户名链接、播放量、点赞数等）

下面是已经提取并转换好的**精简版 Markdown 内容**（只包含与视频和红人相关的信息，不包含样式、脚本等）：

${markdownContent.substring(0, 200000)}  // 限制长度避免超过 token 限制

请**自己识别并提取**以下信息：

**视频信息**（每个视频）：
1. videoId: 视频ID（从链接中提取，格式如 /video/1234567890）
2. videoUrl: 视频完整链接（如 https://www.tiktok.com/@username/video/1234567890）
3. username: 作者用户名（从链接中提取，格式如 /@username，只返回 username 部分，不要包含 @ 符号）
4. profileUrl: 作者主页链接（如 https://www.tiktok.com/@username）
5. views: 播放量（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，如 { count: 1200000, display: "1.2M" }）
6. likes: 点赞数（如果有显示，格式同上）
7. thumbnail: 视频封面图片 URL

**红人信息**（每个红人，去重）：
1. username: 用户名（从链接中提取）
2. displayName: 显示名称（创作者的名字）
3. profileUrl: 个人主页链接
4. avatarUrl: 头像图片 URL
5. followers: 粉丝数（如果有显示，格式为对象 { count: 数字, display: "显示文本" }，否则为 null）
6. bio: 个人简介（如果有）
7. verified: 是否认证（true/false）

**重要提示**：
- 提取页面中所有视频，有多少条就提取多少条（20条就20条，50条就50条）
- 用户名必须从链接中提取，格式为 /@username，只返回 username 部分
- 所有字段如果找不到，返回 null 或空字符串
- 播放量、点赞数、粉丝数需要解析（如 "1.2M" → { count: 1200000, display: "1.2M" }）
- 红人信息需要去重（相同用户名只保留一个）
- 只返回 JSON 格式，不要其他文字说明

请返回 JSON 格式：
{
  "videos": [
    {
      "videoId": "视频ID或null",
      "videoUrl": "完整URL或null",
      "username": "用户名或null",
      "profileUrl": "主页URL或null",
      "views": { "count": 数字或0, "display": "显示文本或'0'" },
      "likes": { "count": 数字或0, "display": "显示文本或'0'" },
      "thumbnail": "图片URL或null"
    },
    ...
  ],
  "influencers": [
    {
      "username": "用户名或null",
      "displayName": "显示名称或null",
      "profileUrl": "主页URL或null",
      "avatarUrl": "头像URL或null",
      "followers": { "count": 数字或null, "display": "显示文本或null" },
      "bio": "简介或null",
      "verified": true或false,
      "platform": "TikTok"
    },
    ...
  ]
}`;

  const promptLength = prompt.length;
  console.log(`[AI提取] Prompt 长度: ${promptLength.toLocaleString()} 字符`);
  console.log(`[AI提取] 估算 Token 数: ${Math.ceil(promptLength / 4).toLocaleString()}`);
  
  // 9. 调用 LLM（DeepSeek API 最大支持 8192 tokens）
  console.log('[AI提取] 调用 LLM API（max_tokens=8192）...');
  const llmStartTime = Date.now();
  const llmResult = await callDeepSeekLLM(
    [{ role: "user", content: prompt }],
    "你是一个专业的社交媒体数据分析专家，擅长从网页 HTML 中提取结构化信息。只返回 JSON 格式，不要其他文字。",
    { maxTokens: 8192, returnFullResponse: true }
  );
  const llmEndTime = Date.now();
  const llmResponse = llmResult.content;
  const finishReason = llmResult.finishReason;
  const usage = llmResult.usage || {};
  
  console.log(`[AI提取] LLM 调用耗时: ${((llmEndTime - llmStartTime) / 1000).toFixed(2)} 秒`);
  console.log(`[AI提取] LLM 响应长度: ${llmResponse.length.toLocaleString()} 字符`);
  console.log(`[AI提取] finish_reason: ${finishReason}（length=输出被 token 限制截断）`);
  console.log(`[AI提取] Token 使用: 输入=${usage.prompt_tokens || '未知'}, 输出=${usage.completion_tokens || '未知'}`);
  console.log(`[AI提取] LLM 响应预览: ${llmResponse.substring(0, 300)}...`);
  
  if (finishReason === 'length') {
    console.warn('[AI提取] ⚠️ 输出被 token 限制截断！请增加 max_tokens 或减少视频数量');
  }
  
  // 10. 保存原始 LLM 响应到日志（供检查）
  const responseLogPath = path.join(logsDir, `llm-response-raw-${timestamp}.json`);
  try {
    fs.writeFileSync(responseLogPath, llmResponse, 'utf-8');
    console.log(`[AI提取] LLM 原始响应已保存到: ${responseLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存 LLM 响应失败:', e.message);
  }
  
  // 10. 解析 JSON 响应（改进的解析逻辑）
  console.log('[AI提取] 解析 LLM 响应...');
  let extractedData;
  let parseError = null;
  
  try {
    // 尝试1: 直接解析
    extractedData = JSON.parse(llmResponse);
    console.log('[AI提取] ✅ 直接解析成功');
  } catch (e) {
    parseError = e;
    console.warn('[AI提取] 直接解析失败:', e.message);
    
    try {
      // 尝试2: 移除 markdown 代码块标记
      let cleanedResponse = llmResponse;
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '');
      cleanedResponse = cleanedResponse.replace(/```\s*/g, '');
      cleanedResponse = cleanedResponse.trim();
      
      extractedData = JSON.parse(cleanedResponse);
      console.log('[AI提取] ✅ 移除 markdown 标记后解析成功');
    } catch (e2) {
      console.warn('[AI提取] 移除 markdown 标记后仍失败:', e2.message);
      
      try {
        // 尝试3: 提取 JSON 对象（使用更宽松的正则）
        const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          let jsonStr = jsonMatch[0];
          
          // 尝试修复常见的 JSON 错误
          // 修复末尾多余的逗号
          jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');
          // 修复单引号
          jsonStr = jsonStr.replace(/'/g, '"');
          
          extractedData = JSON.parse(jsonStr);
          console.log('[AI提取] ✅ 提取并修复后解析成功');
        } else {
          throw new Error('无法从响应中提取 JSON 对象');
        }
      } catch (e3) {
        console.warn('[AI提取] ⚠️ 标准解析失败，尝试修复截断的 JSON...');
        
        try {
          // 尝试4: 修复被截断的 JSON（更智能的方法）
          let jsonStr = llmResponse;
          // 移除 markdown 代码块标记
          jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          
          // 策略：从后往前查找，找到最后一个完整的对象
          // 先找到所有完整的 videoId 对象
          const videoIdPattern = /"videoId"\s*:\s*"(\d+)"/g;
          const videoIds = [];
          let match;
          while ((match = videoIdPattern.exec(jsonStr)) !== null) {
            videoIds.push({ id: match[1], index: match.index });
          }
          
          if (videoIds.length === 0) {
            throw new Error('未找到任何视频ID');
          }
          
          // 从最后一个videoId开始，向前查找完整的对象
          let lastValidIndex = jsonStr.length;
          
          // 从后往前查找，找到最后一个完整的对象结束位置
          for (let i = videoIds.length - 1; i >= 0; i--) {
            const videoId = videoIds[i];
            const startIndex = videoId.index;
            
            // 向前查找这个对象的开始（找到最近的 {）
            let objStart = startIndex;
            let braceCount = 0;
            let foundStart = false;
            
            // 向前查找对象开始
            for (let j = startIndex; j >= 0; j--) {
              if (jsonStr[j] === '}') braceCount++;
              else if (jsonStr[j] === '{') {
                braceCount--;
                if (braceCount === 0) {
                  objStart = j;
                  foundStart = true;
                  break;
                }
              }
            }
            
            if (!foundStart) continue;
            
            // 向后查找这个对象的结束
            let objEnd = -1;
            braceCount = 0;
            let inString = false;
            let escapeNext = false;
            
            for (let j = objStart; j < jsonStr.length; j++) {
              const char = jsonStr[j];
              
              if (escapeNext) {
                escapeNext = false;
                continue;
              }
              
              if (char === '\\') {
                escapeNext = true;
                continue;
              }
              
              if (char === '"') {
                inString = !inString;
                continue;
              }
              
              if (inString) continue;
              
              if (char === '{') braceCount++;
              else if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  objEnd = j + 1;
                  break;
                }
              }
            }
            
            if (objEnd > 0 && objEnd <= jsonStr.length) {
              // 验证这个对象是否完整（检查是否在字符串中间被截断）
              const objContent = jsonStr.substring(objStart, objEnd);
              
              // 检查对象是否包含未闭合的字符串
              let stringCount = 0;
              let isValid = true;
              for (let j = 0; j < objContent.length; j++) {
                if (objContent[j] === '\\') {
                  j++; // 跳过转义字符
                  continue;
                }
                if (objContent[j] === '"') {
                  stringCount++;
                }
              }
              
              // 如果字符串引号数量是偶数，说明字符串都闭合了
              if (stringCount % 2 === 0) {
                lastValidIndex = objEnd;
                break;
              }
            }
          }
          
          // 提取到最后一个完整对象为止的JSON
          let fixedJson = jsonStr.substring(0, lastValidIndex);
          
          // 移除最后一个对象后的逗号（如果有）
          fixedJson = fixedJson.replace(/,\s*$/, '');
          
          // 找到videos数组的开始位置
          const videosArrayStart = fixedJson.indexOf('"videos"');
          if (videosArrayStart > 0) {
            const arrayStart = fixedJson.indexOf('[', videosArrayStart);
            if (arrayStart > 0) {
              // 计算需要闭合的括号（只计算数组内的）
              const arrayContent = fixedJson.substring(arrayStart);
              const openBraces = (arrayContent.match(/\{/g) || []).length;
              const closeBraces = (arrayContent.match(/\}/g) || []).length;
              const openBrackets = (arrayContent.match(/\[/g) || []).length;
              const closeBrackets = (arrayContent.match(/\]/g) || []).length;
              
              // 添加缺失的闭合括号
              if (closeBraces < openBraces) {
                fixedJson += '}'.repeat(openBraces - closeBraces);
              }
              if (closeBrackets < openBrackets) {
                fixedJson += ']'.repeat(openBrackets - closeBrackets);
              }
              
              // 确保videos数组正确闭合
              if (!fixedJson.endsWith(']')) {
                fixedJson += ']';
              }
            }
          }
          
          // 确保根对象正确闭合
          const rootOpenBraces = (fixedJson.match(/\{/g) || []).length;
          const rootCloseBraces = (fixedJson.match(/\}/g) || []).length;
          if (rootCloseBraces < rootOpenBraces) {
            fixedJson += '}'.repeat(rootOpenBraces - rootCloseBraces);
          }
          
          // 修复常见的 JSON 错误
          fixedJson = fixedJson.replace(/,(\s*[}\]])/g, '$1'); // 移除末尾多余的逗号
          fixedJson = fixedJson.replace(/'/g, '"'); // 修复单引号
          
          // 确保JSON结构完整
          if (!fixedJson.trim().startsWith('{')) {
            const firstBrace = fixedJson.indexOf('{');
            if (firstBrace > 0) {
              fixedJson = fixedJson.substring(firstBrace);
            }
          }
          
          extractedData = JSON.parse(fixedJson);
          console.log('[AI提取] ✅ 修复截断 JSON 后解析成功');
          console.log(`[AI提取] ⚠️ 注意：JSON 可能被截断，只提取了前 ${extractedData.videos?.length || 0} 个视频`);
        } catch (e4) {
          console.error('[AI提取] ❌ 所有解析尝试都失败（包括修复截断 JSON）');
          console.error('[AI提取] 错误详情:', e4.message);
          console.error('[AI提取] 响应位置:', e4.message.match(/position (\d+)/)?.[1] || '未知');
          
          // 输出响应的一部分以便调试
          const errorPos = parseInt(e4.message.match(/position (\d+)/)?.[1] || '0');
          if (errorPos > 0) {
            const start = Math.max(0, errorPos - 200);
            const end = Math.min(llmResponse.length, errorPos + 200);
            console.error('[AI提取] 错误位置附近的响应内容:');
            console.error('='.repeat(80));
            console.error(llmResponse.substring(start, end));
            console.error('='.repeat(80));
          }
          
          throw new Error(`JSON 解析失败: ${e4.message}`);
        }
      }
    }
  }
  
  // 11. 输出原始提取数据并保存到日志（供检查）
  console.log('');
  console.log('='.repeat(80));
  console.log('LLM 原始提取数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(extractedData, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  try {
    const extractedLogPath = path.join(logsDir, `extracted-data-raw-${timestamp}.json`);
    fs.writeFileSync(extractedLogPath, JSON.stringify(extractedData, null, 2), 'utf-8');
    console.log(`[AI提取] 原始提取数据已保存到: ${extractedLogPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存原始提取数据失败:', e.message);
  }
  
  // 12. 验证和清理数据
  const videos = Array.isArray(extractedData.videos) ? extractedData.videos : [];
  const influencers = Array.isArray(extractedData.influencers) ? extractedData.influencers : [];
  
  // 清理和验证视频数据
  const cleanedVideos = videos.map(video => ({
    videoId: video.videoId || null,
    videoUrl: video.videoUrl || null,
    username: video.username || null,
    profileUrl: video.profileUrl || (video.username ? `https://www.tiktok.com/@${video.username}` : null),
    views: video.views || { count: 0, display: '0' },
    likes: video.likes || { count: 0, display: '0' },
    thumbnail: video.thumbnail || null
  }));
  
  // 清理和验证红人数据（去重）
  const seenUsernames = new Set();
  const cleanedInfluencers = influencers
    .filter(inf => inf.username && !seenUsernames.has(inf.username))
    .map(inf => {
      seenUsernames.add(inf.username);
      return {
        username: inf.username,
        displayName: inf.displayName || inf.username,
        profileUrl: inf.profileUrl || `https://www.tiktok.com/@${inf.username}`,
        avatarUrl: inf.avatarUrl || null,
        followers: inf.followers || null,
        bio: inf.bio || null,
        verified: inf.verified || false,
        platform: 'TikTok'
      };
    });
  
  const endTime = Date.now();
  const totalTime = ((endTime - startTime) / 1000).toFixed(2);
  
  console.log(`[AI提取] ✅ 提取完成！`);
  console.log(`[AI提取] 总耗时: ${totalTime} 秒`);
  console.log(`[AI提取] 提取到 ${cleanedVideos.length} 个视频`);
  console.log(`[AI提取] 提取到 ${cleanedInfluencers.length} 个红人`);
  
  // 14. 检测是否需要更新规则（去重后的用户名数量 < 10）
  const extractionResult = {
    videos: cleanedVideos,
    users: cleanedInfluencers
  };
  
  // 14.1 检测是否需要更新规则（去重后的用户名数量 < 10）
  const shouldUpdate = shouldTriggerRuleUpdate(extractionResult, 50);
  
  if (shouldUpdate) {
    console.log('[规则更新] ⚠️ 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    try {
      // 获取 HTML（用于 LLM 学习）
      const html = await page.content();
      const optimizedHTML = optimizeHTML(html);
      
      // 调用规则更新（最多重试 3 次）
      const updateResult = await updateRulesWithRetry(
        optimizedHTML, 
        extractionResult, 
        50,
        extractWithRules  // 规则引擎函数
      );
      
      if (updateResult.success) {
        console.log('[规则更新] ✅ 规则更新成功，版本:', updateResult.rules.version);
        console.log('[规则更新] 指标:', updateResult.metrics);
        
        // 可选：用新规则重新提取一次（如果需要）
        // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
        // console.log('[规则更新] 新规则提取结果:', newResult.videos.length, '个视频,', newResult.users.length, '个用户');
      } else {
        console.log('[规则更新] ⚠️ 规则更新失败（' + updateResult.attempts + ' 次尝试均失败），继续使用旧规则');
        console.log('[规则更新] 最后失败原因:', updateResult.lastError);
      }
    } catch (e) {
      console.error('[规则更新] ❌ 规则更新过程出错:', e.message);
      console.error('[规则更新] 错误堆栈:', e.stack);
    }
  }
  
  // 13. 输出清理后的完整数据（用于测试）
  console.log('');
  console.log('='.repeat(80));
  console.log('清理后的视频数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedVideos, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  console.log('='.repeat(80));
  console.log('清理后的红人数据（完整）');
  console.log('='.repeat(80));
  console.log(JSON.stringify(cleanedInfluencers, null, 2));
  console.log('='.repeat(80));
  console.log('');
  
  // 13.1 保存最终视频和红人数据到日志（供检查）
  try {
    const finalData = { videos: cleanedVideos, influencers: cleanedInfluencers };
    const finalLogPath = path.join(logsDir, `extracted-data-final-${timestamp}.json`);
    fs.writeFileSync(finalLogPath, JSON.stringify(finalData, null, 2), 'utf-8');
    console.log(`[AI提取] 最终视频和红人数据已保存到: ${finalLogPath}`);
    
    // 保存截断说明日志
    const summaryPath = path.join(logsDir, `extraction-summary-${timestamp}.txt`);
    const summary = [
      `=== TikTok 数据提取日志 ${timestamp} ===`,
      '',
      '【截断原因说明】',
      `finish_reason: ${finishReason}`,
      '- stop: 正常完成，未截断',
      '- length: 输出达到 max_tokens 限制被截断（API 默认或设置的输出 token 上限）',
      '- content_filter: 内容被过滤',
      '',
      '【Token 使用】',
      `输入 tokens: ${usage.prompt_tokens || '未知'}`,
      `输出 tokens: ${usage.completion_tokens || '未知'}`,
      '',
      '【数据统计】',
      `视频数量: ${cleanedVideos.length}`,
      `红人数量: ${cleanedInfluencers.length}`,
      `Markdown 长度: ${markdownLength} 字符`,
      `LLM 响应长度: ${llmResponse.length} 字符`,
      '',
      '【日志文件】',
      `- 精简 Markdown 输入: markdown-input-${timestamp}.md`,
      `- LLM 原始 JSON 响应: llm-response-raw-${timestamp}.json`,
      `- 解析后原始数据: extracted-data-raw-${timestamp}.json`,
      `- 最终清理数据: extracted-data-final-${timestamp}.json`
    ].join('\n');
    fs.writeFileSync(summaryPath, summary, 'utf-8');
    console.log(`[AI提取] 提取摘要已保存到: ${summaryPath}`);
  } catch (e) {
    console.warn('[AI提取] 保存最终数据失败:', e.message);
  }
  
  // 14. 返回结果和统计信息
  return {
    videos: cleanedVideos,
    influencers: cleanedInfluencers,
    stats: {
      totalTime: totalTime,
      llmTime: ((llmEndTime - llmStartTime) / 1000).toFixed(2),
      htmlLength: {
        original: rawHTMLLength,
        optimized: optimizedHTMLLength,
        reduction: ((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1) + '%'
      },
      tokenEstimate: {
        original: Math.ceil(rawHTMLLength / 4),
        optimized: Math.ceil(optimizedHTMLLength / 4),
        prompt: Math.ceil(promptLength / 4)
      },
      videoCount: cleanedVideos.length,
      influencerCount: cleanedInfluencers.length,
      optimizationSuggestions: optimizationInfo.suggestions
    }
  };
}

/**
 * 等待用户按 Enter 键
 */
function waitForEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

// 运行主函数
main().catch(console.error);