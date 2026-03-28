#!/usr/bin/env node

/**
 * 测试脚本：使用 Playwright + Chromium/Chrome 打开指定 TikTok 红人视频主页
 * 
 * 【简化版】参考 collect-automation-logs.js 的极简方式：
 * - 不注入任何反检测脚本（过度伪装可能被检测）
 * - 不模拟用户行为（鼠标移动、滚动等）
 * - 只保留最基本的浏览器启动参数
 * - 优先使用连接模式（连接手动启动的 Chrome）
 * 
 * 运行方式：
 *   node scripts/test-tiktok-video-fingerprint.js              # 使用 Chromium（默认）
 *   node scripts/test-tiktok-video-fingerprint.js --chrome     # 使用系统 Chrome
 *   node scripts/test-tiktok-video-fingerprint.js --connect    # 【推荐】连接已手动启动的 Chrome（无自动化提示）
 *
 * 可选环境变量：
 *   TIKTOK_USER_DATA_DIR=/path/to/tiktok-user-data
 *   BROWSER=chrome|chromium  (默认: chromium)
 *   CDP_ENDPOINT=http://localhost:9222  (--connect 模式下的 CDP 地址)
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import readline from 'readline';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 检测使用 Chrome 还是 Chromium
const useChrome =
  process.argv.includes('--chrome') ||
  process.env.BROWSER === 'chrome' ||
  process.env.BROWSER === 'Chrome';

// 检测是否使用连接模式（连接已手动启动的 Chrome，可规避自动化检测）
const useConnect =
  process.argv.includes('--connect') ||
  process.env.CONNECT_MODE === 'true' ||
  process.env.CONNECT_MODE === '1';

// CDP 连接地址（仅 --connect 模式使用）
const cdpEndpoint = process.env.CDP_ENDPOINT || 'http://localhost:9222';

// 使用与主流程一致的用户数据目录（保持登录状态）
const defaultUserDataDir = useChrome
  ? path.join(__dirname, '../.tiktok-user-data-chrome-test')
  : path.join(__dirname, '../.tiktok-user-data');

const userDataDir = process.env.TIKTOK_USER_DATA_DIR || defaultUserDataDir;

if (process.env.TIKTOK_USER_DATA_DIR) {
  console.log(`[test-tiktok-video] ✅ 使用环境变量指定的用户数据目录: ${userDataDir}`);
}

// 要测试的红人主页
const TEST_VIDEO_URL = 'https://www.tiktok.com/@kathryn.mueller';

// 清理浏览器锁文件（避免重复启动时冲突）
async function cleanupBrowserLock(dir) {
  try {
    const lockFile = path.join(dir, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      console.log(`[test-tiktok-video] 检测到锁文件，尝试清理: ${lockFile}`);
      fs.unlinkSync(lockFile);
      console.log('[test-tiktok-video] ✅ 锁文件已清理');
    }
  } catch (e) {
    console.warn('[test-tiktok-video] 清理锁文件失败:', e.message);
  }
}

/**
 * 创建交互式命令行界面
 */
