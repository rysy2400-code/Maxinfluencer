#!/usr/bin/env node
/**
 * 对比手动和自动化浏览的日志，找出差异并生成优化方案
 * 
 * 使用方法：
 * node scripts/compare-logs.js [manual-log-file] [automation-log-file]
 * 
 * 如果不提供参数，会自动查找最新的日志文件
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logsDir = join(__dirname, '../logs');

function findLatestLog(type) {
  const files = readdirSync(logsDir)
    .filter(f => f.startsWith(`${type}-browsing-`) && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? join(logsDir, files[0]) : null;
}

function parseUrl(url) {
  try {
    const urlObj = new URL(url);
    return {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      pathname: urlObj.pathname,
      search: urlObj.search,
      searchParams: Object.fromEntries(urlObj.searchParams),
    };
  } catch (e) {
    return null;
  }
}

function compareHeaders(manualHeaders, autoHeaders) {
  const differences = [];
  const allKeys = new Set([...Object.keys(manualHeaders), ...Object.keys(autoHeaders)]);
  
  for (const key of allKeys) {
    const manual = manualHeaders[key];
    const auto = autoHeaders[key];
    
    if (manual !== auto) {
      differences.push({
        header: key,
        manual: manual || '(缺失)',
        automation: auto || '(缺失)',
      });
    }
  }
  
  return differences;
}

function findApiRequests(requests) {
  return requests.filter(req => {
    const url = req.url.toLowerCase();
    return (
      url.includes('/aweme/') ||
      url.includes('/api/') ||
      url.includes('user') ||
      url.includes('post') ||
      url.includes('prefetch')
    );
  });
}

function compareLogs(manualLog, autoLog) {
  console.log('='.repeat(60));
  console.log('日志对比分析');
  console.log('='.repeat(60));
  console.log('');

  // 基本信息对比
  console.log('📋 基本信息对比:');
  console.log(`   手动浏览 URL: ${manualLog.metadata.pageInfo.finalUrl || manualLog.metadata.pageInfo.url}`);
  console.log(`   自动化浏览 URL: ${autoLog.metadata.pageInfo.url}`);
  console.log(`   手动浏览标题: ${manualLog.metadata.pageInfo.finalTitle || manualLog.metadata.pageInfo.title}`);
  console.log(`   自动化浏览标题: ${autoLog.metadata.pageInfo.title}`);
  console.log('');

  // 网络请求对比
  const manualApiRequests = findApiRequests(manualLog.networkRequests);
  const autoApiRequests = findApiRequests(autoLog.networkRequests);

  console.log('📊 网络请求对比:');
  console.log(`   手动浏览总请求数: ${manualLog.networkRequests.length}`);
  console.log(`   自动化浏览总请求数: ${autoLog.networkRequests.length}`);
  console.log(`   手动浏览 API 请求数: ${manualApiRequests.length}`);
  console.log(`   自动化浏览 API 请求数: ${autoApiRequests.length}`);
  console.log('');

  // 找出关键 API 请求
  const keyApiUrls = new Set();
  manualApiRequests.forEach(req => {
    const parsed = parseUrl(req.url);
    if (parsed) {
      keyApiUrls.add(parsed.pathname);
    }
  });

  console.log('🔍 关键 API 请求对比:');
  console.log('');

  const differences = [];
  
  for (const pathname of keyApiUrls) {
    const manualReq = manualApiRequests.find(r => {
      const parsed = parseUrl(r.url);
      return parsed && parsed.pathname === pathname;
    });
    
    const autoReq = autoApiRequests.find(r => {
      const parsed = parseUrl(r.url);
      return parsed && parsed.pathname === pathname;
    });

    if (manualReq && autoReq) {
      console.log(`   📌 ${pathname}:`);
      console.log(`      手动: ${manualReq.status} ${manualReq.statusText}`);
      console.log(`      自动化: ${autoReq.status} ${autoReq.statusText}`);
      
      // 对比请求头
      const headerDiffs = compareHeaders(manualReq.headers || {}, autoReq.headers || {});
      if (headerDiffs.length > 0) {
        console.log(`      ⚠️  请求头差异:`);
        headerDiffs.forEach(diff => {
          console.log(`         ${diff.header}:`);
          console.log(`           手动: ${diff.manual}`);
          console.log(`           自动化: ${diff.automation}`);
        });
        differences.push({
          type: 'headers',
          url: pathname,
          differences: headerDiffs,
        });
      }

      // 对比响应
      if (manualReq.responseBody && autoReq.responseBody) {
        const manualBody = manualReq.responseBody.substring(0, 200);
        const autoBody = autoReq.responseBody.substring(0, 200);
        if (manualBody !== autoBody) {
          console.log(`      ⚠️  响应内容不同`);
          differences.push({
            type: 'response',
            url: pathname,
            manualLength: manualReq.responseBody.length,
            autoLength: autoReq.responseBody.length,
          });
        }
      }
      
      console.log('');
    } else if (manualReq && !autoReq) {
      console.log(`   ⚠️  ${pathname}: 手动有，自动化缺失`);
      differences.push({
        type: 'missing',
        url: pathname,
      });
    } else if (!manualReq && autoReq) {
      console.log(`   ⚠️  ${pathname}: 自动化有，手动缺失`);
    }
  }

  // 生成优化建议
  console.log('='.repeat(60));
  console.log('💡 优化建议');
  console.log('='.repeat(60));
  console.log('');

  const recommendations = [];

  // 检查 Sec-Fetch-* 头
  const secFetchDiffs = differences
    .filter(d => d.type === 'headers')
    .flatMap(d => d.differences)
    .filter(d => d.header.toLowerCase().startsWith('sec-fetch-'));

  if (secFetchDiffs.length > 0) {
    recommendations.push({
      priority: '高',
      issue: '缺少 Sec-Fetch-* 请求头',
      solution: '在 Playwright 中手动设置这些请求头，使其与真实浏览器一致',
      details: secFetchDiffs.map(d => `  - ${d.header}: 手动=${d.manual}, 自动化=${d.automation}`).join('\n'),
    });
  }

  // 检查 Referer
  const refererDiffs = differences
    .filter(d => d.type === 'headers')
    .flatMap(d => d.differences)
    .filter(d => d.header.toLowerCase() === 'referer');

  if (refererDiffs.length > 0) {
    recommendations.push({
      priority: '高',
      issue: 'Referer 请求头不一致',
      solution: '先访问首页或其他页面，然后再访问目标页面，确保 Referer 正确',
      details: refererDiffs.map(d => `  - 手动: ${d.manual}, 自动化: ${d.automation}`).join('\n'),
    });
  }

  // 检查响应差异
  const responseDiffs = differences.filter(d => d.type === 'response');
  if (responseDiffs.length > 0) {
    recommendations.push({
      priority: '中',
      issue: 'API 响应内容不同',
      solution: '可能是请求参数或请求头导致的，需要进一步分析',
      details: responseDiffs.map(d => `  - ${d.url}: 手动长度=${d.manualLength}, 自动化长度=${d.autoLength}`).join('\n'),
    });
  }

  // 检查缺失的请求
  const missingReqs = differences.filter(d => d.type === 'missing');
  if (missingReqs.length > 0) {
    recommendations.push({
      priority: '中',
      issue: '某些 API 请求在自动化中缺失',
      solution: '检查请求触发条件，可能需要模拟特定的用户行为',
      details: missingReqs.map(d => `  - ${d.url}`).join('\n'),
    });
  }

  if (recommendations.length === 0) {
    console.log('✅ 未发现明显差异，可能需要进一步分析请求时序或行为模式');
  } else {
    recommendations.forEach((rec, i) => {
      console.log(`${i + 1}. [${rec.priority}优先级] ${rec.issue}`);
      console.log(`   解决方案: ${rec.solution}`);
      if (rec.details) {
        console.log(`   详情:`);
        console.log(rec.details);
      }
      console.log('');
    });
  }

  // 保存对比报告
  const report = {
    comparedAt: new Date().toISOString(),
    manualLog: manualLog.metadata,
    autoLog: autoLog.metadata,
    differences,
    recommendations,
  };

  const reportFile = join(logsDir, `comparison-report-${Date.now()}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`📁 对比报告已保存: ${reportFile}`);
  console.log('');
}

// 主函数
async function main() {
  const manualFile = process.argv[2] || findLatestLog('manual');
  const autoFile = process.argv[3] || findLatestLog('automation');

  if (!manualFile || !autoFile) {
    console.error('❌ 错误: 找不到日志文件');
    console.error('');
    console.error('请先运行:');
    console.error('  1. node scripts/collect-manual-browsing-logs.js (收集手动浏览日志)');
    console.error('  2. node scripts/collect-automation-logs.js (收集自动化浏览日志)');
    console.error('');
    console.error('或手动指定日志文件:');
    console.error('  node scripts/compare-logs.js [manual-log-file] [automation-log-file]');
    process.exit(1);
  }

  console.log(`📖 读取手动浏览日志: ${manualFile}`);
  console.log(`📖 读取自动化浏览日志: ${autoFile}`);
  console.log('');

  const manualLog = JSON.parse(readFileSync(manualFile, 'utf-8'));
  const autoLog = JSON.parse(readFileSync(autoFile, 'utf-8'));

  compareLogs(manualLog, autoLog);
}

main().catch(console.error);


 * 对比手动和自动化浏览的日志，找出差异并生成优化方案
 * 
 * 使用方法：
 * node scripts/compare-logs.js [manual-log-file] [automation-log-file]
 * 
 * 如果不提供参数，会自动查找最新的日志文件
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logsDir = join(__dirname, '../logs');

function findLatestLog(type) {
  const files = readdirSync(logsDir)
    .filter(f => f.startsWith(`${type}-browsing-`) && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? join(logsDir, files[0]) : null;
}

function parseUrl(url) {
  try {
    const urlObj = new URL(url);
    return {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      pathname: urlObj.pathname,
      search: urlObj.search,
      searchParams: Object.fromEntries(urlObj.searchParams),
    };
  } catch (e) {
    return null;
  }
}

function compareHeaders(manualHeaders, autoHeaders) {
  const differences = [];
  const allKeys = new Set([...Object.keys(manualHeaders), ...Object.keys(autoHeaders)]);
  
  for (const key of allKeys) {
    const manual = manualHeaders[key];
    const auto = autoHeaders[key];
    
    if (manual !== auto) {
      differences.push({
        header: key,
        manual: manual || '(缺失)',
        automation: auto || '(缺失)',
      });
    }
  }
  
  return differences;
}

function findApiRequests(requests) {
  return requests.filter(req => {
    const url = req.url.toLowerCase();
    return (
      url.includes('/aweme/') ||
      url.includes('/api/') ||
      url.includes('user') ||
      url.includes('post') ||
      url.includes('prefetch')
    );
  });
}

function compareLogs(manualLog, autoLog) {
  console.log('='.repeat(60));
  console.log('日志对比分析');
  console.log('='.repeat(60));
  console.log('');

  // 基本信息对比
  console.log('📋 基本信息对比:');
  console.log(`   手动浏览 URL: ${manualLog.metadata.pageInfo.finalUrl || manualLog.metadata.pageInfo.url}`);
  console.log(`   自动化浏览 URL: ${autoLog.metadata.pageInfo.url}`);
  console.log(`   手动浏览标题: ${manualLog.metadata.pageInfo.finalTitle || manualLog.metadata.pageInfo.title}`);
  console.log(`   自动化浏览标题: ${autoLog.metadata.pageInfo.title}`);
  console.log('');

  // 网络请求对比
  const manualApiRequests = findApiRequests(manualLog.networkRequests);
  const autoApiRequests = findApiRequests(autoLog.networkRequests);

  console.log('📊 网络请求对比:');
  console.log(`   手动浏览总请求数: ${manualLog.networkRequests.length}`);
  console.log(`   自动化浏览总请求数: ${autoLog.networkRequests.length}`);
  console.log(`   手动浏览 API 请求数: ${manualApiRequests.length}`);
  console.log(`   自动化浏览 API 请求数: ${autoApiRequests.length}`);
  console.log('');

  // 找出关键 API 请求
  const keyApiUrls = new Set();
  manualApiRequests.forEach(req => {
    const parsed = parseUrl(req.url);
    if (parsed) {
      keyApiUrls.add(parsed.pathname);
    }
  });

  console.log('🔍 关键 API 请求对比:');
  console.log('');

  const differences = [];
  
  for (const pathname of keyApiUrls) {
    const manualReq = manualApiRequests.find(r => {
      const parsed = parseUrl(r.url);
      return parsed && parsed.pathname === pathname;
    });
    
    const autoReq = autoApiRequests.find(r => {
      const parsed = parseUrl(r.url);
      return parsed && parsed.pathname === pathname;
    });

    if (manualReq && autoReq) {
      console.log(`   📌 ${pathname}:`);
      console.log(`      手动: ${manualReq.status} ${manualReq.statusText}`);
      console.log(`      自动化: ${autoReq.status} ${autoReq.statusText}`);
      
      // 对比请求头
      const headerDiffs = compareHeaders(manualReq.headers || {}, autoReq.headers || {});
      if (headerDiffs.length > 0) {
        console.log(`      ⚠️  请求头差异:`);
        headerDiffs.forEach(diff => {
          console.log(`         ${diff.header}:`);
          console.log(`           手动: ${diff.manual}`);
          console.log(`           自动化: ${diff.automation}`);
        });
        differences.push({
          type: 'headers',
          url: pathname,
          differences: headerDiffs,
        });
      }

      // 对比响应
      if (manualReq.responseBody && autoReq.responseBody) {
        const manualBody = manualReq.responseBody.substring(0, 200);
        const autoBody = autoReq.responseBody.substring(0, 200);
        if (manualBody !== autoBody) {
          console.log(`      ⚠️  响应内容不同`);
          differences.push({
            type: 'response',
            url: pathname,
            manualLength: manualReq.responseBody.length,
            autoLength: autoReq.responseBody.length,
          });
        }
      }
      
      console.log('');
    } else if (manualReq && !autoReq) {
      console.log(`   ⚠️  ${pathname}: 手动有，自动化缺失`);
      differences.push({
        type: 'missing',
        url: pathname,
      });
    } else if (!manualReq && autoReq) {
      console.log(`   ⚠️  ${pathname}: 自动化有，手动缺失`);
    }
  }

  // 生成优化建议
  console.log('='.repeat(60));
  console.log('💡 优化建议');
  console.log('='.repeat(60));
  console.log('');

  const recommendations = [];

  // 检查 Sec-Fetch-* 头
  const secFetchDiffs = differences
    .filter(d => d.type === 'headers')
    .flatMap(d => d.differences)
    .filter(d => d.header.toLowerCase().startsWith('sec-fetch-'));

  if (secFetchDiffs.length > 0) {
    recommendations.push({
      priority: '高',
      issue: '缺少 Sec-Fetch-* 请求头',
      solution: '在 Playwright 中手动设置这些请求头，使其与真实浏览器一致',
      details: secFetchDiffs.map(d => `  - ${d.header}: 手动=${d.manual}, 自动化=${d.automation}`).join('\n'),
    });
  }

  // 检查 Referer
  const refererDiffs = differences
    .filter(d => d.type === 'headers')
    .flatMap(d => d.differences)
    .filter(d => d.header.toLowerCase() === 'referer');

  if (refererDiffs.length > 0) {
    recommendations.push({
      priority: '高',
      issue: 'Referer 请求头不一致',
      solution: '先访问首页或其他页面，然后再访问目标页面，确保 Referer 正确',
      details: refererDiffs.map(d => `  - 手动: ${d.manual}, 自动化: ${d.automation}`).join('\n'),
    });
  }

  // 检查响应差异
  const responseDiffs = differences.filter(d => d.type === 'response');
  if (responseDiffs.length > 0) {
    recommendations.push({
      priority: '中',
      issue: 'API 响应内容不同',
      solution: '可能是请求参数或请求头导致的，需要进一步分析',
      details: responseDiffs.map(d => `  - ${d.url}: 手动长度=${d.manualLength}, 自动化长度=${d.autoLength}`).join('\n'),
    });
  }

  // 检查缺失的请求
  const missingReqs = differences.filter(d => d.type === 'missing');
  if (missingReqs.length > 0) {
    recommendations.push({
      priority: '中',
      issue: '某些 API 请求在自动化中缺失',
      solution: '检查请求触发条件，可能需要模拟特定的用户行为',
      details: missingReqs.map(d => `  - ${d.url}`).join('\n'),
    });
  }

  if (recommendations.length === 0) {
    console.log('✅ 未发现明显差异，可能需要进一步分析请求时序或行为模式');
  } else {
    recommendations.forEach((rec, i) => {
      console.log(`${i + 1}. [${rec.priority}优先级] ${rec.issue}`);
      console.log(`   解决方案: ${rec.solution}`);
      if (rec.details) {
        console.log(`   详情:`);
        console.log(rec.details);
      }
      console.log('');
    });
  }

  // 保存对比报告
  const report = {
    comparedAt: new Date().toISOString(),
    manualLog: manualLog.metadata,
    autoLog: autoLog.metadata,
    differences,
    recommendations,
  };

  const reportFile = join(logsDir, `comparison-report-${Date.now()}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`📁 对比报告已保存: ${reportFile}`);
  console.log('');
}

// 主函数
async function main() {
  const manualFile = process.argv[2] || findLatestLog('manual');
  const autoFile = process.argv[3] || findLatestLog('automation');

  if (!manualFile || !autoFile) {
    console.error('❌ 错误: 找不到日志文件');
    console.error('');
    console.error('请先运行:');
    console.error('  1. node scripts/collect-manual-browsing-logs.js (收集手动浏览日志)');
    console.error('  2. node scripts/collect-automation-logs.js (收集自动化浏览日志)');
    console.error('');
    console.error('或手动指定日志文件:');
    console.error('  node scripts/compare-logs.js [manual-log-file] [automation-log-file]');
    process.exit(1);
  }

  console.log(`📖 读取手动浏览日志: ${manualFile}`);
  console.log(`📖 读取自动化浏览日志: ${autoFile}`);
  console.log('');

  const manualLog = JSON.parse(readFileSync(manualFile, 'utf-8'));
  const autoLog = JSON.parse(readFileSync(autoFile, 'utf-8'));

  compareLogs(manualLog, autoLog);
}

main().catch(console.error);


 * 对比手动和自动化浏览的日志，找出差异并生成优化方案
 * 
 * 使用方法：
 * node scripts/compare-logs.js [manual-log-file] [automation-log-file]
 * 
 * 如果不提供参数，会自动查找最新的日志文件
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logsDir = join(__dirname, '../logs');

function findLatestLog(type) {
  const files = readdirSync(logsDir)
    .filter(f => f.startsWith(`${type}-browsing-`) && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? join(logsDir, files[0]) : null;
}

function parseUrl(url) {
  try {
    const urlObj = new URL(url);
    return {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      pathname: urlObj.pathname,
      search: urlObj.search,
      searchParams: Object.fromEntries(urlObj.searchParams),
    };
  } catch (e) {
    return null;
  }
}

function compareHeaders(manualHeaders, autoHeaders) {
  const differences = [];
  const allKeys = new Set([...Object.keys(manualHeaders), ...Object.keys(autoHeaders)]);
  
  for (const key of allKeys) {
    const manual = manualHeaders[key];
    const auto = autoHeaders[key];
    
    if (manual !== auto) {
      differences.push({
        header: key,
        manual: manual || '(缺失)',
        automation: auto || '(缺失)',
      });
    }
  }
  
  return differences;
}

function findApiRequests(requests) {
  return requests.filter(req => {
    const url = req.url.toLowerCase();
    return (
      url.includes('/aweme/') ||
      url.includes('/api/') ||
      url.includes('user') ||
      url.includes('post') ||
      url.includes('prefetch')
    );
  });
}

function compareLogs(manualLog, autoLog) {
  console.log('='.repeat(60));
  console.log('日志对比分析');
  console.log('='.repeat(60));
  console.log('');

  // 基本信息对比
  console.log('📋 基本信息对比:');
  console.log(`   手动浏览 URL: ${manualLog.metadata.pageInfo.finalUrl || manualLog.metadata.pageInfo.url}`);
  console.log(`   自动化浏览 URL: ${autoLog.metadata.pageInfo.url}`);
  console.log(`   手动浏览标题: ${manualLog.metadata.pageInfo.finalTitle || manualLog.metadata.pageInfo.title}`);
  console.log(`   自动化浏览标题: ${autoLog.metadata.pageInfo.title}`);
  console.log('');

  // 网络请求对比
  const manualApiRequests = findApiRequests(manualLog.networkRequests);
  const autoApiRequests = findApiRequests(autoLog.networkRequests);

  console.log('📊 网络请求对比:');
  console.log(`   手动浏览总请求数: ${manualLog.networkRequests.length}`);
  console.log(`   自动化浏览总请求数: ${autoLog.networkRequests.length}`);
  console.log(`   手动浏览 API 请求数: ${manualApiRequests.length}`);
  console.log(`   自动化浏览 API 请求数: ${autoApiRequests.length}`);
  console.log('');

  // 找出关键 API 请求
  const keyApiUrls = new Set();
  manualApiRequests.forEach(req => {
    const parsed = parseUrl(req.url);
    if (parsed) {
      keyApiUrls.add(parsed.pathname);
    }
  });

  console.log('🔍 关键 API 请求对比:');
  console.log('');

  const differences = [];
  
  for (const pathname of keyApiUrls) {
    const manualReq = manualApiRequests.find(r => {
      const parsed = parseUrl(r.url);
      return parsed && parsed.pathname === pathname;
    });
    
    const autoReq = autoApiRequests.find(r => {
      const parsed = parseUrl(r.url);
      return parsed && parsed.pathname === pathname;
    });

    if (manualReq && autoReq) {
      console.log(`   📌 ${pathname}:`);
      console.log(`      手动: ${manualReq.status} ${manualReq.statusText}`);
      console.log(`      自动化: ${autoReq.status} ${autoReq.statusText}`);
      
      // 对比请求头
      const headerDiffs = compareHeaders(manualReq.headers || {}, autoReq.headers || {});
      if (headerDiffs.length > 0) {
        console.log(`      ⚠️  请求头差异:`);
        headerDiffs.forEach(diff => {
          console.log(`         ${diff.header}:`);
          console.log(`           手动: ${diff.manual}`);
          console.log(`           自动化: ${diff.automation}`);
        });
        differences.push({
          type: 'headers',
          url: pathname,
          differences: headerDiffs,
        });
      }

      // 对比响应
      if (manualReq.responseBody && autoReq.responseBody) {
        const manualBody = manualReq.responseBody.substring(0, 200);
        const autoBody = autoReq.responseBody.substring(0, 200);
        if (manualBody !== autoBody) {
          console.log(`      ⚠️  响应内容不同`);
          differences.push({
            type: 'response',
            url: pathname,
            manualLength: manualReq.responseBody.length,
            autoLength: autoReq.responseBody.length,
          });
        }
      }
      
      console.log('');
    } else if (manualReq && !autoReq) {
      console.log(`   ⚠️  ${pathname}: 手动有，自动化缺失`);
      differences.push({
        type: 'missing',
        url: pathname,
      });
    } else if (!manualReq && autoReq) {
      console.log(`   ⚠️  ${pathname}: 自动化有，手动缺失`);
    }
  }

  // 生成优化建议
  console.log('='.repeat(60));
  console.log('💡 优化建议');
  console.log('='.repeat(60));
  console.log('');

  const recommendations = [];

  // 检查 Sec-Fetch-* 头
  const secFetchDiffs = differences
    .filter(d => d.type === 'headers')
    .flatMap(d => d.differences)
    .filter(d => d.header.toLowerCase().startsWith('sec-fetch-'));

  if (secFetchDiffs.length > 0) {
    recommendations.push({
      priority: '高',
      issue: '缺少 Sec-Fetch-* 请求头',
      solution: '在 Playwright 中手动设置这些请求头，使其与真实浏览器一致',
      details: secFetchDiffs.map(d => `  - ${d.header}: 手动=${d.manual}, 自动化=${d.automation}`).join('\n'),
    });
  }

  // 检查 Referer
  const refererDiffs = differences
    .filter(d => d.type === 'headers')
    .flatMap(d => d.differences)
    .filter(d => d.header.toLowerCase() === 'referer');

  if (refererDiffs.length > 0) {
    recommendations.push({
      priority: '高',
      issue: 'Referer 请求头不一致',
      solution: '先访问首页或其他页面，然后再访问目标页面，确保 Referer 正确',
      details: refererDiffs.map(d => `  - 手动: ${d.manual}, 自动化: ${d.automation}`).join('\n'),
    });
  }

  // 检查响应差异
  const responseDiffs = differences.filter(d => d.type === 'response');
  if (responseDiffs.length > 0) {
    recommendations.push({
      priority: '中',
      issue: 'API 响应内容不同',
      solution: '可能是请求参数或请求头导致的，需要进一步分析',
      details: responseDiffs.map(d => `  - ${d.url}: 手动长度=${d.manualLength}, 自动化长度=${d.autoLength}`).join('\n'),
    });
  }

  // 检查缺失的请求
  const missingReqs = differences.filter(d => d.type === 'missing');
  if (missingReqs.length > 0) {
    recommendations.push({
      priority: '中',
      issue: '某些 API 请求在自动化中缺失',
      solution: '检查请求触发条件，可能需要模拟特定的用户行为',
      details: missingReqs.map(d => `  - ${d.url}`).join('\n'),
    });
  }

  if (recommendations.length === 0) {
    console.log('✅ 未发现明显差异，可能需要进一步分析请求时序或行为模式');
  } else {
    recommendations.forEach((rec, i) => {
      console.log(`${i + 1}. [${rec.priority}优先级] ${rec.issue}`);
      console.log(`   解决方案: ${rec.solution}`);
      if (rec.details) {
        console.log(`   详情:`);
        console.log(rec.details);
      }
      console.log('');
    });
  }

  // 保存对比报告
  const report = {
    comparedAt: new Date().toISOString(),
    manualLog: manualLog.metadata,
    autoLog: autoLog.metadata,
    differences,
    recommendations,
  };

  const reportFile = join(logsDir, `comparison-report-${Date.now()}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`📁 对比报告已保存: ${reportFile}`);
  console.log('');
}

// 主函数
async function main() {
  const manualFile = process.argv[2] || findLatestLog('manual');
  const autoFile = process.argv[3] || findLatestLog('automation');

  if (!manualFile || !autoFile) {
    console.error('❌ 错误: 找不到日志文件');
    console.error('');
    console.error('请先运行:');
    console.error('  1. node scripts/collect-manual-browsing-logs.js (收集手动浏览日志)');
    console.error('  2. node scripts/collect-automation-logs.js (收集自动化浏览日志)');
    console.error('');
    console.error('或手动指定日志文件:');
    console.error('  node scripts/compare-logs.js [manual-log-file] [automation-log-file]');
    process.exit(1);
  }

  console.log(`📖 读取手动浏览日志: ${manualFile}`);
  console.log(`📖 读取自动化浏览日志: ${autoFile}`);
  console.log('');

  const manualLog = JSON.parse(readFileSync(manualFile, 'utf-8'));
  const autoLog = JSON.parse(readFileSync(autoFile, 'utf-8'));

  compareLogs(manualLog, autoLog);
}

main().catch(console.error);

