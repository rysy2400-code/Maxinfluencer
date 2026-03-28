#!/usr/bin/env node

/**
 * 诊断脚本：对比 Chromium 和 Chrome 的浏览器指纹差异
 * 用于找出为什么 Chromium 不能加载视频，而 Chrome 可以
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_URL = 'https://www.tiktok.com/@kathryn.mueller';

/**
 * 获取浏览器指纹信息
 */
async function getBrowserFingerprint(page) {
  return page.evaluate(() => {
    const fp = {};
    
    try {
      // 基础信息
      fp.userAgent = navigator.userAgent;
      fp.platform = navigator.platform;
      fp.language = navigator.language;
      fp.languages = navigator.languages;
    } catch (e) {
      fp.basicInfoError = e.message;
    }
    
    try {
      // 自动化检测相关
      fp.webdriver = navigator.webdriver;
      try {
        fp.webdriverProto = navigator.__proto__?.webdriver;
      } catch (e) {
        fp.webdriverProto = '无法访问';
      }
    } catch (e) {
      fp.webdriverError = e.message;
    }
    
    try {
      // Chrome 特有对象
      fp.chrome = {
        exists: typeof window.chrome !== 'undefined',
        runtime: typeof window.chrome?.runtime !== 'undefined',
        loadTimes: typeof window.chrome?.loadTimes === 'function',
        csi: typeof window.chrome?.csi === 'function',
      };
    } catch (e) {
      fp.chromeError = e.message;
    }
    
    try {
      // Plugins
      fp.plugins = {
        length: navigator.plugins?.length || 0,
        names: navigator.plugins ? Array.from(navigator.plugins).map(p => p.name) : [],
      };
    } catch (e) {
      fp.pluginsError = e.message;
    }
    
    try {
      // 硬件信息
      fp.hardwareConcurrency = navigator.hardwareConcurrency;
      fp.deviceMemory = navigator.deviceMemory;
    } catch (e) {
      fp.hardwareError = e.message;
    }
    
    try {
      // 其他特征
      fp.permissions = {
        query: typeof navigator.permissions?.query === 'function',
      };
    } catch (e) {
      fp.permissionsError = e.message;
    }
    
    try {
      // Playwright 特征
      fp.playwright = {
        __playwright: typeof window.__playwright !== 'undefined',
        __pw_manual: typeof window.__pw_manual !== 'undefined',
        __PUPPETEER_WORLD__: typeof window.__PUPPETEER_WORLD__ !== 'undefined',
      };
    } catch (e) {
      fp.playwrightError = e.message;
    }
    
    try {
      // WebGL 信息
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        fp.webgl = {
          vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
          renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
        };
      } else {
        fp.webgl = null;
      }
    } catch (e) {
      fp.webglError = e.message;
    }
    
    return fp;
  });
}

/**
 * 测试通过 CDP 连接的 Chrome（手动启动的 Chrome）
 */
