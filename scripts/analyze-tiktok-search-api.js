#!/usr/bin/env node
/**
 * 分析 TikTok 搜索页面的网络请求
 * 用于确定需要拦截哪些 API 来获取搜索视频结果和红人数据
 * 
 * 使用方法：
 * 1. 确保已启动 Chrome 并启用远程调试（需要登录状态）：bash scripts/launch-chrome-remote-debug.sh
 * 2. 运行：node scripts/analyze-tiktok-search-api.js <keyword>
 * 
 * 例如：node scripts/analyze-tiktok-search-api.js "beauty"
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 获取命令行参数
const keyword = process.argv[2];
if (!keyword) {
  console.error('❌ 请提供搜索关键词');
  console.log('使用方法: node scripts/analyze-tiktok-search-api.js <keyword>');
  console.log('例如: node scripts/analyze-tiktok-search-api.js "beauty"');
  process.exit(1);
}

const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://localhost:9222';

console.log('='.repeat(80));
console.log('TikTok 搜索页面 API 分析工具');
console.log('='.repeat(80));
console.log(`搜索关键词: ${keyword}`);
console.log(`搜索 URL: ${searchUrl}`);
console.log(`CDP 端点: ${CDP_ENDPOINT}`);
console.log('='.repeat(80));
console.log('');

// 存储所有网络请求
const networkRequests = [];
const apiRequests = [];
const jsonResponses = [];
const searchApiResponses = [];

// 连接 CDP
console.log('🔗 正在连接 CDP...');
let browser, context, page;
try {
  browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const contexts = browser.contexts();
  context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  page = await context.newPage();
  console.log('✅ CDP 连接成功');
} catch (error) {
  console.error('❌ CDP 连接失败:', error.message);
  console.error('💡 请确保已启动 Chrome 并启用远程调试：');
  console.error('   bash scripts/launch-chrome-remote-debug.sh');
  process.exit(1);
}

// 监听所有网络请求
page.on('request', (request) => {
  const url = request.url();
  const method = request.method();
  const resourceType = request.resourceType();
  
  // 只记录 API 相关的请求
  if (url.includes('/api/') || 
      url.includes('tiktok.com/api') ||
      url.includes('tiktokv.com') ||
      url.includes('muscdn.com') ||
      resourceType === 'xhr' ||
      resourceType === 'fetch') {
    
    const requestInfo = {
      url,
      method,
      resourceType,
      headers: request.headers(),
      postData: request.postData(),
      timestamp: new Date().toISOString()
    };
    
    networkRequests.push(requestInfo);
    
    // 特别关注 API 请求
    if (url.includes('/api/')) {
      apiRequests.push(requestInfo);
      console.log(`📡 API 请求: ${method} ${url.substring(0, 100)}${url.length > 100 ? '...' : ''}`);
    }
  }
});

// 监听所有网络响应
page.on('response', async (response) => {
  const url = response.url();
  const status = response.status();
  const contentType = response.headers()['content-type'] || '';
  
  // 只记录 JSON 响应
  if (contentType.includes('application/json') || 
      contentType.includes('text/json') ||
      url.includes('/api/')) {
    
    try {
      const responseBody = await response.text();
      let jsonData = null;
      
      try {
        jsonData = JSON.parse(responseBody);
      } catch (e) {
        // 不是有效的 JSON，跳过
        return;
      }
      
      const responseInfo = {
        url,
        status,
        contentType,
        data: jsonData,
        size: responseBody.length,
        timestamp: new Date().toISOString()
      };
      
      jsonResponses.push(responseInfo);
      
      // 特别关注搜索相关的 API
      const isSearchApi = url.includes('/api/search/') || 
                         url.includes('/api/recommend/') ||
                         url.includes('search') && url.includes('/api/');
      
      if (isSearchApi) {
        searchApiResponses.push(responseInfo);
        console.log(`\n🔍 搜索 API 响应: ${status} ${url.substring(0, 120)}${url.length > 120 ? '...' : ''}`);
        console.log(`   数据大小: ${(responseBody.length / 1024).toFixed(2)} KB`);
        
        // 分析数据结构
        if (jsonData && typeof jsonData === 'object') {
          const keys = Object.keys(jsonData);
          console.log(`   主要字段: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`);
          
          // 检查是否包含视频列表
          if (jsonData.itemList || jsonData.items || jsonData.data) {
            const itemList = jsonData.itemList || jsonData.items || jsonData.data;
            if (Array.isArray(itemList)) {
              console.log(`   ✅ 包含视频列表: ${itemList.length} 个视频`);
              if (itemList.length > 0) {
                const firstItem = itemList[0];
                console.log(`   视频示例字段: ${Object.keys(firstItem).slice(0, 10).join(', ')}`);
              }
            }
          }
        }
      } else if (url.includes('/api/')) {
        console.log(`📥 API 响应: ${status} ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`);
      }
    } catch (error) {
      console.warn(`⚠️  解析响应失败: ${url.substring(0, 80)} - ${error.message}`);
    }
  }
});

// 访问搜索页面
console.log(`\n🌐 正在访问搜索页面: ${searchUrl}`);
try {
  await page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  console.log('✅ 页面加载完成');
} catch (error) {
  console.error('❌ 页面加载失败:', error.message);
  await page.close();
  await browser.close();
  process.exit(1);
}

console.log('⏳ 等待页面初始加载和 API 请求...');
await page.waitForTimeout(5000); // 等待 5 秒，让初始 API 请求完成

// 滚动页面触发更多 API 请求（模拟加载更多搜索结果）
console.log('📜 滚动页面触发更多 API 请求...');
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(3000); // 每次滚动后等待 3 秒
  console.log(`   滚动 ${i + 1}/5 完成`);
}

// 再等待一下，确保所有请求完成
console.log('⏳ 等待所有 API 请求完成...');
await page.waitForTimeout(5000);

console.log('\n' + '='.repeat(80));
console.log('分析结果');
console.log('='.repeat(80));

// 分析 API 请求
console.log(`\n📊 统计信息:`);
console.log(`   总网络请求: ${networkRequests.length}`);
console.log(`   API 请求: ${apiRequests.length}`);
console.log(`   JSON 响应: ${jsonResponses.length}`);
console.log(`   搜索相关 API: ${searchApiResponses.length}`);

// 按 URL 模式分组 API 请求
const apiGroups = {};
apiRequests.forEach(req => {
  // 提取 API 路径模式
  try {
    const urlObj = new URL(req.url);
    const pathname = urlObj.pathname;
    const pathParts = pathname.split('/').filter(p => p);
    
    // 找到 'api' 后面的部分作为分组键
    const apiIndex = pathParts.indexOf('api');
    if (apiIndex >= 0 && apiIndex < pathParts.length - 1) {
      const apiPath = pathParts.slice(apiIndex).join('/');
      if (!apiGroups[apiPath]) {
        apiGroups[apiPath] = [];
      }
      apiGroups[apiPath].push(req);
    }
  } catch (e) {
    // URL 解析失败，跳过
  }
});

// 分析每个 API 的数据结构
console.log(`\n📋 API 分组分析:`);
for (const [apiPath, requests] of Object.entries(apiGroups)) {
  console.log(`\n   ${apiPath}:`);
  console.log(`   请求次数: ${requests.length}`);
  console.log(`   请求方法: ${[...new Set(requests.map(r => r.method))].join(', ')}`);
  
  // 查找对应的响应
  const responses = jsonResponses.filter(r => r.url.includes(apiPath));
  if (responses.length > 0) {
    console.log(`   响应次数: ${responses.length}`);
    
    // 分析数据结构
    const sampleResponse = responses[0];
    if (sampleResponse.data) {
      console.log(`   数据结构:`);
      analyzeDataStructure(sampleResponse.data, '      ', 2);
    }
  }
}

// 详细分析搜索相关的 API
console.log(`\n🎯 搜索相关 API 详细分析:`);
if (searchApiResponses.length === 0) {
  console.log('   ⚠️  未找到搜索相关的 API，可能的原因：');
  console.log('   1. 搜索页面使用了不同的 API 路径');
  console.log('   2. API 请求在页面加载前已完成');
  console.log('   3. 需要登录状态才能访问搜索 API');
} else {
  searchApiResponses.forEach((response, index) => {
    console.log(`\n   ${index + 1}. ${response.url.substring(0, 150)}${response.url.length > 150 ? '...' : ''}`);
    console.log(`      状态码: ${response.status}`);
    console.log(`      数据大小: ${(response.size / 1024).toFixed(2)} KB`);
    
    const data = response.data;
    if (data && typeof data === 'object') {
      // 检查是否包含视频列表
      const itemList = data.itemList || data.items || data.data || (data.itemInfo && data.itemInfo.itemList);
      if (itemList && Array.isArray(itemList)) {
        console.log(`      ✅ 包含视频列表: ${itemList.length} 个视频`);
        
        if (itemList.length > 0) {
          const firstItem = itemList[0];
          console.log(`      视频字段示例:`);
          const itemKeys = Object.keys(firstItem);
          itemKeys.slice(0, 15).forEach(key => {
            const value = firstItem[key];
            const type = Array.isArray(value) ? 'array' : typeof value;
            console.log(`        - ${key}: ${type}${Array.isArray(value) ? `[${value.length}]` : ''}`);
          });
          
          // 检查是否包含作者信息
          if (firstItem.author || firstItem.creator) {
            const author = firstItem.author || firstItem.creator;
            console.log(`      ✅ 包含作者信息: ${author.uniqueId || author.nickName || '未知'}`);
          }
          
          // 检查是否包含统计数据
          if (firstItem.stats || firstItem.statistics) {
            console.log(`      ✅ 包含统计数据`);
          }
        }
      }
      
      // 检查分页信息
      if (data.hasMore !== undefined || data.cursor !== undefined || data.nextCursor) {
        console.log(`      ✅ 支持分页`);
        if (data.hasMore !== undefined) console.log(`        还有更多数据: ${data.hasMore}`);
        if (data.cursor !== undefined) {
          const cursorStr = typeof data.cursor === 'string' ? data.cursor : String(data.cursor);
          console.log(`        游标: ${cursorStr.length > 50 ? cursorStr.substring(0, 50) + '...' : cursorStr}`);
        }
      }
      
      console.log(`      完整数据结构:`);
      console.log(getDataStructure(data));
    }
  });
}

// 分析所有有价值的 API
console.log(`\n🎯 所有有价值的 API 分析:`);
const valuableApis = [];

jsonResponses.forEach(response => {
  const url = response.url;
  const data = response.data;
  
  if (!data || typeof data !== 'object') return;
  
  // 检查是否包含用户信息
  const hasUserInfo = checkForUserInfo(data);
  // 检查是否包含视频信息
  const hasVideoInfo = checkForVideoInfo(data);
  // 检查是否包含统计数据
  const hasStats = checkForStats(data);
  // 检查是否是搜索相关
  const isSearchRelated = url.includes('/api/search/') || 
                         url.includes('/api/recommend/') ||
                         (url.includes('search') && url.includes('/api/'));
  
  if (hasUserInfo || hasVideoInfo || hasStats || isSearchRelated) {
    valuableApis.push({
      url,
      status: response.status,
      hasUserInfo,
      hasVideoInfo,
      hasStats,
      isSearchRelated,
      dataStructure: getDataStructure(data)
    });
  }
});

valuableApis.forEach((api, index) => {
  console.log(`\n   ${index + 1}. ${api.url.substring(0, 120)}${api.url.length > 120 ? '...' : ''}`);
  console.log(`      状态码: ${api.status}`);
  console.log(`      包含数据:`);
  if (api.isSearchRelated) console.log(`        🔍 搜索相关`);
  if (api.hasUserInfo) console.log(`        ✅ 用户信息`);
  if (api.hasVideoInfo) console.log(`        ✅ 视频信息`);
  if (api.hasStats) console.log(`        ✅ 统计数据`);
});

// 保存详细数据到文件
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const reportData = {
  keyword,
  searchUrl,
  timestamp: new Date().toISOString(),
  summary: {
    totalRequests: networkRequests.length,
    apiRequests: apiRequests.length,
    jsonResponses: jsonResponses.length,
    searchApiResponses: searchApiResponses.length,
    valuableApis: valuableApis.length
  },
  apiGroups,
  searchApiResponses: searchApiResponses.map(r => ({
    url: r.url,
    status: r.status,
    size: r.size,
    sampleData: getSampleData(r.data, 5000)
  })),
  valuableApis: valuableApis.map(api => ({
    url: api.url,
    status: api.status,
    hasUserInfo: api.hasUserInfo,
    hasVideoInfo: api.hasVideoInfo,
    hasStats: api.hasStats,
    isSearchRelated: api.isSearchRelated,
    sampleData: getSampleData(jsonResponses.find(r => r.url === api.url)?.data, 3000)
  })),
  allApiRequests: apiRequests.map(r => ({
    url: r.url,
    method: r.method,
    timestamp: r.timestamp
  })),
  allJsonResponses: jsonResponses.map(r => ({
    url: r.url,
    status: r.status,
    contentType: r.contentType,
    size: r.size,
    dataKeys: r.data ? Object.keys(r.data) : []
  }))
};

const reportPath = path.join(logsDir, `tiktok-search-api-analysis-${keyword}-${timestamp}.json`);
fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf-8');
console.log(`\n💾 详细报告已保存到: ${reportPath}`);

// 关闭页面
await page.close();
await browser.close();

console.log('\n✅ 分析完成！');

// 辅助函数
function analyzeDataStructure(obj, indent = '', maxDepth = 3, currentDepth = 0) {
  if (currentDepth >= maxDepth) {
    console.log(`${indent}... (深度限制)`);
    return;
  }
  
  if (Array.isArray(obj)) {
    console.log(`${indent}[数组] 长度: ${obj.length}`);
    if (obj.length > 0) {
      console.log(`${indent}  示例元素:`);
      analyzeDataStructure(obj[0], indent + '  ', maxDepth, currentDepth + 1);
    }
  } else if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    console.log(`${indent}{对象} 字段数: ${keys.length}`);
    keys.slice(0, 10).forEach(key => {
      const value = obj[key];
      const type = Array.isArray(value) ? 'array' : typeof value;
      console.log(`${indent}  ${key}: ${type}${Array.isArray(value) ? `[${value.length}]` : ''}`);
    });
    if (keys.length > 10) {
      console.log(`${indent}  ... (还有 ${keys.length - 10} 个字段)`);
    }
  } else {
    console.log(`${indent}${typeof obj}: ${String(obj).substring(0, 50)}`);
  }
}

function checkForUserInfo(data) {
  if (!data || typeof data !== 'object') return false;
  
  const userKeywords = ['user', 'author', 'creator', 'nickName', 'displayName', 'follower', 'following', 'bio', 'avatar', 'uniqueId'];
  const dataStr = JSON.stringify(data).toLowerCase();
  
  return userKeywords.some(keyword => dataStr.includes(keyword));
}

function checkForVideoInfo(data) {
  if (!data || typeof data !== 'object') return false;
  
  const videoKeywords = ['video', 'item', 'post', 'content', 'videoId', 'playCount', 'diggCount', 'commentCount', 'itemList', 'items'];
  const dataStr = JSON.stringify(data).toLowerCase();
  
  return videoKeywords.some(keyword => dataStr.includes(keyword));
}

function checkForStats(data) {
  if (!data || typeof data !== 'object') return false;
  
  const statsKeywords = ['stats', 'statistics', 'count', 'total', 'sum', 'avg', 'average', 'playCount', 'diggCount'];
  const dataStr = JSON.stringify(data).toLowerCase();
  
  return statsKeywords.some(keyword => dataStr.includes(keyword));
}

function getDataStructure(data, indent = '', maxDepth = 2) {
  if (!data || typeof data !== 'object') {
    return `${indent}${typeof data}`;
  }
  
  if (Array.isArray(data)) {
    if (data.length === 0) return `${indent}[空数组]`;
    return `${indent}[数组: ${data.length} 个元素]\n${getDataStructure(data[0], indent + '  ', maxDepth - 1)}`;
  }
  
  const keys = Object.keys(data);
  let result = `${indent}{对象: ${keys.length} 个字段}\n`;
  
  keys.slice(0, 15).forEach(key => {
    const value = data[key];
    if (Array.isArray(value)) {
      result += `${indent}  ${key}: [数组: ${value.length}]\n`;
    } else if (value && typeof value === 'object') {
      result += `${indent}  ${key}: {对象}\n`;
    } else {
      const preview = String(value).substring(0, 30);
      result += `${indent}  ${key}: ${typeof value}${preview ? ` (${preview}...)` : ''}\n`;
    }
  });
  
  if (keys.length > 15) {
    result += `${indent}  ... (还有 ${keys.length - 15} 个字段)\n`;
  }
  
  return result;
}

function getSampleData(data, maxSize = 1000) {
  if (!data) return null;
  
  const str = JSON.stringify(data);
  if (str.length <= maxSize) {
    return data;
  }
  
  // 返回数据的简化版本
  if (Array.isArray(data)) {
    return data.slice(0, 3).map(item => getSampleData(item, maxSize / 3));
  }
  
  if (typeof data === 'object') {
    const simplified = {};
    const keys = Object.keys(data);
    keys.slice(0, 10).forEach(key => {
      simplified[key] = getSampleData(data[key], maxSize / 10);
    });
    return simplified;
  }
  
  return String(data).substring(0, maxSize);
}


 * 分析 TikTok 搜索页面的网络请求
 * 用于确定需要拦截哪些 API 来获取搜索视频结果和红人数据
 * 
 * 使用方法：
 * 1. 确保已启动 Chrome 并启用远程调试（需要登录状态）：bash scripts/launch-chrome-remote-debug.sh
 * 2. 运行：node scripts/analyze-tiktok-search-api.js <keyword>
 * 
 * 例如：node scripts/analyze-tiktok-search-api.js "beauty"
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 获取命令行参数
const keyword = process.argv[2];
if (!keyword) {
  console.error('❌ 请提供搜索关键词');
  console.log('使用方法: node scripts/analyze-tiktok-search-api.js <keyword>');
  console.log('例如: node scripts/analyze-tiktok-search-api.js "beauty"');
  process.exit(1);
}

const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://localhost:9222';

console.log('='.repeat(80));
console.log('TikTok 搜索页面 API 分析工具');
console.log('='.repeat(80));
console.log(`搜索关键词: ${keyword}`);
console.log(`搜索 URL: ${searchUrl}`);
console.log(`CDP 端点: ${CDP_ENDPOINT}`);
console.log('='.repeat(80));
console.log('');

// 存储所有网络请求
const networkRequests = [];
const apiRequests = [];
const jsonResponses = [];
const searchApiResponses = [];

// 连接 CDP
console.log('🔗 正在连接 CDP...');
let browser, context, page;
try {
  browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const contexts = browser.contexts();
  context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  page = await context.newPage();
  console.log('✅ CDP 连接成功');
} catch (error) {
  console.error('❌ CDP 连接失败:', error.message);
  console.error('💡 请确保已启动 Chrome 并启用远程调试：');
  console.error('   bash scripts/launch-chrome-remote-debug.sh');
  process.exit(1);
}

// 监听所有网络请求
page.on('request', (request) => {
  const url = request.url();
  const method = request.method();
  const resourceType = request.resourceType();
  
  // 只记录 API 相关的请求
  if (url.includes('/api/') || 
      url.includes('tiktok.com/api') ||
      url.includes('tiktokv.com') ||
      url.includes('muscdn.com') ||
      resourceType === 'xhr' ||
      resourceType === 'fetch') {
    
    const requestInfo = {
      url,
      method,
      resourceType,
      headers: request.headers(),
      postData: request.postData(),
      timestamp: new Date().toISOString()
    };
    
    networkRequests.push(requestInfo);
    
    // 特别关注 API 请求
    if (url.includes('/api/')) {
      apiRequests.push(requestInfo);
      console.log(`📡 API 请求: ${method} ${url.substring(0, 100)}${url.length > 100 ? '...' : ''}`);
    }
  }
});

// 监听所有网络响应
page.on('response', async (response) => {
  const url = response.url();
  const status = response.status();
  const contentType = response.headers()['content-type'] || '';
  
  // 只记录 JSON 响应
  if (contentType.includes('application/json') || 
      contentType.includes('text/json') ||
      url.includes('/api/')) {
    
    try {
      const responseBody = await response.text();
      let jsonData = null;
      
      try {
        jsonData = JSON.parse(responseBody);
      } catch (e) {
        // 不是有效的 JSON，跳过
        return;
      }
      
      const responseInfo = {
        url,
        status,
        contentType,
        data: jsonData,
        size: responseBody.length,
        timestamp: new Date().toISOString()
      };
      
      jsonResponses.push(responseInfo);
      
      // 特别关注搜索相关的 API
      const isSearchApi = url.includes('/api/search/') || 
                         url.includes('/api/recommend/') ||
                         url.includes('search') && url.includes('/api/');
      
      if (isSearchApi) {
        searchApiResponses.push(responseInfo);
        console.log(`\n🔍 搜索 API 响应: ${status} ${url.substring(0, 120)}${url.length > 120 ? '...' : ''}`);
        console.log(`   数据大小: ${(responseBody.length / 1024).toFixed(2)} KB`);
        
        // 分析数据结构
        if (jsonData && typeof jsonData === 'object') {
          const keys = Object.keys(jsonData);
          console.log(`   主要字段: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`);
          
          // 检查是否包含视频列表
          if (jsonData.itemList || jsonData.items || jsonData.data) {
            const itemList = jsonData.itemList || jsonData.items || jsonData.data;
            if (Array.isArray(itemList)) {
              console.log(`   ✅ 包含视频列表: ${itemList.length} 个视频`);
              if (itemList.length > 0) {
                const firstItem = itemList[0];
                console.log(`   视频示例字段: ${Object.keys(firstItem).slice(0, 10).join(', ')}`);
              }
            }
          }
        }
      } else if (url.includes('/api/')) {
        console.log(`📥 API 响应: ${status} ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`);
      }
    } catch (error) {
      console.warn(`⚠️  解析响应失败: ${url.substring(0, 80)} - ${error.message}`);
    }
  }
});

// 访问搜索页面
console.log(`\n🌐 正在访问搜索页面: ${searchUrl}`);
try {
  await page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  console.log('✅ 页面加载完成');
} catch (error) {
  console.error('❌ 页面加载失败:', error.message);
  await page.close();
  await browser.close();
  process.exit(1);
}

console.log('⏳ 等待页面初始加载和 API 请求...');
await page.waitForTimeout(5000); // 等待 5 秒，让初始 API 请求完成

// 滚动页面触发更多 API 请求（模拟加载更多搜索结果）
console.log('📜 滚动页面触发更多 API 请求...');
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(3000); // 每次滚动后等待 3 秒
  console.log(`   滚动 ${i + 1}/5 完成`);
}

// 再等待一下，确保所有请求完成
console.log('⏳ 等待所有 API 请求完成...');
await page.waitForTimeout(5000);

console.log('\n' + '='.repeat(80));
console.log('分析结果');
console.log('='.repeat(80));

// 分析 API 请求
console.log(`\n📊 统计信息:`);
console.log(`   总网络请求: ${networkRequests.length}`);
console.log(`   API 请求: ${apiRequests.length}`);
console.log(`   JSON 响应: ${jsonResponses.length}`);
console.log(`   搜索相关 API: ${searchApiResponses.length}`);

// 按 URL 模式分组 API 请求
const apiGroups = {};
apiRequests.forEach(req => {
  // 提取 API 路径模式
  try {
    const urlObj = new URL(req.url);
    const pathname = urlObj.pathname;
    const pathParts = pathname.split('/').filter(p => p);
    
    // 找到 'api' 后面的部分作为分组键
    const apiIndex = pathParts.indexOf('api');
    if (apiIndex >= 0 && apiIndex < pathParts.length - 1) {
      const apiPath = pathParts.slice(apiIndex).join('/');
      if (!apiGroups[apiPath]) {
        apiGroups[apiPath] = [];
      }
      apiGroups[apiPath].push(req);
    }
  } catch (e) {
    // URL 解析失败，跳过
  }
});

// 分析每个 API 的数据结构
console.log(`\n📋 API 分组分析:`);
for (const [apiPath, requests] of Object.entries(apiGroups)) {
  console.log(`\n   ${apiPath}:`);
  console.log(`   请求次数: ${requests.length}`);
  console.log(`   请求方法: ${[...new Set(requests.map(r => r.method))].join(', ')}`);
  
  // 查找对应的响应
  const responses = jsonResponses.filter(r => r.url.includes(apiPath));
  if (responses.length > 0) {
    console.log(`   响应次数: ${responses.length}`);
    
    // 分析数据结构
    const sampleResponse = responses[0];
    if (sampleResponse.data) {
      console.log(`   数据结构:`);
      analyzeDataStructure(sampleResponse.data, '      ', 2);
    }
  }
}

// 详细分析搜索相关的 API
console.log(`\n🎯 搜索相关 API 详细分析:`);
if (searchApiResponses.length === 0) {
  console.log('   ⚠️  未找到搜索相关的 API，可能的原因：');
  console.log('   1. 搜索页面使用了不同的 API 路径');
  console.log('   2. API 请求在页面加载前已完成');
  console.log('   3. 需要登录状态才能访问搜索 API');
} else {
  searchApiResponses.forEach((response, index) => {
    console.log(`\n   ${index + 1}. ${response.url.substring(0, 150)}${response.url.length > 150 ? '...' : ''}`);
    console.log(`      状态码: ${response.status}`);
    console.log(`      数据大小: ${(response.size / 1024).toFixed(2)} KB`);
    
    const data = response.data;
    if (data && typeof data === 'object') {
      // 检查是否包含视频列表
      const itemList = data.itemList || data.items || data.data || (data.itemInfo && data.itemInfo.itemList);
      if (itemList && Array.isArray(itemList)) {
        console.log(`      ✅ 包含视频列表: ${itemList.length} 个视频`);
        
        if (itemList.length > 0) {
          const firstItem = itemList[0];
          console.log(`      视频字段示例:`);
          const itemKeys = Object.keys(firstItem);
          itemKeys.slice(0, 15).forEach(key => {
            const value = firstItem[key];
            const type = Array.isArray(value) ? 'array' : typeof value;
            console.log(`        - ${key}: ${type}${Array.isArray(value) ? `[${value.length}]` : ''}`);
          });
          
          // 检查是否包含作者信息
          if (firstItem.author || firstItem.creator) {
            const author = firstItem.author || firstItem.creator;
            console.log(`      ✅ 包含作者信息: ${author.uniqueId || author.nickName || '未知'}`);
          }
          
          // 检查是否包含统计数据
          if (firstItem.stats || firstItem.statistics) {
            console.log(`      ✅ 包含统计数据`);
          }
        }
      }
      
      // 检查分页信息
      if (data.hasMore !== undefined || data.cursor !== undefined || data.nextCursor) {
        console.log(`      ✅ 支持分页`);
        if (data.hasMore !== undefined) console.log(`        还有更多数据: ${data.hasMore}`);
        if (data.cursor !== undefined) {
          const cursorStr = typeof data.cursor === 'string' ? data.cursor : String(data.cursor);
          console.log(`        游标: ${cursorStr.length > 50 ? cursorStr.substring(0, 50) + '...' : cursorStr}`);
        }
      }
      
      console.log(`      完整数据结构:`);
      console.log(getDataStructure(data));
    }
  });
}

// 分析所有有价值的 API
console.log(`\n🎯 所有有价值的 API 分析:`);
const valuableApis = [];

jsonResponses.forEach(response => {
  const url = response.url;
  const data = response.data;
  
  if (!data || typeof data !== 'object') return;
  
  // 检查是否包含用户信息
  const hasUserInfo = checkForUserInfo(data);
  // 检查是否包含视频信息
  const hasVideoInfo = checkForVideoInfo(data);
  // 检查是否包含统计数据
  const hasStats = checkForStats(data);
  // 检查是否是搜索相关
  const isSearchRelated = url.includes('/api/search/') || 
                         url.includes('/api/recommend/') ||
                         (url.includes('search') && url.includes('/api/'));
  
  if (hasUserInfo || hasVideoInfo || hasStats || isSearchRelated) {
    valuableApis.push({
      url,
      status: response.status,
      hasUserInfo,
      hasVideoInfo,
      hasStats,
      isSearchRelated,
      dataStructure: getDataStructure(data)
    });
  }
});

valuableApis.forEach((api, index) => {
  console.log(`\n   ${index + 1}. ${api.url.substring(0, 120)}${api.url.length > 120 ? '...' : ''}`);
  console.log(`      状态码: ${api.status}`);
  console.log(`      包含数据:`);
  if (api.isSearchRelated) console.log(`        🔍 搜索相关`);
  if (api.hasUserInfo) console.log(`        ✅ 用户信息`);
  if (api.hasVideoInfo) console.log(`        ✅ 视频信息`);
  if (api.hasStats) console.log(`        ✅ 统计数据`);
});

// 保存详细数据到文件
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const reportData = {
  keyword,
  searchUrl,
  timestamp: new Date().toISOString(),
  summary: {
    totalRequests: networkRequests.length,
    apiRequests: apiRequests.length,
    jsonResponses: jsonResponses.length,
    searchApiResponses: searchApiResponses.length,
    valuableApis: valuableApis.length
  },
  apiGroups,
  searchApiResponses: searchApiResponses.map(r => ({
    url: r.url,
    status: r.status,
    size: r.size,
    sampleData: getSampleData(r.data, 5000)
  })),
  valuableApis: valuableApis.map(api => ({
    url: api.url,
    status: api.status,
    hasUserInfo: api.hasUserInfo,
    hasVideoInfo: api.hasVideoInfo,
    hasStats: api.hasStats,
    isSearchRelated: api.isSearchRelated,
    sampleData: getSampleData(jsonResponses.find(r => r.url === api.url)?.data, 3000)
  })),
  allApiRequests: apiRequests.map(r => ({
    url: r.url,
    method: r.method,
    timestamp: r.timestamp
  })),
  allJsonResponses: jsonResponses.map(r => ({
    url: r.url,
    status: r.status,
    contentType: r.contentType,
    size: r.size,
    dataKeys: r.data ? Object.keys(r.data) : []
  }))
};

const reportPath = path.join(logsDir, `tiktok-search-api-analysis-${keyword}-${timestamp}.json`);
fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf-8');
console.log(`\n💾 详细报告已保存到: ${reportPath}`);

// 关闭页面
await page.close();
await browser.close();

console.log('\n✅ 分析完成！');

// 辅助函数
function analyzeDataStructure(obj, indent = '', maxDepth = 3, currentDepth = 0) {
  if (currentDepth >= maxDepth) {
    console.log(`${indent}... (深度限制)`);
    return;
  }
  
  if (Array.isArray(obj)) {
    console.log(`${indent}[数组] 长度: ${obj.length}`);
    if (obj.length > 0) {
      console.log(`${indent}  示例元素:`);
      analyzeDataStructure(obj[0], indent + '  ', maxDepth, currentDepth + 1);
    }
  } else if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    console.log(`${indent}{对象} 字段数: ${keys.length}`);
    keys.slice(0, 10).forEach(key => {
      const value = obj[key];
      const type = Array.isArray(value) ? 'array' : typeof value;
      console.log(`${indent}  ${key}: ${type}${Array.isArray(value) ? `[${value.length}]` : ''}`);
    });
    if (keys.length > 10) {
      console.log(`${indent}  ... (还有 ${keys.length - 10} 个字段)`);
    }
  } else {
    console.log(`${indent}${typeof obj}: ${String(obj).substring(0, 50)}`);
  }
}

function checkForUserInfo(data) {
  if (!data || typeof data !== 'object') return false;
  
  const userKeywords = ['user', 'author', 'creator', 'nickName', 'displayName', 'follower', 'following', 'bio', 'avatar', 'uniqueId'];
  const dataStr = JSON.stringify(data).toLowerCase();
  
  return userKeywords.some(keyword => dataStr.includes(keyword));
}

function checkForVideoInfo(data) {
  if (!data || typeof data !== 'object') return false;
  
  const videoKeywords = ['video', 'item', 'post', 'content', 'videoId', 'playCount', 'diggCount', 'commentCount', 'itemList', 'items'];
  const dataStr = JSON.stringify(data).toLowerCase();
  
  return videoKeywords.some(keyword => dataStr.includes(keyword));
}

function checkForStats(data) {
  if (!data || typeof data !== 'object') return false;
  
  const statsKeywords = ['stats', 'statistics', 'count', 'total', 'sum', 'avg', 'average', 'playCount', 'diggCount'];
  const dataStr = JSON.stringify(data).toLowerCase();
  
  return statsKeywords.some(keyword => dataStr.includes(keyword));
}

function getDataStructure(data, indent = '', maxDepth = 2) {
  if (!data || typeof data !== 'object') {
    return `${indent}${typeof data}`;
  }
  
  if (Array.isArray(data)) {
    if (data.length === 0) return `${indent}[空数组]`;
    return `${indent}[数组: ${data.length} 个元素]\n${getDataStructure(data[0], indent + '  ', maxDepth - 1)}`;
  }
  
  const keys = Object.keys(data);
  let result = `${indent}{对象: ${keys.length} 个字段}\n`;
  
  keys.slice(0, 15).forEach(key => {
    const value = data[key];
    if (Array.isArray(value)) {
      result += `${indent}  ${key}: [数组: ${value.length}]\n`;
    } else if (value && typeof value === 'object') {
      result += `${indent}  ${key}: {对象}\n`;
    } else {
      const preview = String(value).substring(0, 30);
      result += `${indent}  ${key}: ${typeof value}${preview ? ` (${preview}...)` : ''}\n`;
    }
  });
  
  if (keys.length > 15) {
    result += `${indent}  ... (还有 ${keys.length - 15} 个字段)\n`;
  }
  
  return result;
}

function getSampleData(data, maxSize = 1000) {
  if (!data) return null;
  
  const str = JSON.stringify(data);
  if (str.length <= maxSize) {
    return data;
  }
  
  // 返回数据的简化版本
  if (Array.isArray(data)) {
    return data.slice(0, 3).map(item => getSampleData(item, maxSize / 3));
  }
  
  if (typeof data === 'object') {
    const simplified = {};
    const keys = Object.keys(data);
    keys.slice(0, 10).forEach(key => {
      simplified[key] = getSampleData(data[key], maxSize / 10);
    });
    return simplified;
  }
  
  return String(data).substring(0, maxSize);
}


 * 分析 TikTok 搜索页面的网络请求
 * 用于确定需要拦截哪些 API 来获取搜索视频结果和红人数据
 * 
 * 使用方法：
 * 1. 确保已启动 Chrome 并启用远程调试（需要登录状态）：bash scripts/launch-chrome-remote-debug.sh
 * 2. 运行：node scripts/analyze-tiktok-search-api.js <keyword>
 * 
 * 例如：node scripts/analyze-tiktok-search-api.js "beauty"
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 获取命令行参数
const keyword = process.argv[2];
if (!keyword) {
  console.error('❌ 请提供搜索关键词');
  console.log('使用方法: node scripts/analyze-tiktok-search-api.js <keyword>');
  console.log('例如: node scripts/analyze-tiktok-search-api.js "beauty"');
  process.exit(1);
}

const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://localhost:9222';

console.log('='.repeat(80));
console.log('TikTok 搜索页面 API 分析工具');
console.log('='.repeat(80));
console.log(`搜索关键词: ${keyword}`);
console.log(`搜索 URL: ${searchUrl}`);
console.log(`CDP 端点: ${CDP_ENDPOINT}`);
console.log('='.repeat(80));
console.log('');

// 存储所有网络请求
const networkRequests = [];
const apiRequests = [];
const jsonResponses = [];
const searchApiResponses = [];

// 连接 CDP
console.log('🔗 正在连接 CDP...');
let browser, context, page;
try {
  browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const contexts = browser.contexts();
  context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  page = await context.newPage();
  console.log('✅ CDP 连接成功');
} catch (error) {
  console.error('❌ CDP 连接失败:', error.message);
  console.error('💡 请确保已启动 Chrome 并启用远程调试：');
  console.error('   bash scripts/launch-chrome-remote-debug.sh');
  process.exit(1);
}

// 监听所有网络请求
page.on('request', (request) => {
  const url = request.url();
  const method = request.method();
  const resourceType = request.resourceType();
  
  // 只记录 API 相关的请求
  if (url.includes('/api/') || 
      url.includes('tiktok.com/api') ||
      url.includes('tiktokv.com') ||
      url.includes('muscdn.com') ||
      resourceType === 'xhr' ||
      resourceType === 'fetch') {
    
    const requestInfo = {
      url,
      method,
      resourceType,
      headers: request.headers(),
      postData: request.postData(),
      timestamp: new Date().toISOString()
    };
    
    networkRequests.push(requestInfo);
    
    // 特别关注 API 请求
    if (url.includes('/api/')) {
      apiRequests.push(requestInfo);
      console.log(`📡 API 请求: ${method} ${url.substring(0, 100)}${url.length > 100 ? '...' : ''}`);
    }
  }
});

// 监听所有网络响应
page.on('response', async (response) => {
  const url = response.url();
  const status = response.status();
  const contentType = response.headers()['content-type'] || '';
  
  // 只记录 JSON 响应
  if (contentType.includes('application/json') || 
      contentType.includes('text/json') ||
      url.includes('/api/')) {
    
    try {
      const responseBody = await response.text();
      let jsonData = null;
      
      try {
        jsonData = JSON.parse(responseBody);
      } catch (e) {
        // 不是有效的 JSON，跳过
        return;
      }
      
      const responseInfo = {
        url,
        status,
        contentType,
        data: jsonData,
        size: responseBody.length,
        timestamp: new Date().toISOString()
      };
      
      jsonResponses.push(responseInfo);
      
      // 特别关注搜索相关的 API
      const isSearchApi = url.includes('/api/search/') || 
                         url.includes('/api/recommend/') ||
                         url.includes('search') && url.includes('/api/');
      
      if (isSearchApi) {
        searchApiResponses.push(responseInfo);
        console.log(`\n🔍 搜索 API 响应: ${status} ${url.substring(0, 120)}${url.length > 120 ? '...' : ''}`);
        console.log(`   数据大小: ${(responseBody.length / 1024).toFixed(2)} KB`);
        
        // 分析数据结构
        if (jsonData && typeof jsonData === 'object') {
          const keys = Object.keys(jsonData);
          console.log(`   主要字段: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`);
          
          // 检查是否包含视频列表
          if (jsonData.itemList || jsonData.items || jsonData.data) {
            const itemList = jsonData.itemList || jsonData.items || jsonData.data;
            if (Array.isArray(itemList)) {
              console.log(`   ✅ 包含视频列表: ${itemList.length} 个视频`);
              if (itemList.length > 0) {
                const firstItem = itemList[0];
                console.log(`   视频示例字段: ${Object.keys(firstItem).slice(0, 10).join(', ')}`);
              }
            }
          }
        }
      } else if (url.includes('/api/')) {
        console.log(`📥 API 响应: ${status} ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`);
      }
    } catch (error) {
      console.warn(`⚠️  解析响应失败: ${url.substring(0, 80)} - ${error.message}`);
    }
  }
});

// 访问搜索页面
console.log(`\n🌐 正在访问搜索页面: ${searchUrl}`);
try {
  await page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  console.log('✅ 页面加载完成');
} catch (error) {
  console.error('❌ 页面加载失败:', error.message);
  await page.close();
  await browser.close();
  process.exit(1);
}

console.log('⏳ 等待页面初始加载和 API 请求...');
await page.waitForTimeout(5000); // 等待 5 秒，让初始 API 请求完成

// 滚动页面触发更多 API 请求（模拟加载更多搜索结果）
console.log('📜 滚动页面触发更多 API 请求...');
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(3000); // 每次滚动后等待 3 秒
  console.log(`   滚动 ${i + 1}/5 完成`);
}

// 再等待一下，确保所有请求完成
console.log('⏳ 等待所有 API 请求完成...');
await page.waitForTimeout(5000);

console.log('\n' + '='.repeat(80));
console.log('分析结果');
console.log('='.repeat(80));

// 分析 API 请求
console.log(`\n📊 统计信息:`);
console.log(`   总网络请求: ${networkRequests.length}`);
console.log(`   API 请求: ${apiRequests.length}`);
console.log(`   JSON 响应: ${jsonResponses.length}`);
console.log(`   搜索相关 API: ${searchApiResponses.length}`);

// 按 URL 模式分组 API 请求
const apiGroups = {};
apiRequests.forEach(req => {
  // 提取 API 路径模式
  try {
    const urlObj = new URL(req.url);
    const pathname = urlObj.pathname;
    const pathParts = pathname.split('/').filter(p => p);
    
    // 找到 'api' 后面的部分作为分组键
    const apiIndex = pathParts.indexOf('api');
    if (apiIndex >= 0 && apiIndex < pathParts.length - 1) {
      const apiPath = pathParts.slice(apiIndex).join('/');
      if (!apiGroups[apiPath]) {
        apiGroups[apiPath] = [];
      }
      apiGroups[apiPath].push(req);
    }
  } catch (e) {
    // URL 解析失败，跳过
  }
});

// 分析每个 API 的数据结构
console.log(`\n📋 API 分组分析:`);
for (const [apiPath, requests] of Object.entries(apiGroups)) {
  console.log(`\n   ${apiPath}:`);
  console.log(`   请求次数: ${requests.length}`);
  console.log(`   请求方法: ${[...new Set(requests.map(r => r.method))].join(', ')}`);
  
  // 查找对应的响应
  const responses = jsonResponses.filter(r => r.url.includes(apiPath));
  if (responses.length > 0) {
    console.log(`   响应次数: ${responses.length}`);
    
    // 分析数据结构
    const sampleResponse = responses[0];
    if (sampleResponse.data) {
      console.log(`   数据结构:`);
      analyzeDataStructure(sampleResponse.data, '      ', 2);
    }
  }
}

// 详细分析搜索相关的 API
console.log(`\n🎯 搜索相关 API 详细分析:`);
if (searchApiResponses.length === 0) {
  console.log('   ⚠️  未找到搜索相关的 API，可能的原因：');
  console.log('   1. 搜索页面使用了不同的 API 路径');
  console.log('   2. API 请求在页面加载前已完成');
  console.log('   3. 需要登录状态才能访问搜索 API');
} else {
  searchApiResponses.forEach((response, index) => {
    console.log(`\n   ${index + 1}. ${response.url.substring(0, 150)}${response.url.length > 150 ? '...' : ''}`);
    console.log(`      状态码: ${response.status}`);
    console.log(`      数据大小: ${(response.size / 1024).toFixed(2)} KB`);
    
    const data = response.data;
    if (data && typeof data === 'object') {
      // 检查是否包含视频列表
      const itemList = data.itemList || data.items || data.data || (data.itemInfo && data.itemInfo.itemList);
      if (itemList && Array.isArray(itemList)) {
        console.log(`      ✅ 包含视频列表: ${itemList.length} 个视频`);
        
        if (itemList.length > 0) {
          const firstItem = itemList[0];
          console.log(`      视频字段示例:`);
          const itemKeys = Object.keys(firstItem);
          itemKeys.slice(0, 15).forEach(key => {
            const value = firstItem[key];
            const type = Array.isArray(value) ? 'array' : typeof value;
            console.log(`        - ${key}: ${type}${Array.isArray(value) ? `[${value.length}]` : ''}`);
          });
          
          // 检查是否包含作者信息
          if (firstItem.author || firstItem.creator) {
            const author = firstItem.author || firstItem.creator;
            console.log(`      ✅ 包含作者信息: ${author.uniqueId || author.nickName || '未知'}`);
          }
          
          // 检查是否包含统计数据
          if (firstItem.stats || firstItem.statistics) {
            console.log(`      ✅ 包含统计数据`);
          }
        }
      }
      
      // 检查分页信息
      if (data.hasMore !== undefined || data.cursor !== undefined || data.nextCursor) {
        console.log(`      ✅ 支持分页`);
        if (data.hasMore !== undefined) console.log(`        还有更多数据: ${data.hasMore}`);
        if (data.cursor !== undefined) {
          const cursorStr = typeof data.cursor === 'string' ? data.cursor : String(data.cursor);
          console.log(`        游标: ${cursorStr.length > 50 ? cursorStr.substring(0, 50) + '...' : cursorStr}`);
        }
      }
      
      console.log(`      完整数据结构:`);
      console.log(getDataStructure(data));
    }
  });
}

// 分析所有有价值的 API
console.log(`\n🎯 所有有价值的 API 分析:`);
const valuableApis = [];

jsonResponses.forEach(response => {
  const url = response.url;
  const data = response.data;
  
  if (!data || typeof data !== 'object') return;
  
  // 检查是否包含用户信息
  const hasUserInfo = checkForUserInfo(data);
  // 检查是否包含视频信息
  const hasVideoInfo = checkForVideoInfo(data);
  // 检查是否包含统计数据
  const hasStats = checkForStats(data);
  // 检查是否是搜索相关
  const isSearchRelated = url.includes('/api/search/') || 
                         url.includes('/api/recommend/') ||
                         (url.includes('search') && url.includes('/api/'));
  
  if (hasUserInfo || hasVideoInfo || hasStats || isSearchRelated) {
    valuableApis.push({
      url,
      status: response.status,
      hasUserInfo,
      hasVideoInfo,
      hasStats,
      isSearchRelated,
      dataStructure: getDataStructure(data)
    });
  }
});

valuableApis.forEach((api, index) => {
  console.log(`\n   ${index + 1}. ${api.url.substring(0, 120)}${api.url.length > 120 ? '...' : ''}`);
  console.log(`      状态码: ${api.status}`);
  console.log(`      包含数据:`);
  if (api.isSearchRelated) console.log(`        🔍 搜索相关`);
  if (api.hasUserInfo) console.log(`        ✅ 用户信息`);
  if (api.hasVideoInfo) console.log(`        ✅ 视频信息`);
  if (api.hasStats) console.log(`        ✅ 统计数据`);
});

// 保存详细数据到文件
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const reportData = {
  keyword,
  searchUrl,
  timestamp: new Date().toISOString(),
  summary: {
    totalRequests: networkRequests.length,
    apiRequests: apiRequests.length,
    jsonResponses: jsonResponses.length,
    searchApiResponses: searchApiResponses.length,
    valuableApis: valuableApis.length
  },
  apiGroups,
  searchApiResponses: searchApiResponses.map(r => ({
    url: r.url,
    status: r.status,
    size: r.size,
    sampleData: getSampleData(r.data, 5000)
  })),
  valuableApis: valuableApis.map(api => ({
    url: api.url,
    status: api.status,
    hasUserInfo: api.hasUserInfo,
    hasVideoInfo: api.hasVideoInfo,
    hasStats: api.hasStats,
    isSearchRelated: api.isSearchRelated,
    sampleData: getSampleData(jsonResponses.find(r => r.url === api.url)?.data, 3000)
  })),
  allApiRequests: apiRequests.map(r => ({
    url: r.url,
    method: r.method,
    timestamp: r.timestamp
  })),
  allJsonResponses: jsonResponses.map(r => ({
    url: r.url,
    status: r.status,
    contentType: r.contentType,
    size: r.size,
    dataKeys: r.data ? Object.keys(r.data) : []
  }))
};

const reportPath = path.join(logsDir, `tiktok-search-api-analysis-${keyword}-${timestamp}.json`);
fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf-8');
console.log(`\n💾 详细报告已保存到: ${reportPath}`);

// 关闭页面
await page.close();
await browser.close();

console.log('\n✅ 分析完成！');

// 辅助函数
function analyzeDataStructure(obj, indent = '', maxDepth = 3, currentDepth = 0) {
  if (currentDepth >= maxDepth) {
    console.log(`${indent}... (深度限制)`);
    return;
  }
  
  if (Array.isArray(obj)) {
    console.log(`${indent}[数组] 长度: ${obj.length}`);
    if (obj.length > 0) {
      console.log(`${indent}  示例元素:`);
      analyzeDataStructure(obj[0], indent + '  ', maxDepth, currentDepth + 1);
    }
  } else if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    console.log(`${indent}{对象} 字段数: ${keys.length}`);
    keys.slice(0, 10).forEach(key => {
      const value = obj[key];
      const type = Array.isArray(value) ? 'array' : typeof value;
      console.log(`${indent}  ${key}: ${type}${Array.isArray(value) ? `[${value.length}]` : ''}`);
    });
    if (keys.length > 10) {
      console.log(`${indent}  ... (还有 ${keys.length - 10} 个字段)`);
    }
  } else {
    console.log(`${indent}${typeof obj}: ${String(obj).substring(0, 50)}`);
  }
}

function checkForUserInfo(data) {
  if (!data || typeof data !== 'object') return false;
  
  const userKeywords = ['user', 'author', 'creator', 'nickName', 'displayName', 'follower', 'following', 'bio', 'avatar', 'uniqueId'];
  const dataStr = JSON.stringify(data).toLowerCase();
  
  return userKeywords.some(keyword => dataStr.includes(keyword));
}

function checkForVideoInfo(data) {
  if (!data || typeof data !== 'object') return false;
  
  const videoKeywords = ['video', 'item', 'post', 'content', 'videoId', 'playCount', 'diggCount', 'commentCount', 'itemList', 'items'];
  const dataStr = JSON.stringify(data).toLowerCase();
  
  return videoKeywords.some(keyword => dataStr.includes(keyword));
}

function checkForStats(data) {
  if (!data || typeof data !== 'object') return false;
  
  const statsKeywords = ['stats', 'statistics', 'count', 'total', 'sum', 'avg', 'average', 'playCount', 'diggCount'];
  const dataStr = JSON.stringify(data).toLowerCase();
  
  return statsKeywords.some(keyword => dataStr.includes(keyword));
}

function getDataStructure(data, indent = '', maxDepth = 2) {
  if (!data || typeof data !== 'object') {
    return `${indent}${typeof data}`;
  }
  
  if (Array.isArray(data)) {
    if (data.length === 0) return `${indent}[空数组]`;
    return `${indent}[数组: ${data.length} 个元素]\n${getDataStructure(data[0], indent + '  ', maxDepth - 1)}`;
  }
  
  const keys = Object.keys(data);
  let result = `${indent}{对象: ${keys.length} 个字段}\n`;
  
  keys.slice(0, 15).forEach(key => {
    const value = data[key];
    if (Array.isArray(value)) {
      result += `${indent}  ${key}: [数组: ${value.length}]\n`;
    } else if (value && typeof value === 'object') {
      result += `${indent}  ${key}: {对象}\n`;
    } else {
      const preview = String(value).substring(0, 30);
      result += `${indent}  ${key}: ${typeof value}${preview ? ` (${preview}...)` : ''}\n`;
    }
  });
  
  if (keys.length > 15) {
    result += `${indent}  ... (还有 ${keys.length - 15} 个字段)\n`;
  }
  
  return result;
}

function getSampleData(data, maxSize = 1000) {
  if (!data) return null;
  
  const str = JSON.stringify(data);
  if (str.length <= maxSize) {
    return data;
  }
  
  // 返回数据的简化版本
  if (Array.isArray(data)) {
    return data.slice(0, 3).map(item => getSampleData(item, maxSize / 3));
  }
  
  if (typeof data === 'object') {
    const simplified = {};
    const keys = Object.keys(data);
    keys.slice(0, 10).forEach(key => {
      simplified[key] = getSampleData(data[key], maxSize / 10);
    });
    return simplified;
  }
  
  return String(data).substring(0, maxSize);
}