function createInteractiveCLI(page, context, options = {}) {
  const { useConnect, browser } = options;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const printHelp = () => {
    console.log('\n可用命令:');
    console.log('  check          - 检查视频加载状态');
    console.log('  refresh        - 刷新当前页面');
    console.log('  newtab         - 在新标签页打开测试链接');
    console.log('  help           - 显示帮助信息');
    console.log('  exit / quit    - 退出并关闭浏览器');
    console.log('');
  };

  const handleCommand = async (input) => {
    const [cmd] = input.trim().split(/\s+/);

    try {
      switch (cmd.toLowerCase()) {
        case 'refresh':
          console.log('\n[CLI] 正在刷新页面...');
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(5000);
          console.log('[CLI] ✅ 页面已刷新');
          break;

        case 'check': {
          console.log('\n[CLI] 正在检查视频状态...');
          const status = await checkVideoLoaded(page);
          console.log(`  是否存在视频链接: ${status.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
          console.log(`  视频链接数量: ${status.videoLinkCount}`);
          console.log(`  视频容器数量: ${status.videoItemCount}`);
          console.log(`  缩略图数量: ${status.thumbnailCount}`);
          console.log(`  是否存在 <video> 元素: ${status.hasVideoElements ? '✅ 是' : '❌ 否（主页通常没有）'}`);
          if (status.hasVideoElements) {
            console.log(`  <video> 元素数量: ${status.videoElementCount}`);
            console.log(`  readyState 列表: [${status.readyStates.join(', ')}]`);
            console.log(`  正在播放的视频: ${status.playingCount}`);
          }
          if (status.hasError) {
            console.log(`  ⚠️  页面错误: ${status.errorHint}`);
          }
          break;
        }

        case 'newtab': {
          console.log('\n[CLI] 正在新标签页打开测试链接...');
          const newPage = await context.newPage();
          await newPage.goto(TEST_VIDEO_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          });
          await newPage.waitForTimeout(5000);
          console.log('[CLI] ✅ 新标签页已打开');
          break;
        }

        case 'help':
          printHelp();
          break;

        case 'exit':
        case 'quit':
          console.log('\n[CLI] 正在退出...');
          rl.close();
          if (useConnect && browser) {
            await browser.close();
          } else if (context) {
            await context.close();
          }
          process.exit(0);
          break;

        default:
          if (cmd) {
            console.log(`\n[CLI] ❌ 未知命令: ${cmd}`);
            console.log('[CLI] 输入 "help" 查看可用命令');
          }
      }
    } catch (error) {
      console.error(`\n[CLI] ❌ 执行命令时出错: ${error.message}`);
    }

    rl.prompt();
  };

  printHelp();
  rl.setPrompt('\n> ');
  rl.prompt();
  rl.on('line', handleCommand);
  rl.on('close', async () => {
    if (useConnect && browser) {
      await browser.close();
    } else if (context) {
      await context.close();
    }
    process.exit(0);
  });

  return rl;
}

/**
 * 检测 TikTok 主页视频是否已加载
 */
async function checkVideoLoaded(page) {
  return page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    const videoItems = Array.from(document.querySelectorAll(
      '[data-e2e*="video"], ' +
      '[class*="video-item"], ' +
      '[class*="VideoItem"], ' +
      '[class*="video-card"], ' +
      'div[class*="DivVideoContainer"], ' +
      'div[class*="VideoContainer"]'
    ));
    const thumbnails = Array.from(document.querySelectorAll(
      'img[alt*="video"], ' +
      'img[src*="video"], ' +
      'img[src*="tiktok"], ' +
      'div[class*="thumbnail"]'
    ));
    const videoElements = Array.from(document.querySelectorAll('video'));
    
    const pageText = document.body.innerText || '';
    const errorMessages = [
      'Something went wrong', 'Sorry about that!', 'Please try again later',
      '需要登录', 'Login to TikTok', 'Log in to see more',
      'This page isn\'t available', 'Page not found',
      'Access denied', 'Blocked', 'Rate limit'
    ];
    const hasError = errorMessages.some(msg => 
      pageText.toLowerCase().includes(msg.toLowerCase())
    );
    
    const mainContent = document.querySelector('main') || 
                       document.querySelector('[role="main"]') ||
                       document.querySelector('div[class*="Main"]');
    
    const pageTitle = document.title || '';
    const titleHasError = errorMessages.some(msg => 
      pageTitle.toLowerCase().includes(msg.toLowerCase())
    );
    
    const images = Array.from(document.querySelectorAll('img'));
    const loadedImages = images.filter(img => img.complete && img.naturalHeight > 0);
    
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
      videoItemCount: videoItems.length,
      thumbnailCount: thumbnails.length,
      hasVideoElements: videoElements.length > 0,
      videoElementCount: videoElements.length,
      readyStates: videoElements.map((v) => v.readyState),
      playingCount: videoElements.filter((v) => {
        try {
          return !v.paused && !v.ended && v.readyState >= 2 && v.currentTime > 0;
        } catch {
          return false;
        }
      }).length,
      hasError: hasError || titleHasError,
      errorHint: (hasError || titleHasError) ? '页面可能显示错误提示，需要检查是否需要登录或是否被风控' : null,
      hasMainContent: !!mainContent,
      imageCount: images.length,
      loadedImageCount: loadedImages.length,
      location: window.location.href,
      pageTitle: pageTitle,
    };
  });
}

async function main() {
  const browserName = useChrome ? 'Chrome' : 'Chromium';
  console.log('='.repeat(60));
  console.log(`测试：Playwright + ${browserName} 打开 TikTok 红人视频主页`);
  console.log('='.repeat(60));
  if (useConnect) {
    console.log('模式: 【连接模式】连接已手动启动的 Chrome（无自动化提示）');
    console.log(`CDP 地址: ${cdpEndpoint}`);
  } else {
    console.log(`浏览器类型: ${browserName} ${useChrome ? '(系统 Chrome)' : '(Playwright Chromium)'}`);
    console.log(`用户数据目录: ${userDataDir}`);
  }
  console.log(`测试视频链接: ${TEST_VIDEO_URL}`);
  console.log('');

  let context;
  let browser;

  try {
    if (useConnect) {
      // === 连接模式：连接已手动启动的 Chrome ===
      console.log('[test-tiktok-video] 正在连接已启动的 Chrome...');
      console.log('[test-tiktok-video] 请确保已运行: ./scripts/launch-chrome-remote-debug.sh');
      console.log('');

      browser = await chromium.connectOverCDP(cdpEndpoint, {
        timeout: 10000,
      });

      const contexts = browser.contexts();
      context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    } else {
      // === 启动模式：使用 Playwright 启动浏览器 ===
      await cleanupBrowserLock(userDataDir);
      console.log(`[test-tiktok-video] 正在启动 ${browserName}（持久化上下文，非 headless）...`);

      const launchOptions = {
        headless: false,
        viewport: { width: 1280, height: 720 },
        args: [
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      };

      if (useChrome) {
        launchOptions.channel = 'chrome';
        console.log('[test-tiktok-video] 使用系统安装的 Chrome 浏览器');
      }

      context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      
      // === 关键：只为 Chromium 添加最基础的 chrome 对象伪装 ===
      // Chrome 本身就有 window.chrome 对象，不需要伪装
      // 但 Chromium 没有，TikTok 可能依赖这个特征来区分浏览器
      if (!useChrome) {
        await context.addInitScript(() => {
          // 只添加最基础的 chrome 对象，不过度伪装
          if (typeof window.chrome === 'undefined') {
            window.chrome = {
              runtime: {},
            };
          }
        });
        console.log('[test-tiktok-video] ✅ 已为 Chromium 添加基础 chrome 对象伪装');
      }
    }

    console.log(`[test-tiktok-video] ✅ ${useConnect ? '已连接' : browserName + ' 已启动'}`);

    const page = await context.newPage();

    console.log('[test-tiktok-video] 正在访问测试视频链接...');

    // 访问页面（极简方式：只等待 domcontentloaded，然后等待 5 秒）
    await page.goto(TEST_VIDEO_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // 等待页面加载（参考 collect-automation-logs.js 的 5 秒等待）
    await page.waitForTimeout(5000);

    // 检查页面基本状态
    console.log('\n' + '='.repeat(60));
    console.log('[test-tiktok-video] 页面状态检查');
    console.log('='.repeat(60));

    const pageState = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        bodyExists: !!document.body,
        bodyHasContent: document.body ? document.body.innerHTML.length > 0 : false,
        bodyTextLength: document.body ? document.body.innerText.length : 0,
        bodyTextPreview: document.body ? document.body.innerText.substring(0, 200) : '',
      };
    });

    console.log(`\n📄 基本状态:`);
    console.log(`  URL: ${pageState.url}`);
    console.log(`  标题: ${pageState.title}`);
    console.log(`  readyState: ${pageState.readyState}`);
    console.log(`  body 存在: ${pageState.bodyExists ? '✅' : '❌'}`);
    console.log(`  body 有内容: ${pageState.bodyHasContent ? '✅' : '❌'}`);
    console.log(`  body 文本长度: ${pageState.bodyTextLength} 字符`);
    if (pageState.bodyTextPreview) {
      console.log(`  body 文本预览: ${pageState.bodyTextPreview}...`);
    }

    console.log('\n' + '='.repeat(60));

    // 检查视频加载状态
    console.log('[test-tiktok-video] 检查视频加载状态...');
    const status = await checkVideoLoaded(page);

    console.log('');
    console.log('='.repeat(60));
    console.log('初始检测结果');
    console.log('='.repeat(60));
    console.log(`是否存在视频链接: ${status.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
    console.log(`视频链接数量: ${status.videoLinkCount}`);
    console.log(`视频容器数量: ${status.videoItemCount}`);
    console.log(`缩略图数量: ${status.thumbnailCount}`);
    console.log(`是否有主要内容区域: ${status.hasMainContent ? '✅ 是' : '❌ 否'}`);
    console.log(`图片总数: ${status.imageCount}, 已加载: ${status.loadedImageCount}`);
    if (status.hasError) {
      console.log(`⚠️  页面错误: ${status.errorHint}`);
    }
    console.log(`页面标题: ${status.pageTitle}`);
    console.log(`当前 URL: ${status.location}`);
    console.log('');

    if (!status.hasVideoLinks && status.videoLinkCount === 0) {
      console.log('⚠️  未检测到视频链接，可能的原因：');
      console.log('  1. 需要登录 TikTok 账户');
      console.log('  2. 页面加载未完成（尝试等待更长时间）');
      console.log('  3. TikTok 检测到自动化并阻止了内容加载');
      console.log('  4. 网络问题或页面错误');
      console.log('');
      console.log('建议：');
      console.log('  - 在浏览器中手动检查页面是否正常显示');
      console.log('  - 检查是否需要登录');
      console.log('  - 尝试使用 refresh 命令刷新页面');
      console.log('');
    }
    console.log('='.repeat(60));
    console.log('交互式测试模式已启动');
    console.log('='.repeat(60));
    console.log('浏览器窗口会保持打开，你可以在终端输入命令来测试。');
    console.log('输入 "help" 查看可用命令。');
    console.log('');

    // 启动交互式命令行界面
    createInteractiveCLI(page, context, { useConnect, browser });
  } catch (error) {
    console.error('[test-tiktok-video] ❌ 发生错误:', error.message);
    if (useConnect) {
      console.error('\n提示: 连接模式需要先手动启动 Chrome：');
      console.error('  ./scripts/launch-chrome-remote-debug.sh');
    } else if (error.message.includes('channel') || error.message.includes('Chrome')) {
      console.error('\n提示: 如果使用 --chrome 参数，请确保系统已安装 Chrome 浏览器');
      console.error('或者尝试 --connect 模式: node scripts/test-tiktok-video-fingerprint.js --connect');
    }
    console.error(error.stack);
    if (context && !useConnect) {
      await context.close();
    }
    if (browser && useConnect) {
      await browser.close();
    }
    process.exit(1);
  }
}

main();

/**
 * 测试脚本：使用 Playwright + Chromium/Chrome 打开指定 TikTok 红人视频主页
 * 
 * 【简化版】参考 collect-automation-logs.js 的极简方式：
 * - 不注入任何反检测脚本（过度伪装可能被检测）
 * - 不模拟用户行为（鼠标移动、滚动等）
 * - 只保留最基本的浏览器启动参数
 * - 优先使用连接模式（连接手动启动的 Chrome）
 * 
 * 运行方式：
 *   node scripts/test-tiktok-video-fingerprint.js              # 使用 Chromium（默认）
 *   node scripts/test-tiktok-video-fingerprint.js --chrome     # 使用系统 Chrome
 *   node scripts/test-tiktok-video-fingerprint.js --connect    # 【推荐】连接已手动启动的 Chrome（无自动化提示）
 *
 * 可选环境变量：
 *   TIKTOK_USER_DATA_DIR=/path/to/tiktok-user-data
 *   BROWSER=chrome|chromium  (默认: chromium)
 *   CDP_ENDPOINT=http://localhost:9222  (--connect 模式下的 CDP 地址)
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import readline from 'readline';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 检测使用 Chrome 还是 Chromium
const useChrome =
  process.argv.includes('--chrome') ||
  process.env.BROWSER === 'chrome' ||
  process.env.BROWSER === 'Chrome';

// 检测是否使用连接模式（连接已手动启动的 Chrome，可规避自动化检测）
const useConnect =
  process.argv.includes('--connect') ||
  process.env.CONNECT_MODE === 'true' ||
  process.env.CONNECT_MODE === '1';

// CDP 连接地址（仅 --connect 模式使用）
const cdpEndpoint = process.env.CDP_ENDPOINT || 'http://localhost:9222';

// 使用与主流程一致的用户数据目录（保持登录状态）
const defaultUserDataDir = useChrome
  ? path.join(__dirname, '../.tiktok-user-data-chrome-test')
  : path.join(__dirname, '../.tiktok-user-data');

const userDataDir = process.env.TIKTOK_USER_DATA_DIR || defaultUserDataDir;

if (process.env.TIKTOK_USER_DATA_DIR) {
  console.log(`[test-tiktok-video] ✅ 使用环境变量指定的用户数据目录: ${userDataDir}`);
}

// 要测试的红人主页
const TEST_VIDEO_URL = 'https://www.tiktok.com/@kathryn.mueller';

// 清理浏览器锁文件（避免重复启动时冲突）
async function cleanupBrowserLock(dir) {
  try {
    const lockFile = path.join(dir, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      console.log(`[test-tiktok-video] 检测到锁文件，尝试清理: ${lockFile}`);
      fs.unlinkSync(lockFile);
      console.log('[test-tiktok-video] ✅ 锁文件已清理');
    }
  } catch (e) {
    console.warn('[test-tiktok-video] 清理锁文件失败:', e.message);
  }
}

/**
 * 创建交互式命令行界面
 */
function createInteractiveCLI(page, context, options = {}) {
  const { useConnect, browser } = options;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const printHelp = () => {
    console.log('\n可用命令:');
    console.log('  check          - 检查视频加载状态');
    console.log('  refresh        - 刷新当前页面');
    console.log('  newtab         - 在新标签页打开测试链接');
    console.log('  help           - 显示帮助信息');
    console.log('  exit / quit    - 退出并关闭浏览器');
    console.log('');
  };

  const handleCommand = async (input) => {
    const [cmd] = input.trim().split(/\s+/);

    try {
      switch (cmd.toLowerCase()) {
        case 'refresh':
          console.log('\n[CLI] 正在刷新页面...');
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(5000);
          console.log('[CLI] ✅ 页面已刷新');
          break;

        case 'check': {
          console.log('\n[CLI] 正在检查视频状态...');
          const status = await checkVideoLoaded(page);
          console.log(`  是否存在视频链接: ${status.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
          console.log(`  视频链接数量: ${status.videoLinkCount}`);
          console.log(`  视频容器数量: ${status.videoItemCount}`);
          console.log(`  缩略图数量: ${status.thumbnailCount}`);
          console.log(`  是否存在 <video> 元素: ${status.hasVideoElements ? '✅ 是' : '❌ 否（主页通常没有）'}`);
          if (status.hasVideoElements) {
            console.log(`  <video> 元素数量: ${status.videoElementCount}`);
            console.log(`  readyState 列表: [${status.readyStates.join(', ')}]`);
            console.log(`  正在播放的视频: ${status.playingCount}`);
          }
          if (status.hasError) {
            console.log(`  ⚠️  页面错误: ${status.errorHint}`);
          }
          break;
        }

        case 'newtab': {
          console.log('\n[CLI] 正在新标签页打开测试链接...');
          const newPage = await context.newPage();
          await newPage.goto(TEST_VIDEO_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          });
          await newPage.waitForTimeout(5000);
          console.log('[CLI] ✅ 新标签页已打开');
          break;
        }

        case 'help':
          printHelp();
          break;

        case 'exit':
        case 'quit':
          console.log('\n[CLI] 正在退出...');
          rl.close();
          if (useConnect && browser) {
            await browser.close();
          } else if (context) {
            await context.close();
          }
          process.exit(0);
          break;

        default:
          if (cmd) {
            console.log(`\n[CLI] ❌ 未知命令: ${cmd}`);
            console.log('[CLI] 输入 "help" 查看可用命令');
          }
      }
    } catch (error) {
      console.error(`\n[CLI] ❌ 执行命令时出错: ${error.message}`);
    }

    rl.prompt();
  };

  printHelp();
  rl.setPrompt('\n> ');
  rl.prompt();
  rl.on('line', handleCommand);
  rl.on('close', async () => {
    if (useConnect && browser) {
      await browser.close();
    } else if (context) {
      await context.close();
    }
    process.exit(0);
  });

  return rl;
}

/**
 * 检测 TikTok 主页视频是否已加载
 */
async function checkVideoLoaded(page) {
  return page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    const videoItems = Array.from(document.querySelectorAll(
      '[data-e2e*="video"], ' +
      '[class*="video-item"], ' +
      '[class*="VideoItem"], ' +
      '[class*="video-card"], ' +
      'div[class*="DivVideoContainer"], ' +
      'div[class*="VideoContainer"]'
    ));
    const thumbnails = Array.from(document.querySelectorAll(
      'img[alt*="video"], ' +
      'img[src*="video"], ' +
      'img[src*="tiktok"], ' +
      'div[class*="thumbnail"]'
    ));
    const videoElements = Array.from(document.querySelectorAll('video'));
    
    const pageText = document.body.innerText || '';
    const errorMessages = [
      'Something went wrong', 'Sorry about that!', 'Please try again later',
      '需要登录', 'Login to TikTok', 'Log in to see more',
      'This page isn\'t available', 'Page not found',
      'Access denied', 'Blocked', 'Rate limit'
    ];
    const hasError = errorMessages.some(msg => 
      pageText.toLowerCase().includes(msg.toLowerCase())
    );
    
    const mainContent = document.querySelector('main') || 
                       document.querySelector('[role="main"]') ||
                       document.querySelector('div[class*="Main"]');
    
    const pageTitle = document.title || '';
    const titleHasError = errorMessages.some(msg => 
      pageTitle.toLowerCase().includes(msg.toLowerCase())
    );
    
    const images = Array.from(document.querySelectorAll('img'));
    const loadedImages = images.filter(img => img.complete && img.naturalHeight > 0);
    
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
      videoItemCount: videoItems.length,
      thumbnailCount: thumbnails.length,
      hasVideoElements: videoElements.length > 0,
      videoElementCount: videoElements.length,
      readyStates: videoElements.map((v) => v.readyState),
      playingCount: videoElements.filter((v) => {
        try {
          return !v.paused && !v.ended && v.readyState >= 2 && v.currentTime > 0;
        } catch {
          return false;
        }
      }).length,
      hasError: hasError || titleHasError,
      errorHint: (hasError || titleHasError) ? '页面可能显示错误提示，需要检查是否需要登录或是否被风控' : null,
      hasMainContent: !!mainContent,
      imageCount: images.length,
      loadedImageCount: loadedImages.length,
      location: window.location.href,
      pageTitle: pageTitle,
    };
  });
}

async function main() {
  const browserName = useChrome ? 'Chrome' : 'Chromium';
  console.log('='.repeat(60));
  console.log(`测试：Playwright + ${browserName} 打开 TikTok 红人视频主页`);
  console.log('='.repeat(60));
  if (useConnect) {
    console.log('模式: 【连接模式】连接已手动启动的 Chrome（无自动化提示）');
    console.log(`CDP 地址: ${cdpEndpoint}`);
  } else {
    console.log(`浏览器类型: ${browserName} ${useChrome ? '(系统 Chrome)' : '(Playwright Chromium)'}`);
    console.log(`用户数据目录: ${userDataDir}`);
  }
  console.log(`测试视频链接: ${TEST_VIDEO_URL}`);
  console.log('');

  let context;
  let browser;

  try {
    if (useConnect) {
      // === 连接模式：连接已手动启动的 Chrome ===
      console.log('[test-tiktok-video] 正在连接已启动的 Chrome...');
      console.log('[test-tiktok-video] 请确保已运行: ./scripts/launch-chrome-remote-debug.sh');
      console.log('');

      browser = await chromium.connectOverCDP(cdpEndpoint, {
        timeout: 10000,
      });

      const contexts = browser.contexts();
      context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    } else {
      // === 启动模式：使用 Playwright 启动浏览器 ===
      await cleanupBrowserLock(userDataDir);
      console.log(`[test-tiktok-video] 正在启动 ${browserName}（持久化上下文，非 headless）...`);

      const launchOptions = {
        headless: false,
        viewport: { width: 1280, height: 720 },
        args: [
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      };

      if (useChrome) {
        launchOptions.channel = 'chrome';
        console.log('[test-tiktok-video] 使用系统安装的 Chrome 浏览器');
      }

      context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      
      // === 关键：只为 Chromium 添加最基础的 chrome 对象伪装 ===
      // Chrome 本身就有 window.chrome 对象，不需要伪装
      // 但 Chromium 没有，TikTok 可能依赖这个特征来区分浏览器
      if (!useChrome) {
        await context.addInitScript(() => {
          // 只添加最基础的 chrome 对象，不过度伪装
          if (typeof window.chrome === 'undefined') {
            window.chrome = {
              runtime: {},
            };
          }
        });
        console.log('[test-tiktok-video] ✅ 已为 Chromium 添加基础 chrome 对象伪装');
      }
    }

    console.log(`[test-tiktok-video] ✅ ${useConnect ? '已连接' : browserName + ' 已启动'}`);

    const page = await context.newPage();

    console.log('[test-tiktok-video] 正在访问测试视频链接...');

    // 访问页面（极简方式：只等待 domcontentloaded，然后等待 5 秒）
    await page.goto(TEST_VIDEO_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // 等待页面加载（参考 collect-automation-logs.js 的 5 秒等待）
    await page.waitForTimeout(5000);

    // 检查页面基本状态
    console.log('\n' + '='.repeat(60));
    console.log('[test-tiktok-video] 页面状态检查');
    console.log('='.repeat(60));

    const pageState = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        bodyExists: !!document.body,
        bodyHasContent: document.body ? document.body.innerHTML.length > 0 : false,
        bodyTextLength: document.body ? document.body.innerText.length : 0,
        bodyTextPreview: document.body ? document.body.innerText.substring(0, 200) : '',
      };
    });

    console.log(`\n📄 基本状态:`);
    console.log(`  URL: ${pageState.url}`);
    console.log(`  标题: ${pageState.title}`);
    console.log(`  readyState: ${pageState.readyState}`);
    console.log(`  body 存在: ${pageState.bodyExists ? '✅' : '❌'}`);
    console.log(`  body 有内容: ${pageState.bodyHasContent ? '✅' : '❌'}`);
    console.log(`  body 文本长度: ${pageState.bodyTextLength} 字符`);
    if (pageState.bodyTextPreview) {
      console.log(`  body 文本预览: ${pageState.bodyTextPreview}...`);
    }

    console.log('\n' + '='.repeat(60));

    // 检查视频加载状态
    console.log('[test-tiktok-video] 检查视频加载状态...');
    const status = await checkVideoLoaded(page);

    console.log('');
    console.log('='.repeat(60));
    console.log('初始检测结果');
    console.log('='.repeat(60));
    console.log(`是否存在视频链接: ${status.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
    console.log(`视频链接数量: ${status.videoLinkCount}`);
    console.log(`视频容器数量: ${status.videoItemCount}`);
    console.log(`缩略图数量: ${status.thumbnailCount}`);
    console.log(`是否有主要内容区域: ${status.hasMainContent ? '✅ 是' : '❌ 否'}`);
    console.log(`图片总数: ${status.imageCount}, 已加载: ${status.loadedImageCount}`);
    if (status.hasError) {
      console.log(`⚠️  页面错误: ${status.errorHint}`);
    }
    console.log(`页面标题: ${status.pageTitle}`);
    console.log(`当前 URL: ${status.location}`);
    console.log('');

    if (!status.hasVideoLinks && status.videoLinkCount === 0) {
      console.log('⚠️  未检测到视频链接，可能的原因：');
      console.log('  1. 需要登录 TikTok 账户');
      console.log('  2. 页面加载未完成（尝试等待更长时间）');
      console.log('  3. TikTok 检测到自动化并阻止了内容加载');
      console.log('  4. 网络问题或页面错误');
      console.log('');
      console.log('建议：');
      console.log('  - 在浏览器中手动检查页面是否正常显示');
      console.log('  - 检查是否需要登录');
      console.log('  - 尝试使用 refresh 命令刷新页面');
      console.log('');
    }
    console.log('='.repeat(60));
    console.log('交互式测试模式已启动');
    console.log('='.repeat(60));
    console.log('浏览器窗口会保持打开，你可以在终端输入命令来测试。');
    console.log('输入 "help" 查看可用命令。');
    console.log('');

    // 启动交互式命令行界面
    createInteractiveCLI(page, context, { useConnect, browser });
  } catch (error) {
    console.error('[test-tiktok-video] ❌ 发生错误:', error.message);
    if (useConnect) {
      console.error('\n提示: 连接模式需要先手动启动 Chrome：');
      console.error('  ./scripts/launch-chrome-remote-debug.sh');
    } else if (error.message.includes('channel') || error.message.includes('Chrome')) {
      console.error('\n提示: 如果使用 --chrome 参数，请确保系统已安装 Chrome 浏览器');
      console.error('或者尝试 --connect 模式: node scripts/test-tiktok-video-fingerprint.js --connect');
    }
    console.error(error.stack);
    if (context && !useConnect) {
      await context.close();
    }
    if (browser && useConnect) {
      await browser.close();
    }
    process.exit(1);
  }
}

main();

/**
 * 测试脚本：使用 Playwright + Chromium/Chrome 打开指定 TikTok 红人视频主页
 * 
 * 【简化版】参考 collect-automation-logs.js 的极简方式：
 * - 不注入任何反检测脚本（过度伪装可能被检测）
 * - 不模拟用户行为（鼠标移动、滚动等）
 * - 只保留最基本的浏览器启动参数
 * - 优先使用连接模式（连接手动启动的 Chrome）
 * 
 * 运行方式：
 *   node scripts/test-tiktok-video-fingerprint.js              # 使用 Chromium（默认）
 *   node scripts/test-tiktok-video-fingerprint.js --chrome     # 使用系统 Chrome
 *   node scripts/test-tiktok-video-fingerprint.js --connect    # 【推荐】连接已手动启动的 Chrome（无自动化提示）
 *
 * 可选环境变量：
 *   TIKTOK_USER_DATA_DIR=/path/to/tiktok-user-data
 *   BROWSER=chrome|chromium  (默认: chromium)
 *   CDP_ENDPOINT=http://localhost:9222  (--connect 模式下的 CDP 地址)
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import readline from 'readline';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 检测使用 Chrome 还是 Chromium
const useChrome =
  process.argv.includes('--chrome') ||
  process.env.BROWSER === 'chrome' ||
  process.env.BROWSER === 'Chrome';

// 检测是否使用连接模式（连接已手动启动的 Chrome，可规避自动化检测）
const useConnect =
  process.argv.includes('--connect') ||
  process.env.CONNECT_MODE === 'true' ||
  process.env.CONNECT_MODE === '1';

// CDP 连接地址（仅 --connect 模式使用）
const cdpEndpoint = process.env.CDP_ENDPOINT || 'http://localhost:9222';

// 使用与主流程一致的用户数据目录（保持登录状态）
const defaultUserDataDir = useChrome
  ? path.join(__dirname, '../.tiktok-user-data-chrome-test')
  : path.join(__dirname, '../.tiktok-user-data');

const userDataDir = process.env.TIKTOK_USER_DATA_DIR || defaultUserDataDir;

if (process.env.TIKTOK_USER_DATA_DIR) {
  console.log(`[test-tiktok-video] ✅ 使用环境变量指定的用户数据目录: ${userDataDir}`);
}

// 要测试的红人主页
const TEST_VIDEO_URL = 'https://www.tiktok.com/@kathryn.mueller';

// 清理浏览器锁文件（避免重复启动时冲突）
async function cleanupBrowserLock(dir) {
  try {
    const lockFile = path.join(dir, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      console.log(`[test-tiktok-video] 检测到锁文件，尝试清理: ${lockFile}`);
      fs.unlinkSync(lockFile);
      console.log('[test-tiktok-video] ✅ 锁文件已清理');
    }
  } catch (e) {
    console.warn('[test-tiktok-video] 清理锁文件失败:', e.message);
  }
}

/**
 * 创建交互式命令行界面
 */
function createInteractiveCLI(page, context, options = {}) {
  const { useConnect, browser } = options;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const printHelp = () => {
    console.log('\n可用命令:');
    console.log('  check          - 检查视频加载状态');
    console.log('  refresh        - 刷新当前页面');
    console.log('  newtab         - 在新标签页打开测试链接');
    console.log('  help           - 显示帮助信息');
    console.log('  exit / quit    - 退出并关闭浏览器');
    console.log('');
  };

  const handleCommand = async (input) => {
    const [cmd] = input.trim().split(/\s+/);

    try {
      switch (cmd.toLowerCase()) {
        case 'refresh':
          console.log('\n[CLI] 正在刷新页面...');
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(5000);
          console.log('[CLI] ✅ 页面已刷新');
          break;

        case 'check': {
          console.log('\n[CLI] 正在检查视频状态...');
          const status = await checkVideoLoaded(page);
          console.log(`  是否存在视频链接: ${status.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
          console.log(`  视频链接数量: ${status.videoLinkCount}`);
          console.log(`  视频容器数量: ${status.videoItemCount}`);
          console.log(`  缩略图数量: ${status.thumbnailCount}`);
          console.log(`  是否存在 <video> 元素: ${status.hasVideoElements ? '✅ 是' : '❌ 否（主页通常没有）'}`);
          if (status.hasVideoElements) {
            console.log(`  <video> 元素数量: ${status.videoElementCount}`);
            console.log(`  readyState 列表: [${status.readyStates.join(', ')}]`);
            console.log(`  正在播放的视频: ${status.playingCount}`);
          }
          if (status.hasError) {
            console.log(`  ⚠️  页面错误: ${status.errorHint}`);
          }
          break;
        }

        case 'newtab': {
          console.log('\n[CLI] 正在新标签页打开测试链接...');
          const newPage = await context.newPage();
          await newPage.goto(TEST_VIDEO_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          });
          await newPage.waitForTimeout(5000);
          console.log('[CLI] ✅ 新标签页已打开');
          break;
        }

        case 'help':
          printHelp();
          break;

        case 'exit':
        case 'quit':
          console.log('\n[CLI] 正在退出...');
          rl.close();
          if (useConnect && browser) {
            await browser.close();
          } else if (context) {
            await context.close();
          }
          process.exit(0);
          break;

        default:
          if (cmd) {
            console.log(`\n[CLI] ❌ 未知命令: ${cmd}`);
            console.log('[CLI] 输入 "help" 查看可用命令');
          }
      }
    } catch (error) {
      console.error(`\n[CLI] ❌ 执行命令时出错: ${error.message}`);
    }

    rl.prompt();
  };

  printHelp();
  rl.setPrompt('\n> ');
  rl.prompt();
  rl.on('line', handleCommand);
  rl.on('close', async () => {
    if (useConnect && browser) {
      await browser.close();
    } else if (context) {
      await context.close();
    }
    process.exit(0);
  });

  return rl;
}

/**
 * 检测 TikTok 主页视频是否已加载
 */
async function checkVideoLoaded(page) {
  return page.evaluate(() => {
    const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    const videoItems = Array.from(document.querySelectorAll(
      '[data-e2e*="video"], ' +
      '[class*="video-item"], ' +
      '[class*="VideoItem"], ' +
      '[class*="video-card"], ' +
      'div[class*="DivVideoContainer"], ' +
      'div[class*="VideoContainer"]'
    ));
    const thumbnails = Array.from(document.querySelectorAll(
      'img[alt*="video"], ' +
      'img[src*="video"], ' +
      'img[src*="tiktok"], ' +
      'div[class*="thumbnail"]'
    ));
    const videoElements = Array.from(document.querySelectorAll('video'));
    
    const pageText = document.body.innerText || '';
    const errorMessages = [
      'Something went wrong', 'Sorry about that!', 'Please try again later',
      '需要登录', 'Login to TikTok', 'Log in to see more',
      'This page isn\'t available', 'Page not found',
      'Access denied', 'Blocked', 'Rate limit'
    ];
    const hasError = errorMessages.some(msg => 
      pageText.toLowerCase().includes(msg.toLowerCase())
    );
    
    const mainContent = document.querySelector('main') || 
                       document.querySelector('[role="main"]') ||
                       document.querySelector('div[class*="Main"]');
    
    const pageTitle = document.title || '';
    const titleHasError = errorMessages.some(msg => 
      pageTitle.toLowerCase().includes(msg.toLowerCase())
    );
    
    const images = Array.from(document.querySelectorAll('img'));
    const loadedImages = images.filter(img => img.complete && img.naturalHeight > 0);
    
    return {
      hasVideoLinks: videoLinks.length > 0,
      videoLinkCount: videoLinks.length,
      videoItemCount: videoItems.length,
      thumbnailCount: thumbnails.length,
      hasVideoElements: videoElements.length > 0,
      videoElementCount: videoElements.length,
      readyStates: videoElements.map((v) => v.readyState),
      playingCount: videoElements.filter((v) => {
        try {
          return !v.paused && !v.ended && v.readyState >= 2 && v.currentTime > 0;
        } catch {
          return false;
        }
      }).length,
      hasError: hasError || titleHasError,
      errorHint: (hasError || titleHasError) ? '页面可能显示错误提示，需要检查是否需要登录或是否被风控' : null,
      hasMainContent: !!mainContent,
      imageCount: images.length,
      loadedImageCount: loadedImages.length,
      location: window.location.href,
      pageTitle: pageTitle,
    };
  });
}

async function main() {
  const browserName = useChrome ? 'Chrome' : 'Chromium';
  console.log('='.repeat(60));
  console.log(`测试：Playwright + ${browserName} 打开 TikTok 红人视频主页`);
  console.log('='.repeat(60));
  if (useConnect) {
    console.log('模式: 【连接模式】连接已手动启动的 Chrome（无自动化提示）');
    console.log(`CDP 地址: ${cdpEndpoint}`);
  } else {
    console.log(`浏览器类型: ${browserName} ${useChrome ? '(系统 Chrome)' : '(Playwright Chromium)'}`);
    console.log(`用户数据目录: ${userDataDir}`);
  }
  console.log(`测试视频链接: ${TEST_VIDEO_URL}`);
  console.log('');

  let context;
  let browser;

  try {
    if (useConnect) {
      // === 连接模式：连接已手动启动的 Chrome ===
      console.log('[test-tiktok-video] 正在连接已启动的 Chrome...');
      console.log('[test-tiktok-video] 请确保已运行: ./scripts/launch-chrome-remote-debug.sh');
      console.log('');

      browser = await chromium.connectOverCDP(cdpEndpoint, {
        timeout: 10000,
      });

      const contexts = browser.contexts();
      context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    } else {
      // === 启动模式：使用 Playwright 启动浏览器 ===
      await cleanupBrowserLock(userDataDir);
      console.log(`[test-tiktok-video] 正在启动 ${browserName}（持久化上下文，非 headless）...`);

      const launchOptions = {
        headless: false,
        viewport: { width: 1280, height: 720 },
        args: [
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      };

      if (useChrome) {
        launchOptions.channel = 'chrome';
        console.log('[test-tiktok-video] 使用系统安装的 Chrome 浏览器');
      }

      context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      
      // === 关键：只为 Chromium 添加最基础的 chrome 对象伪装 ===
      // Chrome 本身就有 window.chrome 对象，不需要伪装
      // 但 Chromium 没有，TikTok 可能依赖这个特征来区分浏览器
      if (!useChrome) {
        await context.addInitScript(() => {
          // 只添加最基础的 chrome 对象，不过度伪装
          if (typeof window.chrome === 'undefined') {
            window.chrome = {
              runtime: {},
            };
          }
        });
        console.log('[test-tiktok-video] ✅ 已为 Chromium 添加基础 chrome 对象伪装');
      }
    }

    console.log(`[test-tiktok-video] ✅ ${useConnect ? '已连接' : browserName + ' 已启动'}`);

    const page = await context.newPage();

    console.log('[test-tiktok-video] 正在访问测试视频链接...');

    // 访问页面（极简方式：只等待 domcontentloaded，然后等待 5 秒）
    await page.goto(TEST_VIDEO_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // 等待页面加载（参考 collect-automation-logs.js 的 5 秒等待）
    await page.waitForTimeout(5000);

    // 检查页面基本状态
    console.log('\n' + '='.repeat(60));
    console.log('[test-tiktok-video] 页面状态检查');
    console.log('='.repeat(60));

    const pageState = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        bodyExists: !!document.body,
        bodyHasContent: document.body ? document.body.innerHTML.length > 0 : false,
        bodyTextLength: document.body ? document.body.innerText.length : 0,
        bodyTextPreview: document.body ? document.body.innerText.substring(0, 200) : '',
      };
    });

    console.log(`\n📄 基本状态:`);
    console.log(`  URL: ${pageState.url}`);
    console.log(`  标题: ${pageState.title}`);
    console.log(`  readyState: ${pageState.readyState}`);
    console.log(`  body 存在: ${pageState.bodyExists ? '✅' : '❌'}`);
    console.log(`  body 有内容: ${pageState.bodyHasContent ? '✅' : '❌'}`);
    console.log(`  body 文本长度: ${pageState.bodyTextLength} 字符`);
    if (pageState.bodyTextPreview) {
      console.log(`  body 文本预览: ${pageState.bodyTextPreview}...`);
    }

    console.log('\n' + '='.repeat(60));

    // 检查视频加载状态
    console.log('[test-tiktok-video] 检查视频加载状态...');
    const status = await checkVideoLoaded(page);

    console.log('');
    console.log('='.repeat(60));
    console.log('初始检测结果');
    console.log('='.repeat(60));
    console.log(`是否存在视频链接: ${status.hasVideoLinks ? '✅ 是' : '❌ 否'}`);
    console.log(`视频链接数量: ${status.videoLinkCount}`);
    console.log(`视频容器数量: ${status.videoItemCount}`);
    console.log(`缩略图数量: ${status.thumbnailCount}`);
    console.log(`是否有主要内容区域: ${status.hasMainContent ? '✅ 是' : '❌ 否'}`);
    console.log(`图片总数: ${status.imageCount}, 已加载: ${status.loadedImageCount}`);
    if (status.hasError) {
      console.log(`⚠️  页面错误: ${status.errorHint}`);
    }
    console.log(`页面标题: ${status.pageTitle}`);
    console.log(`当前 URL: ${status.location}`);
    console.log('');

    if (!status.hasVideoLinks && status.videoLinkCount === 0) {
      console.log('⚠️  未检测到视频链接，可能的原因：');
      console.log('  1. 需要登录 TikTok 账户');
      console.log('  2. 页面加载未完成（尝试等待更长时间）');
      console.log('  3. TikTok 检测到自动化并阻止了内容加载');
      console.log('  4. 网络问题或页面错误');
      console.log('');
      console.log('建议：');
      console.log('  - 在浏览器中手动检查页面是否正常显示');
      console.log('  - 检查是否需要登录');
      console.log('  - 尝试使用 refresh 命令刷新页面');
      console.log('');
    }
    console.log('='.repeat(60));
    console.log('交互式测试模式已启动');
    console.log('='.repeat(60));
    console.log('浏览器窗口会保持打开，你可以在终端输入命令来测试。');
    console.log('输入 "help" 查看可用命令。');
    console.log('');

    // 启动交互式命令行界面
    createInteractiveCLI(page, context, { useConnect, browser });
  } catch (error) {
    console.error('[test-tiktok-video] ❌ 发生错误:', error.message);
    if (useConnect) {
      console.error('\n提示: 连接模式需要先手动启动 Chrome：');
      console.error('  ./scripts/launch-chrome-remote-debug.sh');
    } else if (error.message.includes('channel') || error.message.includes('Chrome')) {
      console.error('\n提示: 如果使用 --chrome 参数，请确保系统已安装 Chrome 浏览器');
      console.error('或者尝试 --connect 模式: node scripts/test-tiktok-video-fingerprint.js --connect');
    }
    console.error(error.stack);
    if (context && !useConnect) {
      await context.close();
    }
    if (browser && useConnect) {
      await browser.close();
    }
    process.exit(1);
  }
}

main();