async function testChromeViaCDP() {
  console.log('='.repeat(60));
  console.log('测试 Chrome (通过 CDP 连接)');
  console.log('='.repeat(60));
  console.log('⚠️  请确保已手动启动 Chrome 并启用远程调试：');
  console.log('   ./scripts/launch-chrome-remote-debug.sh');
  console.log('');
  
  const cdpEndpoint = process.env.CDP_ENDPOINT || 'http://localhost:9222';
  
  const browser = await chromium.connectOverCDP(cdpEndpoint, {
    timeout: 10000,
  });
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  
  const page = await context.newPage();
  
  // === 关键：创建 CDP 会话并启用域（与 collect-automation-logs.js 保持一致）===
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Runtime.enable');
  await client.send('Console.enable');
  
  await page.goto(TEST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  
  await page.waitForTimeout(5000);
  
  const fingerprint = await getBrowserFingerprint(page);
  
  // 检查视频加载
  const videoStatus = await page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
    };
  });
  
  console.log('\n📊 浏览器指纹:');
  console.log(JSON.stringify(fingerprint, null, 2));
  
  console.log('\n📹 视频加载状态:');
  console.log(`  视频链接数量: ${videoStatus.videoLinkCount}`);
  console.log(`  是否加载成功: ${videoStatus.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
  
  // 注意：不关闭浏览器，让用户手动关闭（与 collect-automation-logs.js 的行为类似）
  // 但为了测试流程，这里还是关闭
  await browser.close();
  
  return { fingerprint, videoStatus, method: 'CDP' };
}

/**
 * 测试 Chromium（直接启动）
 */
async function testChromium() {
  console.log('\n' + '='.repeat(60));
  console.log('测试 Chromium (直接启动)');
  console.log('='.repeat(60));
  
  const userDataDir = path.join(__dirname, '../.tiktok-user-data-chromium-test');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  
  const page = await context.newPage();
  
  await page.goto(TEST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  
  await page.waitForTimeout(5000);
  
  const fingerprint = await getBrowserFingerprint(page);
  
  // 检查视频加载
  const videoStatus = await page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
    };
  });
  
  console.log('\n📊 浏览器指纹:');
  console.log(JSON.stringify(fingerprint, null, 2));
  
  console.log('\n📹 视频加载状态:');
  console.log(`  视频链接数量: ${videoStatus.videoLinkCount}`);
  console.log(`  是否加载成功: ${videoStatus.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
  
  await context.close();
  
  return { fingerprint, videoStatus, method: 'launch' };
}

/**
 * 测试 Chrome（直接启动）
 */
async function testChrome() {
  console.log('\n' + '='.repeat(60));
  console.log('测试 Chrome (直接启动)');
  console.log('='.repeat(60));
  
  const userDataDir = path.join(__dirname, '../.tiktok-user-data-chrome-test');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    channel: 'chrome', // 使用系统 Chrome
    args: [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  
  const page = await context.newPage();
  
  await page.goto(TEST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  
  await page.waitForTimeout(5000);
  
  const fingerprint = await getBrowserFingerprint(page);
  
  // 检查视频加载
  const videoStatus = await page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
    };
  });
  
  console.log('\n📊 浏览器指纹:');
  console.log(JSON.stringify(fingerprint, null, 2));
  
  console.log('\n📹 视频加载状态:');
  console.log(`  视频链接数量: ${videoStatus.videoLinkCount}`);
  console.log(`  是否加载成功: ${videoStatus.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
  
  await context.close();
  
  return { fingerprint, videoStatus, method: 'launch' };
}

/**
 * 对比差异
 */
function compareFingerprints(chromiumFp, chromeFp) {
  console.log('\n' + '='.repeat(60));
  console.log('差异对比');
  console.log('='.repeat(60));
  
  const differences = [];
  
  // User-Agent
  if (chromiumFp.userAgent !== chromeFp.userAgent) {
    differences.push({
      key: 'userAgent',
      chromium: chromiumFp.userAgent,
      chrome: chromeFp.userAgent,
    });
  }
  
  // webdriver
  if (chromiumFp.webdriver !== chromeFp.webdriver) {
    differences.push({
      key: 'webdriver',
      chromium: chromiumFp.webdriver,
      chrome: chromeFp.webdriver,
    });
  }
  
  // chrome 对象
  if (chromiumFp.chrome.exists !== chromeFp.chrome.exists) {
    differences.push({
      key: 'chrome.exists',
      chromium: chromiumFp.chrome.exists,
      chrome: chromeFp.chrome.exists,
    });
  }
  
  // plugins
  if (chromiumFp.plugins.length !== chromeFp.plugins.length) {
    differences.push({
      key: 'plugins.length',
      chromium: chromiumFp.plugins.length,
      chrome: chromeFp.plugins.length,
    });
  }
  
  // hardwareConcurrency
  if (chromiumFp.hardwareConcurrency !== chromeFp.hardwareConcurrency) {
    differences.push({
      key: 'hardwareConcurrency',
      chromium: chromiumFp.hardwareConcurrency,
      chrome: chromeFp.hardwareConcurrency,
    });
  }
  
  // deviceMemory
  if (chromiumFp.deviceMemory !== chromeFp.deviceMemory) {
    differences.push({
      key: 'deviceMemory',
      chromium: chromiumFp.deviceMemory,
      chrome: chromeFp.deviceMemory,
    });
  }
  
  if (differences.length > 0) {
    console.log('\n🔍 发现的差异:');
    differences.forEach((diff, i) => {
      console.log(`\n${i + 1}. ${diff.key}:`);
      console.log(`   Chromium: ${JSON.stringify(diff.chromium)}`);
      console.log(`   Chrome:   ${JSON.stringify(diff.chrome)}`);
    });
  } else {
    console.log('\n✅ 未发现明显差异');
  }
  
  return differences;
}

async function main() {
  try {
    console.log('='.repeat(60));
    console.log('浏览器差异诊断工具');
    console.log('='.repeat(60));
    console.log('\n🔍 将测试三种方式：');
    console.log('  1. Chrome (通过 CDP 连接) - 手动启动的 Chrome');
    console.log('  2. Chromium (直接启动) - Playwright 启动的 Chromium');
    console.log('  3. Chrome (直接启动) - Playwright 启动的 Chrome');
    console.log('\n⚠️  注意：测试 1 需要先启动 Chrome 远程调试');
    console.log('   如果未启动，测试 1 会失败，但会继续测试 2 和 3\n');
    console.log('='.repeat(60));
    console.log('');
    
    const results = [];
    
    // 测试 1: Chrome via CDP（最可能成功的方式）
    console.log('🔵 开始测试 1/3: Chrome (通过 CDP 连接)...\n');
    try {
      const cdpResult = await testChromeViaCDP();
      results.push({ name: 'Chrome (CDP)', ...cdpResult });
      console.log('\n✅ Chrome (CDP) 测试完成\n');
    } catch (error) {
      console.error('\n❌ Chrome (CDP) 测试失败:', error.message);
      console.error('   提示: 请先运行以下命令启动 Chrome 远程调试：');
      console.error('   bash scripts/launch-chrome-remote-debug.sh');
      console.error('   或者手动启动 Chrome：');
      console.error('   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=~/.tiktok-user-data\n');
      results.push({ name: 'Chrome (CDP)', error: error.message });
    }
    
    // 测试 2: Chromium (直接启动)
    console.log('🟡 开始测试 2/3: Chromium (直接启动)...\n');
    try {
      const chromiumResult = await testChromium();
      results.push({ name: 'Chromium (launch)', ...chromiumResult });
      console.log('\n✅ Chromium (launch) 测试完成\n');
    } catch (error) {
      console.error('\n❌ Chromium 测试失败:', error.message);
      results.push({ name: 'Chromium (launch)', error: error.message });
    }
    
    // 测试 3: Chrome (直接启动)
    console.log('🟢 开始测试 3/3: Chrome (直接启动)...\n');
    try {
      const chromeResult = await testChrome();
      results.push({ name: 'Chrome (launch)', ...chromeResult });
      console.log('\n✅ Chrome (launch) 测试完成\n');
    } catch (error) {
      console.error('\n❌ Chrome 测试失败:', error.message);
      results.push({ name: 'Chrome (launch)', error: error.message });
    }
    
    // 对比指纹差异（如果都有指纹数据）
    const validResults = results.filter(r => r.fingerprint && !r.error);
    if (validResults.length >= 2) {
      console.log('\n' + '='.repeat(60));
      console.log('指纹差异对比');
      console.log('='.repeat(60));
      
      for (let i = 0; i < validResults.length - 1; i++) {
        const current = validResults[i];
        const next = validResults[i + 1];
        console.log(`\n对比: ${current.name} vs ${next.name}`);
        const differences = compareFingerprints(current.fingerprint, next.fingerprint);
      }
    }
    
    // 总结
    console.log('\n' + '='.repeat(60));
    console.log('总结');
    console.log('='.repeat(60));
    
    results.forEach(result => {
      if (result.error) {
        console.log(`${result.name}: ❌ 测试失败 - ${result.error}`);
      } else {
        const status = result.videoStatus.hasVideoLinks ? '✅ 成功' : '❌ 失败';
        console.log(`${result.name}: ${status} (视频链接: ${result.videoStatus.videoLinkCount})`);
      }
    });
    
    console.log('\n💡 关键发现:');
    const cdpResult = results.find(r => r.name === 'Chrome (CDP)' && !r.error);
    const launchResults = results.filter(r => r.method === 'launch' && !r.error);
    
    if (cdpResult && cdpResult.videoStatus.hasVideoLinks) {
      console.log('  ✅ 通过 CDP 连接的 Chrome 可以正常加载视频');
      console.log('  ❌ 直接启动的浏览器无法加载视频');
      console.log('\n📌 结论:');
      console.log('  TikTok 可以检测到 Playwright 直接启动的浏览器（即使使用真实 Chrome）');
      console.log('  但无法检测通过 CDP 连接的手动启动的 Chrome');
      console.log('\n🎯 建议:');
      console.log('  使用 --connect 模式连接手动启动的 Chrome');
      console.log('  运行: node scripts/test-tiktok-video-fingerprint.js --connect');
    } else if (launchResults.length > 0 && launchResults.every(r => !r.videoStatus.hasVideoLinks)) {
      console.log('  ❌ 所有直接启动的浏览器都无法加载视频');
      console.log('  💡 这证实了 TikTok 可以检测 Playwright 启动的浏览器');
    }
    
  } catch (error) {
    console.error('❌ 诊断失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();


/**
 * 诊断脚本：对比 Chromium 和 Chrome 的浏览器指纹差异
 * 用于找出为什么 Chromium 不能加载视频，而 Chrome 可以
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_URL = 'https://www.tiktok.com/@kathryn.mueller';

/**
 * 获取浏览器指纹信息
 */
async function getBrowserFingerprint(page) {
  return page.evaluate(() => {
    const fp = {};
    
    try {
      // 基础信息
      fp.userAgent = navigator.userAgent;
      fp.platform = navigator.platform;
      fp.language = navigator.language;
      fp.languages = navigator.languages;
    } catch (e) {
      fp.basicInfoError = e.message;
    }
    
    try {
      // 自动化检测相关
      fp.webdriver = navigator.webdriver;
      try {
        fp.webdriverProto = navigator.__proto__?.webdriver;
      } catch (e) {
        fp.webdriverProto = '无法访问';
      }
    } catch (e) {
      fp.webdriverError = e.message;
    }
    
    try {
      // Chrome 特有对象
      fp.chrome = {
        exists: typeof window.chrome !== 'undefined',
        runtime: typeof window.chrome?.runtime !== 'undefined',
        loadTimes: typeof window.chrome?.loadTimes === 'function',
        csi: typeof window.chrome?.csi === 'function',
      };
    } catch (e) {
      fp.chromeError = e.message;
    }
    
    try {
      // Plugins
      fp.plugins = {
        length: navigator.plugins?.length || 0,
        names: navigator.plugins ? Array.from(navigator.plugins).map(p => p.name) : [],
      };
    } catch (e) {
      fp.pluginsError = e.message;
    }
    
    try {
      // 硬件信息
      fp.hardwareConcurrency = navigator.hardwareConcurrency;
      fp.deviceMemory = navigator.deviceMemory;
    } catch (e) {
      fp.hardwareError = e.message;
    }
    
    try {
      // 其他特征
      fp.permissions = {
        query: typeof navigator.permissions?.query === 'function',
      };
    } catch (e) {
      fp.permissionsError = e.message;
    }
    
    try {
      // Playwright 特征
      fp.playwright = {
        __playwright: typeof window.__playwright !== 'undefined',
        __pw_manual: typeof window.__pw_manual !== 'undefined',
        __PUPPETEER_WORLD__: typeof window.__PUPPETEER_WORLD__ !== 'undefined',
      };
    } catch (e) {
      fp.playwrightError = e.message;
    }
    
    try {
      // WebGL 信息
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        fp.webgl = {
          vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
          renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
        };
      } else {
        fp.webgl = null;
      }
    } catch (e) {
      fp.webglError = e.message;
    }
    
    return fp;
  });
}

/**
 * 测试通过 CDP 连接的 Chrome（手动启动的 Chrome）
 */
async function testChromeViaCDP() {
  console.log('='.repeat(60));
  console.log('测试 Chrome (通过 CDP 连接)');
  console.log('='.repeat(60));
  console.log('⚠️  请确保已手动启动 Chrome 并启用远程调试：');
  console.log('   ./scripts/launch-chrome-remote-debug.sh');
  console.log('');
  
  const cdpEndpoint = process.env.CDP_ENDPOINT || 'http://localhost:9222';
  
  const browser = await chromium.connectOverCDP(cdpEndpoint, {
    timeout: 10000,
  });
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  
  const page = await context.newPage();
  
  // === 关键：创建 CDP 会话并启用域（与 collect-automation-logs.js 保持一致）===
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Runtime.enable');
  await client.send('Console.enable');
  
  await page.goto(TEST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  
  await page.waitForTimeout(5000);
  
  const fingerprint = await getBrowserFingerprint(page);
  
  // 检查视频加载
  const videoStatus = await page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
    };
  });
  
  console.log('\n📊 浏览器指纹:');
  console.log(JSON.stringify(fingerprint, null, 2));
  
  console.log('\n📹 视频加载状态:');
  console.log(`  视频链接数量: ${videoStatus.videoLinkCount}`);
  console.log(`  是否加载成功: ${videoStatus.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
  
  // 注意：不关闭浏览器，让用户手动关闭（与 collect-automation-logs.js 的行为类似）
  // 但为了测试流程，这里还是关闭
  await browser.close();
  
  return { fingerprint, videoStatus, method: 'CDP' };
}

/**
 * 测试 Chromium（直接启动）
 */
async function testChromium() {
  console.log('\n' + '='.repeat(60));
  console.log('测试 Chromium (直接启动)');
  console.log('='.repeat(60));
  
  const userDataDir = path.join(__dirname, '../.tiktok-user-data-chromium-test');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  
  const page = await context.newPage();
  
  await page.goto(TEST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  
  await page.waitForTimeout(5000);
  
  const fingerprint = await getBrowserFingerprint(page);
  
  // 检查视频加载
  const videoStatus = await page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
    };
  });
  
  console.log('\n📊 浏览器指纹:');
  console.log(JSON.stringify(fingerprint, null, 2));
  
  console.log('\n📹 视频加载状态:');
  console.log(`  视频链接数量: ${videoStatus.videoLinkCount}`);
  console.log(`  是否加载成功: ${videoStatus.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
  
  await context.close();
  
  return { fingerprint, videoStatus, method: 'launch' };
}

/**
 * 测试 Chrome（直接启动）
 */
async function testChrome() {
  console.log('\n' + '='.repeat(60));
  console.log('测试 Chrome (直接启动)');
  console.log('='.repeat(60));
  
  const userDataDir = path.join(__dirname, '../.tiktok-user-data-chrome-test');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    channel: 'chrome', // 使用系统 Chrome
    args: [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  
  const page = await context.newPage();
  
  await page.goto(TEST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  
  await page.waitForTimeout(5000);
  
  const fingerprint = await getBrowserFingerprint(page);
  
  // 检查视频加载
  const videoStatus = await page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
    };
  });
  
  console.log('\n📊 浏览器指纹:');
  console.log(JSON.stringify(fingerprint, null, 2));
  
  console.log('\n📹 视频加载状态:');
  console.log(`  视频链接数量: ${videoStatus.videoLinkCount}`);
  console.log(`  是否加载成功: ${videoStatus.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
  
  await context.close();
  
  return { fingerprint, videoStatus, method: 'launch' };
}

/**
 * 对比差异
 */
function compareFingerprints(chromiumFp, chromeFp) {
  console.log('\n' + '='.repeat(60));
  console.log('差异对比');
  console.log('='.repeat(60));
  
  const differences = [];
  
  // User-Agent
  if (chromiumFp.userAgent !== chromeFp.userAgent) {
    differences.push({
      key: 'userAgent',
      chromium: chromiumFp.userAgent,
      chrome: chromeFp.userAgent,
    });
  }
  
  // webdriver
  if (chromiumFp.webdriver !== chromeFp.webdriver) {
    differences.push({
      key: 'webdriver',
      chromium: chromiumFp.webdriver,
      chrome: chromeFp.webdriver,
    });
  }
  
  // chrome 对象
  if (chromiumFp.chrome.exists !== chromeFp.chrome.exists) {
    differences.push({
      key: 'chrome.exists',
      chromium: chromiumFp.chrome.exists,
      chrome: chromeFp.chrome.exists,
    });
  }
  
  // plugins
  if (chromiumFp.plugins.length !== chromeFp.plugins.length) {
    differences.push({
      key: 'plugins.length',
      chromium: chromiumFp.plugins.length,
      chrome: chromeFp.plugins.length,
    });
  }
  
  // hardwareConcurrency
  if (chromiumFp.hardwareConcurrency !== chromeFp.hardwareConcurrency) {
    differences.push({
      key: 'hardwareConcurrency',
      chromium: chromiumFp.hardwareConcurrency,
      chrome: chromeFp.hardwareConcurrency,
    });
  }
  
  // deviceMemory
  if (chromiumFp.deviceMemory !== chromeFp.deviceMemory) {
    differences.push({
      key: 'deviceMemory',
      chromium: chromiumFp.deviceMemory,
      chrome: chromeFp.deviceMemory,
    });
  }
  
  if (differences.length > 0) {
    console.log('\n🔍 发现的差异:');
    differences.forEach((diff, i) => {
      console.log(`\n${i + 1}. ${diff.key}:`);
      console.log(`   Chromium: ${JSON.stringify(diff.chromium)}`);
      console.log(`   Chrome:   ${JSON.stringify(diff.chrome)}`);
    });
  } else {
    console.log('\n✅ 未发现明显差异');
  }
  
  return differences;
}

async function main() {
  try {
    console.log('='.repeat(60));
    console.log('浏览器差异诊断工具');
    console.log('='.repeat(60));
    console.log('\n🔍 将测试三种方式：');
    console.log('  1. Chrome (通过 CDP 连接) - 手动启动的 Chrome');
    console.log('  2. Chromium (直接启动) - Playwright 启动的 Chromium');
    console.log('  3. Chrome (直接启动) - Playwright 启动的 Chrome');
    console.log('\n⚠️  注意：测试 1 需要先启动 Chrome 远程调试');
    console.log('   如果未启动，测试 1 会失败，但会继续测试 2 和 3\n');
    console.log('='.repeat(60));
    console.log('');
    
    const results = [];
    
    // 测试 1: Chrome via CDP（最可能成功的方式）
    console.log('🔵 开始测试 1/3: Chrome (通过 CDP 连接)...\n');
    try {
      const cdpResult = await testChromeViaCDP();
      results.push({ name: 'Chrome (CDP)', ...cdpResult });
      console.log('\n✅ Chrome (CDP) 测试完成\n');
    } catch (error) {
      console.error('\n❌ Chrome (CDP) 测试失败:', error.message);
      console.error('   提示: 请先运行以下命令启动 Chrome 远程调试：');
      console.error('   bash scripts/launch-chrome-remote-debug.sh');
      console.error('   或者手动启动 Chrome：');
      console.error('   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=~/.tiktok-user-data\n');
      results.push({ name: 'Chrome (CDP)', error: error.message });
    }
    
    // 测试 2: Chromium (直接启动)
    console.log('🟡 开始测试 2/3: Chromium (直接启动)...\n');
    try {
      const chromiumResult = await testChromium();
      results.push({ name: 'Chromium (launch)', ...chromiumResult });
      console.log('\n✅ Chromium (launch) 测试完成\n');
    } catch (error) {
      console.error('\n❌ Chromium 测试失败:', error.message);
      results.push({ name: 'Chromium (launch)', error: error.message });
    }
    
    // 测试 3: Chrome (直接启动)
    console.log('🟢 开始测试 3/3: Chrome (直接启动)...\n');
    try {
      const chromeResult = await testChrome();
      results.push({ name: 'Chrome (launch)', ...chromeResult });
      console.log('\n✅ Chrome (launch) 测试完成\n');
    } catch (error) {
      console.error('\n❌ Chrome 测试失败:', error.message);
      results.push({ name: 'Chrome (launch)', error: error.message });
    }
    
    // 对比指纹差异（如果都有指纹数据）
    const validResults = results.filter(r => r.fingerprint && !r.error);
    if (validResults.length >= 2) {
      console.log('\n' + '='.repeat(60));
      console.log('指纹差异对比');
      console.log('='.repeat(60));
      
      for (let i = 0; i < validResults.length - 1; i++) {
        const current = validResults[i];
        const next = validResults[i + 1];
        console.log(`\n对比: ${current.name} vs ${next.name}`);
        const differences = compareFingerprints(current.fingerprint, next.fingerprint);
      }
    }
    
    // 总结
    console.log('\n' + '='.repeat(60));
    console.log('总结');
    console.log('='.repeat(60));
    
    results.forEach(result => {
      if (result.error) {
        console.log(`${result.name}: ❌ 测试失败 - ${result.error}`);
      } else {
        const status = result.videoStatus.hasVideoLinks ? '✅ 成功' : '❌ 失败';
        console.log(`${result.name}: ${status} (视频链接: ${result.videoStatus.videoLinkCount})`);
      }
    });
    
    console.log('\n💡 关键发现:');
    const cdpResult = results.find(r => r.name === 'Chrome (CDP)' && !r.error);
    const launchResults = results.filter(r => r.method === 'launch' && !r.error);
    
    if (cdpResult && cdpResult.videoStatus.hasVideoLinks) {
      console.log('  ✅ 通过 CDP 连接的 Chrome 可以正常加载视频');
      console.log('  ❌ 直接启动的浏览器无法加载视频');
      console.log('\n📌 结论:');
      console.log('  TikTok 可以检测到 Playwright 直接启动的浏览器（即使使用真实 Chrome）');
      console.log('  但无法检测通过 CDP 连接的手动启动的 Chrome');
      console.log('\n🎯 建议:');
      console.log('  使用 --connect 模式连接手动启动的 Chrome');
      console.log('  运行: node scripts/test-tiktok-video-fingerprint.js --connect');
    } else if (launchResults.length > 0 && launchResults.every(r => !r.videoStatus.hasVideoLinks)) {
      console.log('  ❌ 所有直接启动的浏览器都无法加载视频');
      console.log('  💡 这证实了 TikTok 可以检测 Playwright 启动的浏览器');
    }
    
  } catch (error) {
    console.error('❌ 诊断失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();


/**
 * 诊断脚本：对比 Chromium 和 Chrome 的浏览器指纹差异
 * 用于找出为什么 Chromium 不能加载视频，而 Chrome 可以
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_URL = 'https://www.tiktok.com/@kathryn.mueller';

/**
 * 获取浏览器指纹信息
 */
async function getBrowserFingerprint(page) {
  return page.evaluate(() => {
    const fp = {};
    
    try {
      // 基础信息
      fp.userAgent = navigator.userAgent;
      fp.platform = navigator.platform;
      fp.language = navigator.language;
      fp.languages = navigator.languages;
    } catch (e) {
      fp.basicInfoError = e.message;
    }
    
    try {
      // 自动化检测相关
      fp.webdriver = navigator.webdriver;
      try {
        fp.webdriverProto = navigator.__proto__?.webdriver;
      } catch (e) {
        fp.webdriverProto = '无法访问';
      }
    } catch (e) {
      fp.webdriverError = e.message;
    }
    
    try {
      // Chrome 特有对象
      fp.chrome = {
        exists: typeof window.chrome !== 'undefined',
        runtime: typeof window.chrome?.runtime !== 'undefined',
        loadTimes: typeof window.chrome?.loadTimes === 'function',
        csi: typeof window.chrome?.csi === 'function',
      };
    } catch (e) {
      fp.chromeError = e.message;
    }
    
    try {
      // Plugins
      fp.plugins = {
        length: navigator.plugins?.length || 0,
        names: navigator.plugins ? Array.from(navigator.plugins).map(p => p.name) : [],
      };
    } catch (e) {
      fp.pluginsError = e.message;
    }
    
    try {
      // 硬件信息
      fp.hardwareConcurrency = navigator.hardwareConcurrency;
      fp.deviceMemory = navigator.deviceMemory;
    } catch (e) {
      fp.hardwareError = e.message;
    }
    
    try {
      // 其他特征
      fp.permissions = {
        query: typeof navigator.permissions?.query === 'function',
      };
    } catch (e) {
      fp.permissionsError = e.message;
    }
    
    try {
      // Playwright 特征
      fp.playwright = {
        __playwright: typeof window.__playwright !== 'undefined',
        __pw_manual: typeof window.__pw_manual !== 'undefined',
        __PUPPETEER_WORLD__: typeof window.__PUPPETEER_WORLD__ !== 'undefined',
      };
    } catch (e) {
      fp.playwrightError = e.message;
    }
    
    try {
      // WebGL 信息
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        fp.webgl = {
          vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
          renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
        };
      } else {
        fp.webgl = null;
      }
    } catch (e) {
      fp.webglError = e.message;
    }
    
    return fp;
  });
}

/**
 * 测试通过 CDP 连接的 Chrome（手动启动的 Chrome）
 */
async function testChromeViaCDP() {
  console.log('='.repeat(60));
  console.log('测试 Chrome (通过 CDP 连接)');
  console.log('='.repeat(60));
  console.log('⚠️  请确保已手动启动 Chrome 并启用远程调试：');
  console.log('   ./scripts/launch-chrome-remote-debug.sh');
  console.log('');
  
  const cdpEndpoint = process.env.CDP_ENDPOINT || 'http://localhost:9222';
  
  const browser = await chromium.connectOverCDP(cdpEndpoint, {
    timeout: 10000,
  });
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  
  const page = await context.newPage();
  
  // === 关键：创建 CDP 会话并启用域（与 collect-automation-logs.js 保持一致）===
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Runtime.enable');
  await client.send('Console.enable');
  
  await page.goto(TEST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  
  await page.waitForTimeout(5000);
  
  const fingerprint = await getBrowserFingerprint(page);
  
  // 检查视频加载
  const videoStatus = await page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
    };
  });
  
  console.log('\n📊 浏览器指纹:');
  console.log(JSON.stringify(fingerprint, null, 2));
  
  console.log('\n📹 视频加载状态:');
  console.log(`  视频链接数量: ${videoStatus.videoLinkCount}`);
  console.log(`  是否加载成功: ${videoStatus.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
  
  // 注意：不关闭浏览器，让用户手动关闭（与 collect-automation-logs.js 的行为类似）
  // 但为了测试流程，这里还是关闭
  await browser.close();
  
  return { fingerprint, videoStatus, method: 'CDP' };
}

/**
 * 测试 Chromium（直接启动）
 */
async function testChromium() {
  console.log('\n' + '='.repeat(60));
  console.log('测试 Chromium (直接启动)');
  console.log('='.repeat(60));
  
  const userDataDir = path.join(__dirname, '../.tiktok-user-data-chromium-test');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  
  const page = await context.newPage();
  
  await page.goto(TEST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  
  await page.waitForTimeout(5000);
  
  const fingerprint = await getBrowserFingerprint(page);
  
  // 检查视频加载
  const videoStatus = await page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
    };
  });
  
  console.log('\n📊 浏览器指纹:');
  console.log(JSON.stringify(fingerprint, null, 2));
  
  console.log('\n📹 视频加载状态:');
  console.log(`  视频链接数量: ${videoStatus.videoLinkCount}`);
  console.log(`  是否加载成功: ${videoStatus.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
  
  await context.close();
  
  return { fingerprint, videoStatus, method: 'launch' };
}

/**
 * 测试 Chrome（直接启动）
 */
async function testChrome() {
  console.log('\n' + '='.repeat(60));
  console.log('测试 Chrome (直接启动)');
  console.log('='.repeat(60));
  
  const userDataDir = path.join(__dirname, '../.tiktok-user-data-chrome-test');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    channel: 'chrome', // 使用系统 Chrome
    args: [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  
  const page = await context.newPage();
  
  await page.goto(TEST_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  
  await page.waitForTimeout(5000);
  
  const fingerprint = await getBrowserFingerprint(page);
  
  // 检查视频加载
  const videoStatus = await page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
    };
  });
  
  console.log('\n📊 浏览器指纹:');
  console.log(JSON.stringify(fingerprint, null, 2));
  
  console.log('\n📹 视频加载状态:');
  console.log(`  视频链接数量: ${videoStatus.videoLinkCount}`);
  console.log(`  是否加载成功: ${videoStatus.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
  
  await context.close();
  
  return { fingerprint, videoStatus, method: 'launch' };
}

/**
 * 对比差异
 */
function compareFingerprints(chromiumFp, chromeFp) {
  console.log('\n' + '='.repeat(60));
  console.log('差异对比');
  console.log('='.repeat(60));
  
  const differences = [];
  
  // User-Agent
  if (chromiumFp.userAgent !== chromeFp.userAgent) {
    differences.push({
      key: 'userAgent',
      chromium: chromiumFp.userAgent,
      chrome: chromeFp.userAgent,
    });
  }
  
  // webdriver
  if (chromiumFp.webdriver !== chromeFp.webdriver) {
    differences.push({
      key: 'webdriver',
      chromium: chromiumFp.webdriver,
      chrome: chromeFp.webdriver,
    });
  }
  
  // chrome 对象
  if (chromiumFp.chrome.exists !== chromeFp.chrome.exists) {
    differences.push({
      key: 'chrome.exists',
      chromium: chromiumFp.chrome.exists,
      chrome: chromeFp.chrome.exists,
    });
  }
  
  // plugins
  if (chromiumFp.plugins.length !== chromeFp.plugins.length) {
    differences.push({
      key: 'plugins.length',
      chromium: chromiumFp.plugins.length,
      chrome: chromeFp.plugins.length,
    });
  }
  
  // hardwareConcurrency
  if (chromiumFp.hardwareConcurrency !== chromeFp.hardwareConcurrency) {
    differences.push({
      key: 'hardwareConcurrency',
      chromium: chromiumFp.hardwareConcurrency,
      chrome: chromeFp.hardwareConcurrency,
    });
  }
  
  // deviceMemory
  if (chromiumFp.deviceMemory !== chromeFp.deviceMemory) {
    differences.push({
      key: 'deviceMemory',
      chromium: chromiumFp.deviceMemory,
      chrome: chromeFp.deviceMemory,
    });
  }
  
  if (differences.length > 0) {
    console.log('\n🔍 发现的差异:');
    differences.forEach((diff, i) => {
      console.log(`\n${i + 1}. ${diff.key}:`);
      console.log(`   Chromium: ${JSON.stringify(diff.chromium)}`);
      console.log(`   Chrome:   ${JSON.stringify(diff.chrome)}`);
    });
  } else {
    console.log('\n✅ 未发现明显差异');
  }
  
  return differences;
}

async function main() {
  try {
    console.log('='.repeat(60));
    console.log('浏览器差异诊断工具');
    console.log('='.repeat(60));
    console.log('\n🔍 将测试三种方式：');
    console.log('  1. Chrome (通过 CDP 连接) - 手动启动的 Chrome');
    console.log('  2. Chromium (直接启动) - Playwright 启动的 Chromium');
    console.log('  3. Chrome (直接启动) - Playwright 启动的 Chrome');
    console.log('\n⚠️  注意：测试 1 需要先启动 Chrome 远程调试');
    console.log('   如果未启动，测试 1 会失败，但会继续测试 2 和 3\n');
    console.log('='.repeat(60));
    console.log('');
    
    const results = [];
    
    // 测试 1: Chrome via CDP（最可能成功的方式）
    console.log('🔵 开始测试 1/3: Chrome (通过 CDP 连接)...\n');
    try {
      const cdpResult = await testChromeViaCDP();
      results.push({ name: 'Chrome (CDP)', ...cdpResult });
      console.log('\n✅ Chrome (CDP) 测试完成\n');
    } catch (error) {
      console.error('\n❌ Chrome (CDP) 测试失败:', error.message);
      console.error('   提示: 请先运行以下命令启动 Chrome 远程调试：');
      console.error('   bash scripts/launch-chrome-remote-debug.sh');
      console.error('   或者手动启动 Chrome：');
      console.error('   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=~/.tiktok-user-data\n');
      results.push({ name: 'Chrome (CDP)', error: error.message });
    }
    
    // 测试 2: Chromium (直接启动)
    console.log('🟡 开始测试 2/3: Chromium (直接启动)...\n');
    try {
      const chromiumResult = await testChromium();
      results.push({ name: 'Chromium (launch)', ...chromiumResult });
      console.log('\n✅ Chromium (launch) 测试完成\n');
    } catch (error) {
      console.error('\n❌ Chromium 测试失败:', error.message);
      results.push({ name: 'Chromium (launch)', error: error.message });
    }
    
    // 测试 3: Chrome (直接启动)
    console.log('🟢 开始测试 3/3: Chrome (直接启动)...\n');
    try {
      const chromeResult = await testChrome();
      results.push({ name: 'Chrome (launch)', ...chromeResult });
      console.log('\n✅ Chrome (launch) 测试完成\n');
    } catch (error) {
      console.error('\n❌ Chrome 测试失败:', error.message);
      results.push({ name: 'Chrome (launch)', error: error.message });
    }
    
    // 对比指纹差异（如果都有指纹数据）
    const validResults = results.filter(r => r.fingerprint && !r.error);
    if (validResults.length >= 2) {
      console.log('\n' + '='.repeat(60));
      console.log('指纹差异对比');
      console.log('='.repeat(60));
      
      for (let i = 0; i < validResults.length - 1; i++) {
        const current = validResults[i];
        const next = validResults[i + 1];
        console.log(`\n对比: ${current.name} vs ${next.name}`);
        const differences = compareFingerprints(current.fingerprint, next.fingerprint);
      }
    }
    
    // 总结
    console.log('\n' + '='.repeat(60));
    console.log('总结');
    console.log('='.repeat(60));
    
    results.forEach(result => {
      if (result.error) {
        console.log(`${result.name}: ❌ 测试失败 - ${result.error}`);
      } else {
        const status = result.videoStatus.hasVideoLinks ? '✅ 成功' : '❌ 失败';
        console.log(`${result.name}: ${status} (视频链接: ${result.videoStatus.videoLinkCount})`);
      }
    });
    
    console.log('\n💡 关键发现:');
    const cdpResult = results.find(r => r.name === 'Chrome (CDP)' && !r.error);
    const launchResults = results.filter(r => r.method === 'launch' && !r.error);
    
    if (cdpResult && cdpResult.videoStatus.hasVideoLinks) {
      console.log('  ✅ 通过 CDP 连接的 Chrome 可以正常加载视频');
      console.log('  ❌ 直接启动的浏览器无法加载视频');
      console.log('\n📌 结论:');
      console.log('  TikTok 可以检测到 Playwright 直接启动的浏览器（即使使用真实 Chrome）');
      console.log('  但无法检测通过 CDP 连接的手动启动的 Chrome');
      console.log('\n🎯 建议:');
      console.log('  使用 --connect 模式连接手动启动的 Chrome');
      console.log('  运行: node scripts/test-tiktok-video-fingerprint.js --connect');
    } else if (launchResults.length > 0 && launchResults.every(r => !r.videoStatus.hasVideoLinks)) {
      console.log('  ❌ 所有直接启动的浏览器都无法加载视频');
      console.log('  💡 这证实了 TikTok 可以检测 Playwright 启动的浏览器');
    }
    
  } catch (error) {
    console.error('❌ 诊断失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

