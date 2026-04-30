/**
 * 函数2: 搜索并提取红人数据
 * 基于关键词和社媒投放渠道，自动打开社媒关键词搜索网页，将含有红人和视频数据的html转化为markdown，用llm把markdown转化为json并写进mysql数据库
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { callDeepSeekLLM } from '../../utils/llm-client.js';
import { saveTikTokInfluencers, saveTikTokInfluencer } from '../../db/tiktok-influencer-dao.js';
import { 
  BROWSER_STEP_IDS, 
  STEP_STATUS, 
  createStep, 
  updateSteps 
} from '../../utils/browser-steps.js';

// 加载环境变量
// 优先级：.env.local > .env
// 先加载 .env，再加载 .env.local（.env.local 会覆盖 .env 中的同名变量）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../../');
dotenv.config({ path: path.join(projectRoot, '.env') }); // 先加载 .env
dotenv.config({ path: path.join(projectRoot, '.env.local') }); // 再加载 .env.local（优先级更高）

// 获取用户数据目录
// 搜索功能使用独立的用户数据目录，避免与手动启动的 Chrome（用于主页提取）冲突
function getUserDataDir() {
  // 如果设置了环境变量，使用环境变量指定的目录（用于搜索，需要登录状态）
  if (process.env.TIKTOK_USER_DATA_DIR) {
    const userDataDir = process.env.TIKTOK_USER_DATA_DIR;
    // 如果是相对路径，转换为绝对路径（相对于项目根目录）
    if (path.isAbsolute(userDataDir)) {
      return userDataDir;
    } else {
      // 相对路径：相对于项目根目录（__dirname 是 lib/tools/influencer-functions，需要回到项目根目录）
      const projectRoot = path.join(__dirname, '../../../');
      return path.resolve(projectRoot, userDataDir);
    }
  }
  // 否则使用默认的搜索专用目录
  return path.join(__dirname, '../../../.tiktok-user-data-search');
}

// 清理浏览器锁文件（如果存在）
async function cleanupBrowserLock(userDataDir) {
  try {
    const lockFile = path.join(userDataDir, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      console.log(`[cleanupBrowserLock] 检测到锁文件，尝试清理: ${lockFile}`);
      
      // 尝试多次删除锁文件（可能正在被其他进程占用）
      let retries = 3;
      while (retries > 0) {
        try {
          fs.unlinkSync(lockFile);
          console.log(`[cleanupBrowserLock] ✅ 锁文件已清理`);
          break;
        } catch (e) {
          retries--;
          if (retries > 0) {
            console.log(`[cleanupBrowserLock] 清理失败，等待 500ms 后重试... (剩余 ${retries} 次)`);
            await new Promise(resolve => setTimeout(resolve, 500));
          } else {
            console.warn(`[cleanupBrowserLock] ⚠️  无法删除锁文件，可能被其他 Chrome 进程占用`);
            console.warn(`[cleanupBrowserLock] 💡 提示: 请手动关闭所有使用该用户数据目录的 Chrome 进程`);
            throw e;
          }
        }
      }
    }
    
    // 额外检查：尝试删除其他可能的锁文件
    const lockSocket = path.join(userDataDir, 'SingletonSocket');
    if (fs.existsSync(lockSocket)) {
      try {
        fs.unlinkSync(lockSocket);
        console.log(`[cleanupBrowserLock] ✅ SingletonSocket 已清理`);
      } catch (e) {
        console.warn(`[cleanupBrowserLock] 清理 SingletonSocket 失败:`, e.message);
      }
    }
  } catch (e) {
    console.warn(`[cleanupBrowserLock] 清理锁文件失败:`, e.message);
    throw e; // 重新抛出错误，让调用者知道清理失败
  }
}

// ========== 辅助函数（从 tiktok-login.js 复制） ==========

/**
 * 清理和优化 HTML，减少大小
 */
function optimizeHTML(html) {
  let optimized = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  optimized = optimized.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  optimized = optimized.replace(/<!--[\s\S]*?-->/g, '');
  optimized = optimized.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  optimized = optimized.replace(/<meta[^>]*>/gi, '');
  optimized = optimized.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
  optimized = optimized.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
  optimized = optimized.replace(/\s+(on\w+)=["'][^"']*["']/gi, '');
  optimized = optimized.replace(/\s+(style|onclick|onerror|onload|aria-\w+|role|tabindex|data-\w+(?!-e2e|-testid))=["'][^"']*["']/gi, '');
  optimized = optimized.replace(/<(div|span|p|section|article|header|footer|nav|aside)[^>]*>\s*<\/(div|span|p|section|article|header|footer|nav|aside)>/gi, '');
  optimized = optimized.replace(/\s+/g, ' ');
  optimized = optimized.replace(/>\s+</g, '><');
  optimized = optimized.replace(/\n\s*\n/g, '\n');
  return optimized.trim();
}

/**
 * 判断是否为有效的红人显示名
 */
const GENERIC_DISPLAY_NAMES = new Set([
  'profile', 'view profile', 'view', 'see more', 'more', 'link',
  'profile picture', 'avatar', 'user', 'creator', 'author',
  'x-signature', 'css-', 'styled', 'tiktok', 'video', 'signature'
]);

const INVALID_DISPLAY_NAME_PATTERNS = [
  /^css-/, /^t-[A-Za-z0-9]+$/, /^[a-z]+-[a-z0-9]+-[a-z0-9]+$/, /^x-signature$/i,
  /^[a-f0-9]{32,}$/i, /^[A-Za-z0-9_-]{20,}$/, /^[A-Z][a-z]+[A-Z]/, /--/,
  /^[a-z]+-[a-z]+-[a-z]+-[a-z]+/,
];

function isValidDisplayName(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 2 || t.length > 80) return false;
  const lower = t.toLowerCase();
  if (GENERIC_DISPLAY_NAMES.has(lower)) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^[@#]?\w+$/.test(t) && t === t.replace('@', '')) return false;
  for (const pattern of INVALID_DISPLAY_NAME_PATTERNS) {
    if (pattern.test(t)) return false;
  }
  if (t.includes('http') || t.includes('://') || t.includes('www.')) return false;
  if (/^[a-z0-9_-]+$/i.test(t) && t.length > 15 && !/[aeiouAEIOU]/.test(t)) return false;
  return true;
}

/**
 * 从 HTML 上下文中提取红人显示名
 */
function extractDisplayNameFromContext(html, username, searchRadius = 800) {
  const usernamePattern = new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
  const match = html.match(usernamePattern);
  if (!match) return null;
  const idx = html.indexOf(match[0]);
  const start = Math.max(0, idx - searchRadius);
  const end = Math.min(html.length, idx + match[0].length + searchRadius);
  const context = html.substring(start, end);
  let textOnly = context.replace(/<[^>]+>/g, ' ');
  textOnly = textOnly.replace(/class=["'][^"']*["']/gi, ' ');
  textOnly = textOnly.replace(/id=["'][^"']*["']/gi, ' ');
  textOnly = textOnly.replace(/data-[^=]*=["'][^"']*["']/gi, ' ');
  textOnly = textOnly.replace(/\s+/g, ' ').trim();
  textOnly = textOnly.replace(/\d+[hdwm]\s*(?:ago|前)/gi, ' ');
  textOnly = textOnly.replace(/\d+-\d+/g, ' ');
  textOnly = textOnly.replace(/\s+/g, ' ').trim();
  const usernameIndex = textOnly.toLowerCase().indexOf(`@${username.toLowerCase()}`);
  if (usernameIndex === -1) return null;
  const afterUsername = textOnly.substring(usernameIndex + username.length + 1);
  const candidates = afterUsername.match(/\b([A-Za-z][A-Za-z0-9\s\-_.']{2,50})\b/g);
  if (candidates) {
    for (const c of candidates) {
      const cleaned = c.trim();
      if (cleaned.toLowerCase().includes(username.toLowerCase())) continue;
      if (/\d+[hdwm]\s*(?:ago|前)/i.test(cleaned)) continue;
      if (/\d+-\d+/.test(cleaned)) continue;
      if (/upload|profile|view|see|more|link|click/i.test(cleaned)) continue;
      if (/^[a-z]+-[a-z]+-[a-z]+/.test(cleaned.toLowerCase())) continue;
      if (/^[a-z]+[A-Z]/.test(cleaned) && cleaned.length < 10) continue;
      if (isValidDisplayName(cleaned) && cleaned.length >= 2 && cleaned.length <= 50 &&
          !cleaned.match(/^\d+/) && !cleaned.includes('@') && !cleaned.includes('#') &&
          !cleaned.includes('http') && !cleaned.includes('://')) {
        return cleaned;
      }
    }
  }
  return null;
}

/**
 * 缩短封面 URL
 */
function shortenCoverUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const qIdx = url.indexOf('?');
  return qIdx > 0 ? url.substring(0, qIdx) : url;
}

/**
 * 将 HTML 转换为超精简 Markdown
 */
function htmlToCompactMarkdown(html) {
  if (!html || typeof html !== 'string') return '';
  const extractedData = { videos: [], users: [], images: [] };
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
      
      // 提取可能的统计数字（如点赞数）
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

  const userMap = new Map();
  const userLinkRegex = /<a[^>]*href=["']([^"']*\/@([^\/\?"']+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = userLinkRegex.exec(html)) !== null) {
    const fullUrl = match[1];
    const username = match[2];
    let linkText = match[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    linkText = linkText.replace(/\d+[hdwm]\s*(?:ago|前)/gi, '').trim();
    linkText = linkText.replace(new RegExp(`@?${username}`, 'gi'), '').trim();
    linkText = linkText.replace(/^\d+-\d+\s*/, '').trim();
    if (!fullUrl.includes('/video/') && username) {
      const profileUrl = fullUrl.startsWith('http') ? fullUrl : `https://www.tiktok.com${fullUrl}`;
      let displayName = linkText && isValidDisplayName(linkText) ? linkText : null;
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
        userMap.get(username).displayName = displayName;
      }
    }
  }
  
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

  extractedData.videos.forEach((video) => {
    // 使用视频ID和URL两种方式定位视频上下文
    const videoIdPattern = new RegExp(video.videoId, 'i');
    const videoUrlPattern = new RegExp(video.videoUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    
    // 先尝试用视频ID定位（更精确）
    let videoMatch = html.match(videoIdPattern);
    let matchIndex = videoMatch ? html.indexOf(videoMatch[0]) : -1;
    
    // 如果视频ID找不到，尝试用URL
    if (matchIndex === -1) {
      videoMatch = html.match(videoUrlPattern);
      matchIndex = videoMatch ? html.indexOf(videoMatch[0]) : -1;
    }
    
    if (matchIndex !== -1) {
      // 扩大搜索上下文范围（前后各3000字符）
      const start = Math.max(0, matchIndex - 1000);
      const end = Math.min(html.length, matchIndex + videoMatch[0].length + 3000);
      const context = html.substring(start, end);
      
      // 1. 提取点赞数
      const likesMatch = context.match(/video-count[^>]*>(\d+)<\/strong>|StrongVideoCount[^>]*>(\d+)<\/strong>/i);
      if (likesMatch) {
        const likesNum = parseInt(likesMatch[1] || likesMatch[2], 10);
        if (!isNaN(likesNum) && likesNum >= 0) {
          video.likes = { count: likesNum, display: String(likesNum) };
        }
      }
      
      // 2. 提取视频描述/文案（多种策略）
      let description = null;
      
      // 策略1: 从img alt属性提取（原有方法）
      const imgAltMatches = context.matchAll(/<img[^>]*alt=["']([^"']{10,})["'][^>]*>/gi);
      for (const imgMatch of imgAltMatches) {
        const imgSrc = imgMatch[0].match(/src=["']([^"']+)["']/);
        const alt = imgMatch[1];
        if (!alt || alt.length < 10) continue;
        const isAvatar = imgSrc && (imgSrc[1].includes('avt-') || imgSrc[1].includes('avatar'));
        if (isAvatar) continue;
        description = alt;
        break;
      }
      
      // 策略2: 从data-e2e="search-card-desc"或类似属性提取
      if (!description) {
        const descPatterns = [
          /data-e2e=["']search-card-desc["'][^>]*>([^<]{10,})</i,
          /data-e2e=["']search-card["'][^>]*>[\s\S]{0,500}?([^<]{10,200})</i,
          /class=["'][^"']*desc[^"']*["'][^>]*>([^<]{10,})</i,
          /class=["'][^"']*caption[^"']*["'][^>]*>([^<]{10,})</i,
          /class=["'][^"']*text[^"']*["'][^>]*>([^<]{10,})</i
        ];
        
        for (const pattern of descPatterns) {
          const match = context.match(pattern);
          if (match && match[1]) {
            const text = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (text.length >= 10 && text.length <= 500) {
              description = text;
              break;
            }
          }
        }
      }
      
      // 策略3: 从包含视频ID的文本块中提取（去除HTML标签后的文本）
      if (!description) {
        // 查找包含视频ID的文本节点
        const textContext = context.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                   .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                   .replace(/<[^>]+>/g, ' ')
                                   .replace(/\s+/g, ' ')
                                   .trim();
        
        // 查找包含hashtag或@mention的文本段（可能是视频描述）
        const textWithTags = textContext.match(/(.{0,200}(?:#[\w\u4e00-\u9fa5]+|@[\w\u4e00-\u9fa5.]+).{0,200})/);
        if (textWithTags && textWithTags[1].length >= 10) {
          description = textWithTags[1].trim();
        } else if (textContext.length >= 20 && textContext.length <= 500) {
          // 如果没有标签，但文本长度合适，也可能是描述
          description = textContext.substring(0, 500).trim();
        }
      }
      
      // 策略4: 从span、div、p等文本元素中提取
      if (!description) {
        const textElementPatterns = [
          /<(span|div|p)[^>]*>([^<]{10,200})<\/\1>/gi,
          /<span[^>]*class=["'][^"']*[Tt]ext[^"']*["'][^>]*>([^<]{10,200})<\/span>/gi
        ];
        
        for (const pattern of textElementPatterns) {
          const matches = context.matchAll(pattern);
          for (const match of matches) {
            const text = (match[2] || match[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (text.length >= 10 && text.length <= 500 && 
                !text.match(/^\d+[KMkm]?$/) && // 排除纯数字（可能是统计数字）
                !text.match(/^\d+[hdwm]\s*(?:ago|前)?$/i)) { // 排除时间
              description = text;
              break;
            }
          }
          if (description) break;
        }
      }
      
      // 保存描述
      if (description) {
        video.description = description;
      }
      
      // 3. 解析描述：提取 caption、hashtags、@mentions、音乐
      if (video.description) {
        const desc = video.description;
        
        // 提取 hashtags（支持中英文）
        const hashtags = desc.match(/#[\w\u4e00-\u9fa5]+/g);
        if (hashtags) {
          video.hashtags = [...new Set(hashtags.map(tag => tag.toLowerCase()))];
        }
        
        // 提取 @mentions（支持中英文和点号）
        const mentions = desc.match(/@[\w\u4e00-\u9fa5.]+/g);
        if (mentions) {
          video.mentions = [...new Set(mentions)];
        }
        
        // 提取音乐信息
        const createdBy = desc.match(/created by (.+?) with/i);
        if (createdBy) video.creator = createdBy[1].trim();
        const musicMatch = desc.match(/with ([^']+(?:'s original sound)?)/i);
        if (musicMatch) video.music = musicMatch[1].trim();
        
        // 提取纯文案（去除hashtags、mentions、音乐信息后的文本）
        let captionText = desc;
        
        // 移除hashtags
        if (video.hashtags) {
          video.hashtags.forEach(tag => {
            captionText = captionText.replace(new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
          });
        }
        
        // 移除mentions
        if (video.mentions) {
          video.mentions.forEach(mention => {
            captionText = captionText.replace(new RegExp(mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
          });
        }
        
        // 移除音乐信息
        if (video.music) {
          captionText = captionText.replace(/created by .+? with/i, '');
          captionText = captionText.replace(/with .+?(?:'s original sound)?/i, '');
        }
        
        // 清理多余空格和换行
        captionText = captionText.replace(/\s+/g, ' ').trim();
        
        // 如果清理后的文案还有内容，保存它
        if (captionText.length > 0) {
          video.caption = captionText;
        } else {
          // 如果清理后没有内容，说明描述主要是标签和提及，使用原始描述
          video.caption = desc;
        }
      }
      
      // 4. 发布时间：来自 DivTimeTag
      const timeMatch = context.match(/DivTimeTag[^>]*>([^<]+)</i) || 
                        context.match(/eh1ph4315[^>]*>([^<]+)</i);
      if (timeMatch) {
        const t = timeMatch[1].trim();
        if (t && (/^\d+[hdwm]?\s*(?:ago|前)?$/i.test(t) || /^\d+-\d+$/.test(t) || /just now|刚刚|刚才/i.test(t))) {
          video.postedTime = t;
        }
      }
      
      // 5. 提取封面图
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
    }
  });

  extractedData.users.forEach((user) => {
    if (!user.displayName || !isValidDisplayName(user.displayName)) {
      const ctxDisplayName = extractDisplayNameFromContext(html, user.username, 1000);
      if (ctxDisplayName && isValidDisplayName(ctxDisplayName)) {
        user.displayName = ctxDisplayName;
      } else {
        user.displayName = null;
      }
    }
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

  // 创建用户映射表，方便快速查找（用于 Markdown 输出时的关联）
  const userMapForMarkdown = new Map();
  extractedData.users.forEach(user => {
    if (user.username) {
      userMapForMarkdown.set(user.username.toLowerCase(), user);
    }
  });

  let md = '';
  
  // 统计信息
  const uniqueAuthors = new Set();
  extractedData.videos.forEach(video => {
    if (video.username) {
      uniqueAuthors.add(video.username.toLowerCase());
    }
  });
  
  if (extractedData.videos.length > 0) {
    md += `# 视频及作者信息 (${extractedData.videos.length}个视频，${uniqueAuthors.size}个作者)\n`;
    md += `注：搜索页仅展示点赞数，无播放量/评论/收藏\n\n`;
    
    extractedData.videos.forEach((video, idx) => {
      md += `## ${idx + 1}. 视频 ${video.videoId}\n`;
      md += `- URL: ${video.videoUrl}\n`;
      
      // 视频基本信息
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
      
      // 作者信息（关联显示）
      if (video.username) {
        md += `\n- **作者: @${video.username}`;
        const author = userMapForMarkdown.get(video.username.toLowerCase());
        if (author) {
          if (author.verified) md += ` ✓`;
          md += `**\n`;
          md += `  - 主页: ${author.profileUrl || `https://www.tiktok.com/@${video.username}`}\n`;
          if (author.displayName && isValidDisplayName(author.displayName) && author.displayName !== author.username) {
            md += `  - 显示名: ${author.displayName}\n`;
          }
          if (author.bio) {
            md += `  - 简介: ${author.bio.substring(0, 150)}${author.bio.length > 150 ? '...' : ''}\n`;
          }
          if (author.followers) {
            md += `  - 粉丝: ${author.followers.display} (${author.followers.count.toLocaleString()})\n`;
          }
          if (author.following) {
            md += `  - 关注: ${author.following.display} (${author.following.count.toLocaleString()})\n`;
          }
          if (author.totalLikes) {
            md += `  - 获赞: ${author.totalLikes.display} (${author.totalLikes.count.toLocaleString()})\n`;
          }
          if (author.avatarUrl) {
            md += `  - 头像: ${shortenCoverUrl(author.avatarUrl)}\n`;
          }
        } else {
          md += `**\n`;
          md += `  - 主页: https://www.tiktok.com/@${video.username}\n`;
        }
      }
      
      md += '\n';
    });
  }

  // 补充：列出所有去重后的用户（仅包含在搜索结果中出现但可能没有视频的用户）
  const usersWithVideos = new Set();
  extractedData.videos.forEach(video => {
    if (video.username) {
      usersWithVideos.add(video.username.toLowerCase());
    }
  });
  
  const usersWithoutVideos = extractedData.users.filter(user => 
    user.username && !usersWithVideos.has(user.username.toLowerCase())
  );
  
  if (usersWithoutVideos.length > 0) {
    md += `---\n\n`;
    md += `# 其他提及的用户 (${usersWithoutVideos.length}个，未出现在视频列表中)\n\n`;
    usersWithoutVideos.forEach((user, idx) => {
      md += `## ${idx + 1}. @${user.username}`;
      if (user.verified) md += ` ✓`;
      md += `\n`;
      md += `- 主页: ${user.profileUrl}\n`;
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

  const markdown = md.trim() || '未提取到视频信息';
  
  // 返回 Markdown 和 extractedData
  return {
    markdown: markdown,
    extractedData: extractedData
  };
}

/**
 * 将 extractedData 转换为数据库记录格式
 * 注意：不计算聚合数据（平均点赞数、视频数量等），这些由后续函数计算
 * @param {Object} extractedData - 从 HTML 提取的原始数据 { videos: Array, users: Array }
 * @param {Object} campaignInfo - Campaign 信息（可选）
 * @returns {Array} - 数据库格式的红人记录数组
 */
function convertExtractedDataToInfluencers(extractedData, campaignInfo = {}) {
  const { videos = [], users = [] } = extractedData;
  
  console.log(`[convertExtractedDataToInfluencers] 开始转换: ${videos.length} 个视频, ${users.length} 个用户`);
  
  // 1. 收集所有用户（从 users 数组和 videos 数组中提取）
  const allUsers = new Map();
  
  // 从 users 数组中添加用户
  users.forEach(user => {
    if (user.username) {
      allUsers.set(user.username, user);
    }
  });
  
  // 从 videos 中提取的用户（如果 users 数组中没有）
  videos.forEach(video => {
    if (video.username && !allUsers.has(video.username)) {
      allUsers.set(video.username, {
        username: video.username,
        profileUrl: `https://www.tiktok.com/@${video.username}`,
        displayName: null,
        avatarUrl: null,
        followers: null,
        verified: false,
        bio: null
      });
    }
  });
  
  console.log(`[convertExtractedDataToInfluencers] 去重后的用户数: ${allUsers.size}`);
  
  // 2. 转换每个用户为数据库记录格式
  const influencerRecords = [];
  
  allUsers.forEach((user, username) => {
    // 注意：搜索页面无法获取粉丝数、头像、简介等，这些字段设为 null
    // 聚合数据（平均点赞数、视频数量等）也设为 null，由后续函数计算
    const record = {
      username: username,
      displayName: user.displayName || username,
      profileUrl: user.profileUrl || `https://www.tiktok.com/@${username}`,
      avatarUrl: user.avatarUrl || null,  // 搜索页面通常没有，需要后续补充
      followers: user.followers || null,  // 搜索页面没有，需要后续补充
      bio: user.bio || null,  // 搜索页面没有，需要后续补充
      verified: user.verified || false,
      platform: 'TikTok',
      // 数据库格式需要的字段（聚合数据由后续函数计算）
      views: {
        avg: null,  // 由后续函数计算
        display: null
      },
      engagement: {
        rate: null,  // 由后续函数计算
        avgLikes: null,  // 由后续函数计算
        avgComments: null  // 由后续函数计算
      },
      following: null,  // 搜索页面没有，需要后续补充
      postsCount: null,  // 由后续函数计算
      country: campaignInfo.countries?.[0] || null
    };
    
    influencerRecords.push(record);
  });
  
  console.log(`[convertExtractedDataToInfluencers] ✅ 转换完成: ${influencerRecords.length} 个红人记录`);
  
  return influencerRecords;
}

/**
 * 随机延迟函数
 */
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 模拟用户打开浏览器后的自然行为
 * 用户手动打开浏览器后，不会立即访问页面，而是会观察、移动鼠标等
 * @param {Page} page - Playwright 页面对象
 * @returns {Promise<void>}
 */
async function simulateNaturalBrowserOpen(page) {
  try {
    // 1. 等待浏览器界面稳定（模拟用户观察时间）
    await page.waitForTimeout(1000 + Math.floor(Math.random() * 2000)); // 1-3秒
    
    // 2. 获取视口大小
    const viewport = page.viewportSize();
    if (!viewport) {
      return; // 如果没有视口，跳过
    }
    
    // 3. 模拟鼠标移动到随机位置（模拟用户观察浏览器界面）
    const randomX = Math.random() * viewport.width;
    const randomY = Math.random() * viewport.height;
    const steps = 10 + Math.floor(Math.random() * 10); // 10-20步，模拟自然移动
    await page.mouse.move(randomX, randomY, { steps });
    
    // 4. 等待观察时间
    await page.waitForTimeout(500 + Math.floor(Math.random() * 1000)); // 0.5-1.5秒
    
    // 5. 可能轻微移动鼠标（30% 概率）
    if (Math.random() > 0.7) {
      const smallMoveX = randomX + (Math.random() - 0.5) * 100;
      const smallMoveY = randomY + (Math.random() - 0.5) * 100;
      await page.mouse.move(smallMoveX, smallMoveY, { steps: 5 + Math.floor(Math.random() * 5) });
      await page.waitForTimeout(300 + Math.floor(Math.random() * 500));
    }
    
    console.log(`[simulateNaturalBrowserOpen] ✅ 完成模拟用户打开浏览器后的自然行为`);
  } catch (e) {
    console.warn(`[simulateNaturalBrowserOpen] 模拟行为失败: ${e.message}`);
    // 即使失败也继续，不影响主流程
  }
}

/**
 * 人类化点击：添加鼠标移动、悬停、随机位置
 * @param {Page} page - Playwright 页面对象
 * @param {ElementHandle} element - 要点击的元素
 * @param {Object} options - 选项
 * @returns {Promise<void>}
 */
async function humanLikeClick(page, element, options = {}) {
  const {
    hoverTime = { min: 200, max: 800 },  // 悬停时间（毫秒）
    clickOffset = 0.3,  // 点击位置随机偏移（元素大小的百分比）
    postClickDelay = { min: 300, max: 1000 }  // 点击后延迟
  } = options;
  
  try {
    // 1. 获取元素位置和大小
    const box = await element.boundingBox();
    if (!box) {
      throw new Error('无法获取元素位置');
    }
    
    // 2. 计算目标点击位置（在元素内随机位置，不在正中心）
    const offsetX = (Math.random() - 0.5) * box.width * clickOffset;
    const offsetY = (Math.random() - 0.5) * box.height * clickOffset;
    const targetX = box.x + box.width / 2 + offsetX;
    const targetY = box.y + box.height / 2 + offsetY;
    
    // 3. 获取当前鼠标位置（或使用页面中心）
    const currentPos = await page.evaluate(() => {
      return { x: window.mouseX || window.innerWidth / 2, y: window.mouseY || window.innerHeight / 2 };
    }).catch(() => ({ x: 960, y: 540 }));
    
    // 4. 使用贝塞尔曲线移动鼠标到目标位置
    const steps = 15 + Math.floor(Math.random() * 10); // 15-25步
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // 贝塞尔曲线控制点（添加随机性）
      const cp1x = currentPos.x + (targetX - currentPos.x) * 0.3 + (Math.random() - 0.5) * 50;
      const cp1y = currentPos.y + (targetY - currentPos.y) * 0.3 + (Math.random() - 0.5) * 50;
      const cp2x = currentPos.x + (targetX - currentPos.x) * 0.7 + (Math.random() - 0.5) * 50;
      const cp2y = currentPos.y + (targetY - currentPos.y) * 0.7 + (Math.random() - 0.5) * 50;
      
      // 贝塞尔曲线公式
      const x = Math.pow(1 - t, 3) * currentPos.x + 
                3 * Math.pow(1 - t, 2) * t * cp1x + 
                3 * (1 - t) * Math.pow(t, 2) * cp2x + 
                Math.pow(t, 3) * targetX;
      const y = Math.pow(1 - t, 3) * currentPos.y + 
                3 * Math.pow(1 - t, 2) * t * cp1y + 
                3 * (1 - t) * Math.pow(t, 2) * cp2y + 
                Math.pow(t, 3) * targetY;
      
      // 移动速度变化（开始慢，中间快，结束慢）
      const speed = 0.3 + Math.sin(t * Math.PI) * 0.7; // 0.3-1.0
      await page.mouse.move(x, y);
      await page.waitForTimeout(10 + Math.floor(speed * 15)); // 10-25ms 每步
    }
    
    // 5. 悬停在目标位置（模拟人类观察）
    const hoverDuration = randomDelay(hoverTime.min, hoverTime.max);
    await page.waitForTimeout(hoverDuration);
    
    // 6. 轻微移动鼠标（模拟人类微调）
    const microMoveX = targetX + (Math.random() - 0.5) * 5;
    const microMoveY = targetY + (Math.random() - 0.5) * 5;
    await page.mouse.move(microMoveX, microMoveY);
    await page.waitForTimeout(50 + Math.floor(Math.random() * 50)); // 50-100ms
    
    // 7. 点击
    await page.mouse.click(targetX, targetY);
    
    // 8. 点击后轻微移动鼠标（模拟人类点击后的自然移动）
    const postClickX = targetX + (Math.random() - 0.5) * 10;
    const postClickY = targetY + (Math.random() - 0.5) * 10;
    await page.mouse.move(postClickX, postClickY);
    
    // 9. 点击后延迟（模拟人类反应时间）
    await page.waitForTimeout(randomDelay(postClickDelay.min, postClickDelay.max));
    
  } catch (error) {
    // 如果人类化点击失败，回退到普通点击
    console.warn(`[humanLikeClick] 人类化点击失败，使用普通点击: ${error.message}`);
    await element.click({ timeout: 10000 });
  }
}

/**
 * 随机滚动距离（页面高度的百分比）
 */
function randomScrollDistance() {
  // 随机滚动距离：30%-100% 的页面高度
  return Math.random() * 0.7 + 0.3; // 0.3-1.0
}

/**
 * 模拟人类滚动行为（在页面上下文中执行）
 */
async function humanLikeScroll(page, options = {}) {
  const {
    minScrollCount = 8,
    maxScrollCount = 20,
    minWaitTime = 500,
    maxWaitTime = 3000,
    pauseProbability = 0.3,
    scrollUpProbability = 0.1,
    mouseMoveProbability = 0.2,
    videoHoverProbability = 0.15
  } = options;
  
  // 确定浏览模式
  const isQuickBrowse = Math.random() < 0.3;
  const isDeepBrowse = Math.random() < 0.2;
  
  let scrollCount, waitTime;
  
  if (isQuickBrowse) {
    // 快速浏览：5-10 次，1-2 秒
    scrollCount = Math.floor(Math.random() * 5) + 5;
    waitTime = () => randomDelay(1000, 2000);
  } else if (isDeepBrowse) {
    // 深度浏览：15-25 次，3-8 秒
    scrollCount = Math.floor(Math.random() * 10) + 15;
    waitTime = () => randomDelay(3000, 8000);
  } else {
    // 正常浏览：8-20 次，0.5-3 秒
    scrollCount = Math.floor(Math.random() * (maxScrollCount - minScrollCount + 1)) + minScrollCount;
    waitTime = () => randomDelay(minWaitTime, maxWaitTime);
  }
  
  // 执行滚动
  for (let i = 0; i < scrollCount; i++) {
    // 随机滚动距离
    const scrollPercentage = randomScrollDistance();
    
    // 更真实的滚动：使用鼠标滚轮（有加速度）
    const useMouseWheel = Math.random() > 0.2; // 80% 使用滚轮，20% 使用 scrollBy
    
    if (useMouseWheel) {
      // 获取鼠标位置（在页面中央区域）
      const mouseX = 300 + Math.random() * 600;
      const mouseY = 300 + Math.random() * 400;
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(50 + Math.floor(Math.random() * 100)); // 50-150ms
      
      // 计算滚动距离
      const baseDistance = Math.floor(window.innerHeight * scrollPercentage);
      
      // 模拟滚轮的加速度和减速度（多次小滚动）
      const scrollSteps = 3 + Math.floor(Math.random() * 5); // 3-7步
      for (let step = 0; step < scrollSteps; step++) {
        // 每步的距离（开始和结束小，中间大）
        const stepProgress = step / (scrollSteps - 1);
        const stepSize = baseDistance / scrollSteps * (0.5 + Math.sin(stepProgress * Math.PI) * 0.5);
        
        await page.mouse.wheel(0, stepSize);
        // 滚动间隔（开始和结束慢，中间快）
        const interval = 30 + Math.floor((1 - Math.abs(stepProgress - 0.5) * 2) * 50); // 30-80ms
        await page.waitForTimeout(interval);
      }
    } else {
      // 偶尔使用 scrollBy（保持多样性）
      const speed = Math.random() > 0.3 ? 'smooth' : 'auto';
      await page.evaluate(({ percentage, speed }) => {
        const distance = Math.floor(window.innerHeight * percentage);
        window.scrollBy({ top: distance, behavior: speed });
      }, { percentage: scrollPercentage, speed: speed });
    }
    
    // 随机停顿（模拟查看内容）
    if (Math.random() < pauseProbability) {
      await page.waitForTimeout(randomDelay(1000, 3000));
    }
    
    // 随机鼠标移动（更真实：使用曲线轨迹）
    if (Math.random() < mouseMoveProbability) {
      try {
        // 获取当前鼠标位置
        const currentPos = await page.evaluate(() => {
          return { x: window.mouseX || 960, y: window.mouseY || 540 };
        }).catch(() => ({ x: 960, y: 540 }));
        
        // 目标位置
        const targetX = Math.random() * 1920;
        const targetY = Math.random() * 1080;
        
        // 使用贝塞尔曲线模拟真实鼠标移动（分多步移动）
        const steps = 10 + Math.floor(Math.random() * 10); // 10-20步
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          // 贝塞尔曲线控制点（添加随机性）
          const cp1x = currentPos.x + (targetX - currentPos.x) * 0.3 + (Math.random() - 0.5) * 100;
          const cp1y = currentPos.y + (targetY - currentPos.y) * 0.3 + (Math.random() - 0.5) * 100;
          const cp2x = currentPos.x + (targetX - currentPos.x) * 0.7 + (Math.random() - 0.5) * 100;
          const cp2y = currentPos.y + (targetY - currentPos.y) * 0.7 + (Math.random() - 0.5) * 100;
          
          // 贝塞尔曲线公式
          const x = Math.pow(1 - t, 3) * currentPos.x + 
                    3 * Math.pow(1 - t, 2) * t * cp1x + 
                    3 * (1 - t) * Math.pow(t, 2) * cp2x + 
                    Math.pow(t, 3) * targetX;
          const y = Math.pow(1 - t, 3) * currentPos.y + 
                    3 * Math.pow(1 - t, 2) * t * cp1y + 
                    3 * (1 - t) * Math.pow(t, 2) * cp2y + 
                    Math.pow(t, 3) * targetY;
          
          // 移动速度变化（开始慢，中间快，结束慢）
          const speed = Math.sin(t * Math.PI) * 0.5 + 0.5; // 0-1之间的速度曲线
          await page.mouse.move(x, y);
          await page.waitForTimeout(10 + Math.floor(speed * 20)); // 10-30ms 每步
        }
        
        // 记录最终位置
        await page.evaluate(({ x, y }) => {
          window.mouseX = x;
          window.mouseY = y;
        }, { x: targetX, y: targetY });
        
        await page.waitForTimeout(randomDelay(200, 800));
      } catch (e) {
        // 如果曲线移动失败，回退到简单移动
        const x = Math.random() * 1920;
        const y = Math.random() * 1080;
        await page.mouse.move(x, y);
        await page.waitForTimeout(randomDelay(200, 800));
      }
    }
    
    // 随机查看视频（悬停）- 使用曲线移动
    if (Math.random() < videoHoverProbability) {
      try {
        const videos = await page.$$('video, [data-e2e="video-player"], a[href*="/video/"]');
        if (videos.length > 0) {
          const randomVideo = videos[Math.floor(Math.random() * videos.length)];
          const box = await randomVideo.boundingBox();
          if (box) {
            const targetX = box.x + box.width / 2;
            const targetY = box.y + box.height / 2;
            
            // 获取当前鼠标位置
            const currentPos = await page.evaluate(() => {
              return { x: window.mouseX || 960, y: window.mouseY || 540 };
            }).catch(() => ({ x: 960, y: 540 }));
            
            // 使用曲线移动到视频
            const steps = 8 + Math.floor(Math.random() * 7); // 8-14步
            for (let i = 0; i <= steps; i++) {
              const t = i / steps;
              const cp1x = currentPos.x + (targetX - currentPos.x) * 0.3;
              const cp1y = currentPos.y + (targetY - currentPos.y) * 0.3;
              
              const x = Math.pow(1 - t, 2) * currentPos.x + 2 * (1 - t) * t * cp1x + Math.pow(t, 2) * targetX;
              const y = Math.pow(1 - t, 2) * currentPos.y + 2 * (1 - t) * t * cp1y + Math.pow(t, 2) * targetY;
              
              await page.mouse.move(x, y);
              await page.waitForTimeout(15 + Math.floor(Math.random() * 15)); // 15-30ms
            }
            
            // 记录位置
            await page.evaluate(({ x, y }) => {
              window.mouseX = x;
              window.mouseY = y;
            }, { x: targetX, y: targetY });
            
            // 悬停时间（模拟查看视频）
            await page.waitForTimeout(randomDelay(1500, 4000)); // 1.5-4秒
            
            // 偶尔轻微移动鼠标（模拟真实悬停）
            if (Math.random() < 0.5) {
              await page.mouse.move(targetX + (Math.random() - 0.5) * 20, targetY + (Math.random() - 0.5) * 20);
              await page.waitForTimeout(randomDelay(500, 1500));
            }
          }
        }
      } catch (e) {
        // 忽略错误，继续执行
      }
    }
    
    // 随机向上滚动（回看，且不是第一次）
    if (i > 0 && Math.random() < scrollUpProbability) {
      const scrollUpPercentage = randomScrollDistance() * 0.5; // 向上滚动一半距离
      await page.evaluate(({ percentage }) => {
        const distance = Math.floor(window.innerHeight * percentage);
        window.scrollBy({ top: -distance, behavior: 'smooth' });
      }, { percentage: scrollUpPercentage });
      await page.waitForTimeout(randomDelay(1000, 2000));
    }
    
    // 滚动后等待
    await page.waitForTimeout(waitTime());
    
    // 检查是否已加载足够视频（最多 50 条）
    const videoCount = await page.evaluate(() => {
      return document.querySelectorAll('a[href*="/video/"]').length;
    });
    
    if (videoCount >= 50) {
      console.log(`[humanLikeScroll] 已加载 ${videoCount} 个视频，停止滚动`);
      break;
    }
  }
}

/**
 * 模拟人类停留行为
 */
async function humanLikeStay(page, options = {}) {
  const {
    initialWaitMin = 3000,
    initialWaitMax = 8000,
    finalWaitMin = 2000,
    finalWaitMax = 5000
  } = options;
  
  // 初始等待：3-8 秒
  await page.waitForTimeout(randomDelay(initialWaitMin, initialWaitMax));
  
  // 执行滚动浏览
  await humanLikeScroll(page, options);
  
  // 最后停留：2-5 秒
  await page.waitForTimeout(randomDelay(finalWaitMin, finalWaitMax));
}

/**
 * 合并搜索页面数据和主页数据
 * @param {Object} searchRecord - 搜索页面提取的红人记录
 * @param {Object} profileData - 主页提取的数据（extractUserProfile 返回的结果）
 * @returns {Object} 合并后的红人记录
 */
function mergeInfluencerData(searchRecord, profileData) {
  if (!profileData || !profileData.success || !profileData.userInfo) {
    // 如果主页提取失败，返回搜索页面的数据
    return searchRecord;
  }
  
  const { userInfo, statistics } = profileData;
  
  // 合并数据：主页数据优先，搜索页面数据作为补充
  return {
    ...searchRecord,
    // 用户基本信息（主页数据优先）
    displayName: userInfo.displayName || searchRecord.displayName || searchRecord.username,
    avatarUrl: userInfo.avatarUrl || searchRecord.avatarUrl,
    bio: userInfo.bio || searchRecord.bio,
    email: userInfo.email || null,
    verified: userInfo.verified !== undefined ? userInfo.verified : searchRecord.verified,
    
    // 粉丝和关注数据（主页数据优先）
    followers: userInfo.followers || searchRecord.followers,
    following: userInfo.following?.count || searchRecord.following,
    
    // 视频统计数据（主页数据优先）
    views: statistics?.avgViews ? {
      avg: statistics.avgViews,
      display: formatNumber(statistics.avgViews)
    } : searchRecord.views,
    
    engagement: {
      rate: searchRecord.engagement?.rate || null,
      avgLikes: statistics?.avgLikes || searchRecord.engagement?.avgLikes || null,
      avgComments: statistics?.avgComments || searchRecord.engagement?.avgComments || null
    },
    
    // 视频数量（主页数据优先）
    postsCount: userInfo.postsCount?.count || searchRecord.postsCount,
    
    // 保持其他字段不变
    username: searchRecord.username,
    profileUrl: searchRecord.profileUrl,
    platform: searchRecord.platform,
    country: searchRecord.country,
    
    // 保留搜索视频数据（如果存在）
    search_video_data: searchRecord.search_video_data || null
  };
}

/**
 * 格式化数字显示
 */
function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return String(num);
}

async function injectAntiDetectionScripts(page) {
  await page.evaluate(() => {
    // 重新定义属性（已在 addInitScript 中设置为 configurable: true，可以直接重新定义）
    try {
      Object.defineProperty(navigator, 'webdriver', { 
        get: () => false,
        configurable: true 
      });
    } catch (e) {
      // 如果无法定义，尝试先删除再定义
      try {
        delete navigator.webdriver;
        Object.defineProperty(navigator, 'webdriver', { 
          get: () => false,
          configurable: true 
        });
      } catch (e2) {
        // 忽略错误
      }
    }
    
    try {
      Object.defineProperty(navigator, 'plugins', { 
        get: () => [1, 2, 3, 4, 5],
        configurable: true 
      });
    } catch (e) {
      try {
        delete navigator.plugins;
        Object.defineProperty(navigator, 'plugins', { 
          get: () => [1, 2, 3, 4, 5],
          configurable: true 
        });
      } catch (e2) {
        // 忽略错误
      }
    }
    
    try {
      Object.defineProperty(navigator, 'languages', { 
        get: () => ['en-US', 'en'],
        configurable: true 
      });
    } catch (e) {
      try {
        delete navigator.languages;
        Object.defineProperty(navigator, 'languages', { 
          get: () => ['en-US', 'en'],
          configurable: true 
        });
      } catch (e2) {
        // 忽略错误
      }
    }
    
    // 设置 chrome 对象（如果不存在）
    if (typeof window.chrome === 'undefined') {
      window.chrome = { runtime: {}, loadTimes: function () {}, csi: function () {}, app: {} };
    }
    
    // 删除 Playwright/Puppeteer 标识
    delete window.__playwright;
    delete window.__pw_manual;
    delete window.__PUPPETEER_WORLD__;
    delete window.__puppeteer_evaluation__;
  });
}

/**
 * 检测 TikTok 页面是否已登录
 * @param {Page} page - Playwright 页面对象
 * @returns {Promise<boolean>} - 是否已登录
 */
async function checkTikTokLoginStatus(page) {
  console.warn('[checkTikTokLoginStatus] ⚠️ 已禁用登录阻断检查，默认通过');
      return true;
}

/**
 * 基于关键词从 TikTok 视频搜索页面获取红人基础信息
 * 使用 playwright + CDP + chrome（连接到已手动启动的 Chrome，使用已登录状态）
 * @param {Object} params - 参数 { keywords, campaignInfo }
 * @param {Object} options - 选项 { onStepUpdate }
 * @returns {Promise<{ influencerRecords: Array, videos: Array, stats: Object }>}
 */
/**
 * 报告结构化步骤
 * @param {Function} onStepUpdate - 步骤更新回调
 * @param {string} stepId - 步骤 ID
 * @param {string} status - 步骤状态
 * @param {string} detail - 详细信息
 * @param {Object} stats - 统计数据（可选）
 */
function reportStep(onStepUpdate, stepId, status, detail = null, stats = null) {
  if (!onStepUpdate) return;
  
  try {
    const step = createStep(stepId, status, detail, stats);
    try {
      onStepUpdate({
        type: 'step',
        step: step
      });
    } catch (updateError) {
      // 静默处理 SSE 流关闭错误
      if (updateError.code === 'ERR_INVALID_STATE' || updateError.message?.includes('closed')) {
        console.warn(`[searchAndExtractInfluencers] SSE 流已关闭，停止发送步骤更新`);
        return;
      } else {
        throw updateError;
      }
    }
  } catch (error) {
    // 静默处理 SSE 流关闭错误
    if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
      console.warn(`[searchAndExtractInfluencers] SSE 流已关闭，停止发送步骤更新`);
    } else {
      console.error(`[searchAndExtractInfluencers] reportStep 失败:`, error);
    }
  }
}

/**
 * 报告截图（支持直接传 dataURL，或传入 Playwright page 自动截图）
 * @param {Function} onStepUpdate - 步骤更新回调
 * @param {string} stepId - 关联的步骤 ID
 * @param {string} label - 截图标签
 * @param {string|Object} imageOrPage - data:image/... 或 Playwright page
 */
async function reportScreenshot(onStepUpdate, stepId, label, imageOrPage) {
  if (!onStepUpdate || !imageOrPage) return;

  let image = null;
  if (typeof imageOrPage === 'string') {
    image = imageOrPage;
  } else if (typeof imageOrPage.screenshot === 'function') {
    try {
      if (typeof imageOrPage.isClosed === 'function' && imageOrPage.isClosed()) return;
      const screenshot = await imageOrPage.screenshot({
        type: 'jpeg',
        quality: 70,
        fullPage: false
      });
      image = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
    } catch (e) {
      console.warn(`[searchAndExtractInfluencers] reportScreenshot 截图失败: ${e?.message || e}`);
      return;
    }
  }

  if (!image) return;
  onStepUpdate({
    type: 'screenshot',
    stepId: stepId,
    label: label,
    image,
    timestamp: new Date().toISOString()
  });
}

export async function searchInfluencersByKeyword(params = {}, options = {}) {
  const { keywords = {}, campaignInfo = {} } = params;
  // 允许调用方透传搜索细节配置（例如 scrollRounds）
  const { onStepUpdate = null, searchOptions = {} } = options;
  const sendStep = (step, message) => {
    try {
      if (onStepUpdate) {
        onStepUpdate({ step, message });
      }
    } catch (error) {
      // 静默处理 SSE 流关闭错误
      if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
        // 静默忽略
      } else {
        console.error(`[searchInfluencersByKeyword] 发送步骤更新失败:`, error);
      }
    }
  };

  const searchQueries = keywords.search_queries || [];
  if (searchQueries.length === 0) throw new Error('没有提供搜索关键词');

  // 报告连接 Chrome 步骤
  reportStep(onStepUpdate, BROWSER_STEP_IDS.CONNECT_CHROME, STEP_STATUS.RUNNING, '正在通过 CDP 连接浏览器（使用已登录的 Chrome）...');
  sendStep('启动浏览器', '正在通过 CDP 连接浏览器（使用已登录的 Chrome）...');
  
  // 检查是否使用 headless 模式
  const USE_HEADLESS = process.env.PLAYWRIGHT_HEADLESS === 'true';
  const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
  
  let browser = null;
  let context = null;
  let page = null;
  
  if (USE_HEADLESS) {
    // Headless 模式：自动启动浏览器
    console.log(`[searchInfluencersByKeyword] 🤖 使用 Headless 模式（自动启动浏览器）`);
    reportStep(onStepUpdate, BROWSER_STEP_IDS.CONNECT_CHROME, STEP_STATUS.RUNNING, '正在启动 Headless Chrome...');
    
    const userDataDir = getUserDataDir();
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    context = browser;
    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();
    
    console.log(`[searchInfluencersByKeyword] ✅ Headless Chrome 启动成功`);
    reportStep(onStepUpdate, BROWSER_STEP_IDS.CONNECT_CHROME, STEP_STATUS.COMPLETED, 'Headless Chrome 启动成功');
  } else {
    // 非 Headless 模式：连接到手动启动的 Chrome
    console.log(`[searchInfluencersByKeyword] 🔗 CDP 端点: ${CDP_ENDPOINT}`);
    console.log(`[searchInfluencersByKeyword] ⚠️  请确保已手动启动 Chrome 并启用远程调试：`);
    console.log(`[searchInfluencersByKeyword]    bash scripts/launch-chrome-remote-debug.sh`);
    console.log(`[searchInfluencersByKeyword] 💡 提示: 搜索功能需要登录状态，请确保 Chrome 已登录 TikTok`);
    
    let retryCount = 0;
    const maxRetries = 3;
    let connectError = null;
    
    // 尝试连接 CDP
    while (retryCount < maxRetries) {
      try {
        browser = await chromium.connectOverCDP(CDP_ENDPOINT, {
          timeout: 10000,
        });
        console.log(`[searchInfluencersByKeyword] ✅ CDP 连接成功（尝试 ${retryCount + 1}/${maxRetries}）`);
        reportStep(onStepUpdate, BROWSER_STEP_IDS.CONNECT_CHROME, STEP_STATUS.COMPLETED, 'CDP 连接成功');
        await reportScreenshot(onStepUpdate, BROWSER_STEP_IDS.CONNECT_CHROME, 'CDP 连接成功', page);
        break;
      } catch (error) {
        retryCount++;
        connectError = error;
        console.warn(`[searchInfluencersByKeyword] ⚠️  CDP 连接失败（尝试 ${retryCount}/${maxRetries}）:`, error.message);
        
        if (retryCount < maxRetries) {
          console.log(`[searchInfluencersByKeyword] 等待 2 秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
      }
    }
    
    if (!browser) {
      throw new Error(
        `CDP 连接失败（已重试 ${maxRetries} 次）: ${connectError?.message || '未知错误'}\n` +
        `请确保已手动启动 Chrome 并启用远程调试：\n` +
        `  bash scripts/launch-chrome-remote-debug.sh\n` +
        `或者设置 PLAYWRIGHT_HEADLESS=true 使用 Headless 模式`
      );
    }
    
    // 非 headless 模式下，需要获取 context
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    console.log(`[searchInfluencersByKeyword] ✅ 浏览器上下文已准备（使用现有上下文: ${contexts.length > 0}）`);
    
    // 按需跳过登录强校验：避免因页面结构变化造成误判阻断任务执行。
    const pages = context.pages();
    console.warn(
      `[searchInfluencersByKeyword] ⚠️ 已跳过 TikTok 登录状态强校验（context pages=${pages.length}），将直接执行任务`
    );

    // 采集时创建新页面，减少其它 Tab/页面状态对 API 拦截的影响
    page = await context.newPage();
    console.log(`[searchInfluencersByKeyword] ✅ 创建新采集页面`);
  }
  
  try {
    const firstKeyword = searchQueries[0];
    // 确保使用 /search/video 而不是 /search/user（视频搜索页面）
    const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(firstKeyword)}&t=${Date.now()}`;
    
    console.log(`[searchInfluencersByKeyword] 🔍 搜索 URL: ${searchUrl}`);
    console.log(`[searchInfluencersByKeyword] ✅ 使用 /search/video 端点（视频搜索）`);

    // 报告搜索视频步骤
    reportStep(onStepUpdate, BROWSER_STEP_IDS.SEARCH_VIDEOS, STEP_STATUS.RUNNING, `正在搜索视频: ${firstKeyword}`);
    sendStep('访问搜索页面', `正在访问搜索页面: ${firstKeyword}`);
    
    // 只使用 API 拦截方式（完全移除 DOM 提取方式）
    sendStep('使用 API 拦截', '正在使用 CDP Network 拦截方式提取数据...');
    const extractSearchResultsCDPModule = await import('./extract-search-results-cdp.js');
    const extractSearchResultsFromPageCDP = extractSearchResultsCDPModule.extractSearchResultsFromPageCDP;
    
    let searchData;
    try {
      searchData = await extractSearchResultsFromPageCDP(
        page,
        firstKeyword,
        {
          onStepUpdate: onStepUpdate,
          humanLikeBehavior: true, // 启用人类行为模拟
          page: page, // 传递 page 对象用于截图
          // 透传来自调用方的搜索配置（例如 scrollRounds）
          ...searchOptions,
        }
      );
    } catch (extractError) {
      // 检查是否是连接错误
      if (extractError.message.includes('ERR_CONNECTION_CLOSED') || 
          extractError.message.includes('Target closed') ||
          extractError.message.includes('页面连接失败')) {
        console.error(`[searchInfluencersByKeyword] ❌ 页面连接失败: ${extractError.message}`);
        throw new Error(`浏览器连接中断，请确保 Chrome 浏览器正在运行且 CDP 端点可访问。错误详情: ${extractError.message}`);
      }
      // 其他错误直接抛出
      throw extractError;
    }
    
    if (!searchData.success || (searchData.videos.length === 0 && searchData.influencers.length === 0)) {
      throw new Error(`API 拦截未获取到数据: ${searchData.videos.length} 个视频, ${searchData.influencers.length} 个红人`);
    }
    await reportScreenshot(onStepUpdate, BROWSER_STEP_IDS.SEARCH_VIDEOS, `搜索完成（${searchData.videos.length} 视频）`, page);
    
    // 转换数据格式以兼容现有代码
    const videos = searchData.videos.map(v => ({
      videoId: v.videoId || null,
      videoUrl: v.videoUrl || null,
      username: v.username || null,
      profileUrl: v.profileUrl || null,
      views: v.views || { count: 0, display: '0' },
      likes: v.likes || { count: 0, display: '0' },
      thumbnail: v.thumbnail || null,
      description: v.description || null,
      caption: v.caption || null,
      hashtags: v.hashtags || null,
      mentions: v.mentions || null,
      music: v.music || null,
      creator: v.creator || null,
      postedTime: v.postedTime || null
    }));
    
    const influencerRecords = searchData.influencers.map(inf => ({
      username: inf.username,
      displayName: inf.displayName || inf.username,
      profileUrl: inf.profileUrl,
      avatarUrl: inf.avatarUrl || '',
      followers: inf.followers || { count: 0, display: '0' },
      bio: inf.bio || '',
      verified: inf.verified || false,
      platform: inf.platform || 'TikTok',
      country: campaignInfo.country || '',
      accountType: '',
      accountTypes: []
    }));
    
    // 按红人分组视频数据（用于保存到 search_video_data）
    const videosByInfluencer = {};
    for (const video of videos) {
      if (video.username) {
        if (!videosByInfluencer[video.username]) {
          videosByInfluencer[video.username] = [];
        }
        videosByInfluencer[video.username].push(video);
      }
    }
    
    // 为每个红人记录添加搜索视频数据
    for (const record of influencerRecords) {
      const username = record.username.replace(/^@/, '');
      record.search_video_data = videosByInfluencer[username] || [];
    }
    
    const extractionResult = {
      videos: videos,
      influencers: influencerRecords,
      influencerRecords: influencerRecords, // 数据库格式
      stats: {
        totalTime: '0',
        llmTime: '0',
        videoCount: videos.length,
        influencerCount: influencerRecords.length
      }
    };
    
    console.log(`[searchInfluencersByKeyword] ✅ API 拦截成功: ${videos.length} 个视频, ${influencerRecords.length} 个红人`);
    
    // 报告搜索完成
    reportStep(onStepUpdate, BROWSER_STEP_IDS.SEARCH_VIDEOS, STEP_STATUS.COMPLETED, 
      `搜索完成: 已提取 ${videos.length} 个视频, ${influencerRecords.length} 个红人`,
      { videos: videos.length, influencers: influencerRecords.length }
    );
    
    // 保存搜索到的红人数据到日志
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logsDir = path.join(__dirname, '../../../logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      
      const searchLogData = {
        timestamp: new Date().toISOString(),
        keyword: firstKeyword,
        searchUrl: searchUrl,
        influencerRecords: extractionResult.influencerRecords,
        videos: extractionResult.videos,
        stats: extractionResult.stats
      };
      
      const searchLogPath = path.join(logsDir, `search-influencers-${timestamp}.json`);
      fs.writeFileSync(searchLogPath, JSON.stringify(searchLogData, null, 2), 'utf-8');
      console.log(`[searchInfluencersByKeyword] ✅ 搜索到的红人数据已保存到: ${searchLogPath}`);
    } catch (e) {
      console.warn('[searchInfluencersByKeyword] 保存搜索数据失败:', e.message);
    }
    
    return {
      influencerRecords: extractionResult.influencerRecords,
      videos: extractionResult.videos,
      stats: extractionResult.stats
    };
  } catch (error) {
    console.error(`[searchInfluencersByKeyword] ❌ 错误:`, error.message);
    throw error;
  } finally {
    // 显式关闭本次采集页面，避免关键词任务累计导致 Tab 膨胀
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch (e) {
        console.warn("[searchInfluencersByKeyword] 关闭采集页面失败:", e.message);
      }
    }
    // 关闭 CDP 连接（不关闭浏览器，因为它是手动启动的）
    if (browser) {
      try {
        await browser.close();
        console.log('[searchInfluencersByKeyword] ✅ CDP 连接已断开');
      } catch (e) {
        console.warn('[searchInfluencersByKeyword] 断开 CDP 连接失败:', e.message);
      }
    }
  }
}

/**
 * 批量提取红人主页数据（支持 3-5 个标签页分批并发）
 * 使用 playwright + CDP + chrome（手动启动，不需要登录状态）
 * @param {Array} influencerRecords - 搜索页面提取的红人记录数组
 * @param {Object} options - 选项
 * @param {Function} options.onStepUpdate - 步骤更新回调函数
 * @param {number} options.maxCount - 最多提取多少个红人的主页数据（默认 20）
 * @param {number} options.concurrency - 每批并发标签页数（默认 1，一次只加载一个主页）
 * @param {Object} options.delayBetweenBatches - 批间延迟范围 {min, max}（默认 5000-10000）
 * @returns {Promise<Array>} 合并后的红人记录数组
 */
export async function enrichInfluencerProfiles(influencerRecords, options = {}) {
  const {
    onStepUpdate = null,
    maxCount = 20,
    concurrency = 1,
    delayBetweenRequests = { min: 8000, max: 20000 },
    delayBetweenBatches = { min: 5000, max: 10000 },
    // 新增：用于实时匹配分析的配置
    influencerProfile = null,
    productInfo = null,
    campaignInfo = null,
    enableLiveMatch = true
  } = options;
  
  const sendStep = (step, message) => {
    try {
      if (onStepUpdate) {
        onStepUpdate({ step, message });
      }
      console.log(`[enrichInfluencerProfiles] ${step}: ${message}`);
    } catch (error) {
      // 静默处理 SSE 流关闭错误
      if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
        console.warn(`[enrichInfluencerProfiles] SSE 流已关闭，停止发送步骤更新`);
      } else {
        console.error(`[enrichInfluencerProfiles] 发送步骤更新失败:`, error);
      }
    }
  };
  
  // 是否启用实时匹配分析（需要画像要求）
  const shouldAnalyzeLive = enableLiveMatch && !!influencerProfile;

  // 懒加载单个红人匹配分析函数
  let analyzeInfluencerMatchFn = null;

  // 创建详细日志数组
  const detailedLogs = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logsDir = path.join(__dirname, '../../../logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  
  if (!influencerRecords || influencerRecords.length === 0) {
    return influencerRecords;
  }
  
  // 限制提取数量
  const recordsToEnrich = influencerRecords.slice(0, maxCount);
  const recordsToSkip = influencerRecords.slice(maxCount);
  
  // 报告开始提取主页数据
  reportStep(onStepUpdate, BROWSER_STEP_IDS.ENRICH_PROFILES, STEP_STATUS.RUNNING, 
    `准备提取 ${recordsToEnrich.length} 个红人的主页数据（共 ${influencerRecords.length} 个）`
  );
  
  sendStep('启动浏览器', '正在通过 CDP 连接浏览器（不需要登录状态）...');
  
  // 检查是否使用 headless 模式
  const USE_HEADLESS = process.env.PLAYWRIGHT_HEADLESS === 'true';
  const CDP_ENDPOINT = process.env.CDP_ENDPOINT_ENRICH || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9223';
  
  let browser = null;
  let connectError = null;
  const maxRetries = 3;
  
  if (USE_HEADLESS) {
    // Headless 模式：自动启动浏览器
    console.log(`[enrichInfluencerProfiles] 🤖 使用 Headless 模式（自动启动浏览器）`);
    
    const userDataDir = path.join(__dirname, '../../../.tiktok-user-data-enrich');
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    
    console.log(`[enrichInfluencerProfiles] ✅ Headless Chrome 启动成功`);
  } else {
    // 非 Headless 模式：连接到手动启动的 Chrome
    console.log(`[enrichInfluencerProfiles] 🔗 CDP 端点: ${CDP_ENDPOINT}`);
    console.log(`[enrichInfluencerProfiles] ⚠️  请确保已手动启动 Chrome 并启用远程调试：`);
    if (process.env.CDP_ENDPOINT_ENRICH) {
      console.log(`[enrichInfluencerProfiles]    bash scripts/launch-chrome-remote-debug.sh --port 9223`);
    } else {
      console.log(`[enrichInfluencerProfiles]    bash scripts/launch-chrome-remote-debug.sh`);
    }
    console.log(`[enrichInfluencerProfiles] 💡 提示: 主页提取不需要登录状态，建议使用独立的未登录 Chrome 实例（端口 9223）`);
    
    let retryCount = 0;
    
    // 尝试连接 CDP
    while (retryCount < maxRetries) {
      try {
        browser = await chromium.connectOverCDP(CDP_ENDPOINT, {
          timeout: 10000,
        });
        console.log(`[enrichInfluencerProfiles] ✅ CDP 连接成功（尝试 ${retryCount + 1}/${maxRetries}）`);
        break;
      } catch (error) {
        retryCount++;
        connectError = error;
        console.warn(`[enrichInfluencerProfiles] ⚠️  CDP 连接失败（尝试 ${retryCount}/${maxRetries}）:`, error.message);
        
        if (retryCount < maxRetries) {
          console.log(`[enrichInfluencerProfiles] 等待 2 秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
      }
    }
  }
  
  if (!browser) {
    throw new Error(
      `浏览器启动失败（已重试 ${maxRetries} 次）: ${connectError?.message || '未知错误'}\n` +
      `请确保已手动启动 Chrome 并启用远程调试：\n` +
      `  bash scripts/launch-chrome-remote-debug.sh\n` +
      `或者设置 PLAYWRIGHT_HEADLESS=true 使用 Headless 模式`
    );
  }
  
  // 获取或创建 context（headless 模式下 browser 已经是 context）
  let context;
  if (USE_HEADLESS) {
    // Headless 模式下，browser 就是 context
    context = browser;
    console.log(`[enrichInfluencerProfiles] ✅ Headless 模式：浏览器上下文已准备`);
  } else {
    // 非 headless 模式下，需要获取 context
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    console.log(`[enrichInfluencerProfiles] ✅ 浏览器上下文已准备（使用现有上下文: ${contexts.length > 0}）`);
  }
  
  sendStep('开始提取主页数据', `准备提取 ${recordsToEnrich.length} 个红人的主页数据（共 ${influencerRecords.length} 个）`);
  
  const enrichedRecords = [];
  let successCount = 0;
  let failedCount = 0;
  
  // 分批并发处理（每批 concurrency 个标签页，缩短总耗时）
  const processOneRecord = async (record, index) => {
    const progress = `${index + 1}/${recordsToEnrich.length}`;
    const profilePage = await context.newPage();
    
    try {
      // 直接导航到红人主页 URL
      const targetUrl = record.profileUrl;
      sendStep('打开新标签页', `[${progress}] 在新标签页中打开 @${record.username} 的主页...`);
      
      await profilePage.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      
      sendStep('导航成功', `[${progress}] ✅ 成功在新标签页中打开 @${record.username} 的主页`);
      
      // 随机等待页面加载（模拟人类行为）
      const initialWaitTime = 1500 + Math.floor(Math.random() * 1500); // 1.5-3秒随机
      sendStep('等待加载', `[${progress}] 等待页面加载（${(initialWaitTime / 1000).toFixed(1)}秒）...`);
      await profilePage.waitForTimeout(initialWaitTime);
      
      // 直接使用 CDP Network 拦截方式提取数据（移除滚动浏览步骤）
      sendStep('提取数据', `[${progress}] 正在使用 CDP 拦截提取主页数据...`);
      
      const startTime = Date.now();
      let profileData = {
        success: false,
        error: '未提取',
        userInfo: null,
        videos: []
      };
      
      try {
        // 使用 CDP Network 拦截方式提取数据（无时间限制，直到完成）
        const extractUserProfileCDPModule = await import('./extract-user-profile-cdp.js');
        const extractUserProfileFromPageCDP = extractUserProfileCDPModule.extractUserProfileFromPageCDP;
        
        profileData = await extractUserProfileFromPageCDP(
          profilePage,
          record.username,
          {
            onStepUpdate: onStepUpdate, // 传递 onStepUpdate 以支持步骤和截图报告
            humanLikeBehavior: true // 启用人类行为模拟
          }
        );
        
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[enrichInfluencerProfiles] [${progress}] ✅ CDP 提取完成（耗时 ${elapsedTime}s）`);
      } catch (error) {
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.warn(`[enrichInfluencerProfiles] [${progress}] ❌ CDP 提取失败（耗时 ${elapsedTime}s）: ${error.message}`);
        profileData = {
          success: false,
          error: error.message,
          userInfo: null,
          videos: []
        };
      }
      
      // 保存 CDP 提取的视频数据到日志（如果成功）
      if (profileData.success && profileData.videos && profileData.videos.length > 0) {
        try {
          const videoLogData = {
            timestamp: new Date().toISOString(),
            username: record.username,
            profileUrl: record.profileUrl,
            extractionMethod: 'CDP Network Interception',
            videoCount: profileData.videos.length,
            videos: profileData.videos.map(v => ({
              videoId: v.videoId || null,
              videoUrl: v.videoUrl || null,
              description: v.description ? v.description.substring(0, 100) + '...' : null,
              views: v.views || null,
              likes: v.likes || null,
              comments: v.comments || null,
              shares: v.shares || null,
              favorites: v.favorites || null
            }))
          };
          
          const videoLogPath = path.join(logsDir, `profile-videos-${record.username}-${timestamp}.json`);
          fs.writeFileSync(videoLogPath, JSON.stringify(videoLogData, null, 2), 'utf-8');
          console.log(`[enrichInfluencerProfiles] [${progress}] ✅ 视频数据已保存到: ${videoLogPath}`);
        } catch (e) {
          console.warn(`[enrichInfluencerProfiles] 保存视频数据失败: ${e.message}`);
        }
      }
      
      // 4. 记录详细日志
      const logEntry = {
        timestamp: new Date().toISOString(),
        progress: progress,
        username: record.username,
        profileUrl: record.profileUrl,
        success: profileData.success,
        extractedData: null,
        error: null,
        beforeData: {
          displayName: record.displayName || null,
          avatarUrl: record.avatarUrl || null,
          followers: record.followers || null,
          bio: record.bio || null,
          verified: record.verified || false
        },
        afterData: null
      };
      
      if (profileData.success) {
        // 记录提取到的数据
        logEntry.extractedData = {
          userInfo: {
            displayName: profileData.userInfo?.displayName || null,
            avatarUrl: profileData.userInfo?.avatarUrl || null,
            bio: profileData.userInfo?.bio || null,
            email: profileData.userInfo?.email || null,
            followers: profileData.userInfo?.followers || null,
            following: profileData.userInfo?.following || null,
            likes: profileData.userInfo?.likes || null,
            verified: profileData.userInfo?.verified || false,
            postsCount: profileData.userInfo?.postsCount || null
          },
          videos: {
            count: profileData.videos?.length || 0,
            sample: profileData.videos?.slice(0, 3).map(v => ({
              videoId: v.videoId || null,
              videoUrl: v.videoUrl || null,
              description: v.description ? v.description.substring(0, 100) + '...' : null,
              views: v.views || null,
              likes: v.likes || null,
              comments: v.comments || null,
              favorites: v.favorites || null
            })) || []
          },
          statistics: profileData.statistics || null,
          missingData: profileData.missingData || null
        };
        
        successCount++;
        sendStep('提取成功', `[${progress}] ✅ @${record.username} 数据提取成功`);
        
        // 输出详细提取信息到控制台
        console.log(`\n${'='.repeat(80)}`);
        console.log(`[${progress}] @${record.username} - 数据提取详情:`);
        console.log(`${'='.repeat(80)}`);
        console.log(`✅ 提取成功`);
        console.log(`\n📊 用户信息:`);
        console.log(`   显示名: ${profileData.userInfo?.displayName || '(未提取)'}`);
        console.log(`   头像: ${profileData.userInfo?.avatarUrl ? '✅ 已提取' : '❌ 未提取'}`);
        console.log(`   简介: ${profileData.userInfo?.bio ? profileData.userInfo.bio.substring(0, 100) + '...' : '(未提取)'}`);
        console.log(`   邮箱: ${profileData.userInfo?.email || '(未提取)'}`);
        console.log(`   粉丝: ${profileData.userInfo?.followers?.display || profileData.userInfo?.followers?.count || '(未提取)'}`);
        console.log(`   关注: ${profileData.userInfo?.following?.display || profileData.userInfo?.following?.count || '(未提取)'}`);
        console.log(`   获赞: ${profileData.userInfo?.likes?.display || profileData.userInfo?.likes?.count || '(未提取)'}`);
        console.log(`   认证: ${profileData.userInfo?.verified ? '✅' : '❌'}`);
        console.log(`   视频数: ${profileData.userInfo?.postsCount || '(未提取)'}`);
        console.log(`\n📹 视频数据:`);
        console.log(`   视频总数: ${profileData.videos?.length || 0}`);
        if (profileData.statistics) {
          console.log(`   平均播放量: ${profileData.statistics.avgViews ? profileData.statistics.avgViews.toLocaleString() : '(未计算)'}`);
          console.log(`   平均点赞量: ${profileData.statistics.avgLikes ? profileData.statistics.avgLikes.toLocaleString() : '(未计算)'}`);
          console.log(`   平均评论量: ${profileData.statistics.avgComments ? profileData.statistics.avgComments.toLocaleString() : '(未计算)'}`);
          console.log(`   平均收藏量: ${profileData.statistics.avgFavorites ? profileData.statistics.avgFavorites.toLocaleString() : '(未计算)'}`);
        }
        if (profileData.videos && profileData.videos.length > 0) {
          console.log(`\n   前3个视频示例:`);
          profileData.videos.slice(0, 3).forEach((v, idx) => {
            console.log(`   ${idx + 1}. ${v.videoId || '(无ID)'}`);
            console.log(`      播放: ${v.views?.display || v.views?.count || '(无)'}`);
            console.log(`      点赞: ${v.likes?.display || v.likes?.count || '(无)'}`);
            console.log(`      评论: ${v.comments?.display || v.comments?.count || '(无)'}`);
            console.log(`      收藏: ${v.favorites?.display || v.favorites?.count || '(无)'}`);
          });
        }
        if (profileData.missingData) {
          const missing = Object.entries(profileData.missingData).filter(([_, v]) => v !== null);
          if (missing.length > 0) {
            console.log(`\n⚠️  缺失数据:`);
            missing.forEach(([key, value]) => {
              console.log(`   ${key}: ${value}`);
            });
          }
        }
        console.log(`${'='.repeat(80)}\n`);
      } else {
        logEntry.error = profileData.error || '未知错误';
        failedCount++;
        console.warn(`[enrichInfluencerProfiles] 主页提取失败: ${record.username} - ${logEntry.error}`);
        
        console.log(`\n${'='.repeat(80)}`);
        console.log(`[${progress}] @${record.username} - 数据提取详情:`);
        console.log(`${'='.repeat(80)}`);
        console.log(`❌ 提取失败`);
        console.log(`   错误: ${logEntry.error}`);
        console.log(`${'='.repeat(80)}\n`);
      }
      
      // 4. 合并数据
      const mergedRecord = mergeInfluencerData(record, profileData);
      
      // 确保包含 profile_data 和 search_video_data（用于后续分析）
      mergedRecord.profile_data = profileData || null;
      mergedRecord.search_video_data = record.search_video_data || null;
      
      // 记录合并后的数据
      logEntry.afterData = {
        displayName: mergedRecord.displayName || null,
        avatarUrl: mergedRecord.avatarUrl || null,
        followers: mergedRecord.followers || null,
        bio: mergedRecord.bio || null,
        verified: mergedRecord.verified || false,
        views: mergedRecord.views || null,
        engagement: mergedRecord.engagement || null,
        following: mergedRecord.following || null,
        postsCount: mergedRecord.postsCount || null
      };
      
      // 5. 立即保存到数据库（方案1：实时写入）
      let dbSaveResult = null;
      if (profileData.success && mergedRecord.username) {
        try {
          sendStep('保存到数据库', `[${progress}] 正在保存 @${record.username} 到数据库...`);
          
          // 转换为数据库格式
          const dbInfluencer = {
            username: mergedRecord.username.replace(/^@/, ''), // 移除 @ 符号
            displayName: mergedRecord.displayName || mergedRecord.username,
            profileUrl: mergedRecord.profileUrl,
            avatarUrl: mergedRecord.avatarUrl || '',
            bio: mergedRecord.bio || '',
            verified: mergedRecord.verified || false,
            // 项目统一 influencerId：使用 TikTok 数字 userId
            tiktokUserId: profileData?.userInfo?.userId || null,
            tiktokSecUid: profileData?.userInfo?.secUid || null,
            followers: mergedRecord.followers || { count: 0, display: '0' },
            views: mergedRecord.views || { avg: 0, display: '0' },
            engagement: mergedRecord.engagement || {
              rate: 0,
              avgLikes: 0,
              avgComments: 0
            },
            // following 可能是数字或对象，需要转换为数字
            following: typeof mergedRecord.following === 'object' && mergedRecord.following !== null
              ? mergedRecord.following.count || mergedRecord.following
              : mergedRecord.following || null,
            // postsCount 可能是数字或对象，需要转换为数字
            postsCount: typeof mergedRecord.postsCount === 'object' && mergedRecord.postsCount !== null
              ? mergedRecord.postsCount.count || mergedRecord.postsCount
              : mergedRecord.postsCount || null,
            country: mergedRecord.country || '',
            accountType: mergedRecord.accountType || '',
            accountTypes: mergedRecord.accountTypes || [],
            // 添加完整的 profileData（包含所有提取的信息：videos数组、statistics、interceptedApis等）
            profile_data: profileData || null
            // 注意：不传递 search_video_data，因为主页提取时只更新 profile_data
            // search_video_data 已在搜索阶段保存，不会被覆盖（因为使用了 updateProfileOnly: true）
          };
          
          // 使用 updateProfileOnly: true，只更新 profile_data，不更新 search_video_data
          dbSaveResult = await saveTikTokInfluencer(dbInfluencer, { updateProfileOnly: true });
          
          if (dbSaveResult.success) {
            sendStep('保存成功', `[${progress}] ✅ @${record.username} 已保存到数据库 (ID: ${dbSaveResult.id})`);
            console.log(`[enrichInfluencerProfiles] [${progress}] ✅ 数据库保存成功: @${record.username} (ID: ${dbSaveResult.id})`);
            logEntry.dbSave = {
              success: true,
              id: dbSaveResult.id,
              message: dbSaveResult.message
            };
          } else {
            console.warn(`[enrichInfluencerProfiles] [${progress}] ⚠️  数据库保存失败: @${record.username} - ${dbSaveResult.message}`);
            logEntry.dbSave = {
              success: false,
              id: null,
              message: dbSaveResult.message
            };
          }
        } catch (dbError) {
          console.error(`[enrichInfluencerProfiles] [${progress}] ❌ 数据库保存异常: @${record.username} - ${dbError.message}`);
          logEntry.dbSave = {
            success: false,
            id: null,
            message: `异常: ${dbError.message}`
          };
          // 不抛出错误，继续处理下一个红人
        }
      } else {
        console.log(`[enrichInfluencerProfiles] [${progress}] ⏭️  跳过数据库保存: 数据提取失败或缺少用户名`);
        logEntry.dbSave = {
          success: false,
          id: null,
          message: '数据提取失败或缺少用户名'
        };
      }

      // 6. 实时分析红人是否匹配画像要求（方案 A：每读完一个主页就分析一次）
      if (shouldAnalyzeLive && mergedRecord.username) {
        try {
          console.log(`[enrichInfluencerProfiles] [${progress}] 🧠 开始分析红人匹配度: @${mergedRecord.username}`);
          // 懒加载分析函数
          if (!analyzeInfluencerMatchFn) {
            const analyzeModule = await import('./analyze-influencer-match.js');
            analyzeInfluencerMatchFn = analyzeModule.analyzeInfluencerMatch;
          }

          // 流式分析文本累积（节流推送，避免前端出现“每秒几个字”的卡顿体验）
          let streamingAnalysisText = '';
          let lastStreamPushAt = 0;
          const STREAM_PUSH_INTERVAL_MS = 800;
          const STREAM_PREVIEW_MAX_LEN = 1600;
          
          // 流式回调：实时推送分析文本到前端
          const onStreamChunk = (chunk) => {
            streamingAnalysisText += chunk;
            const now = Date.now();
            if (now - lastStreamPushAt < STREAM_PUSH_INTERVAL_MS) return;
            lastStreamPushAt = now;
            const previewText =
              streamingAnalysisText.length > STREAM_PREVIEW_MAX_LEN
                ? `...${streamingAnalysisText.slice(-STREAM_PREVIEW_MAX_LEN)}`
                : streamingAnalysisText;
            // 实时更新浏览器步骤 detail（节流 + 限长）
            if (onStepUpdate) {
              reportStep(
                onStepUpdate,
                BROWSER_STEP_IDS.ANALYZE_MATCH,
                STEP_STATUS.RUNNING,
                previewText,
                {
                  current: index + 1,
                  total: recordsToEnrich.length,
                  analyzing: mergedRecord.username,
                  streamingAnalysis: previewText
                }
              );
            }
          };

          const analysisResult = await analyzeInfluencerMatchFn(
            {
              ...mergedRecord,
              // 确保包含分析函数期望的字段
              profile_data: mergedRecord.profile_data || profileData || null,
              search_video_data: mergedRecord.search_video_data || record.search_video_data || null
            },
            influencerProfile,
            productInfo || {},
            campaignInfo || {},
            onStreamChunk // 传递流式回调
          );

          console.log(
            `[enrichInfluencerProfiles] [${progress}] ✅ 匹配度分析完成: @${mergedRecord.username} ` +
            `(recommended=${analysisResult.isRecommended}, score=${analysisResult.score})`
          );

          // 合并分析结果到当前记录
          mergedRecord.isRecommended = analysisResult.isRecommended;
          mergedRecord.recommendationReason = analysisResult.reason;
          mergedRecord.recommendationScore = analysisResult.score;
          mergedRecord.recommendationAnalysis = analysisResult.analysis;

          // 通过浏览器步骤实时上报这一位红人的匹配结论
          const statusText = analysisResult.isRecommended ? '✅ 推荐' : '❌ 不推荐';
          reportStep(
            onStepUpdate,
            BROWSER_STEP_IDS.ANALYZE_MATCH,
            STEP_STATUS.RUNNING,
            `[${progress}] ${statusText} @${mergedRecord.username} - ${analysisResult.reason}`,
            {
              current: index + 1,
              total: recordsToEnrich.length,
              analyzing: mergedRecord.username,
              isRecommended: analysisResult.isRecommended,
              score: analysisResult.score
            }
          );

          // 实时推送红人卡片到前端（用于右侧卡片区逐个累积展示）
          if (onStepUpdate) {
            const followersDisplay = typeof mergedRecord.followers === 'object' && mergedRecord.followers?.display
              ? mergedRecord.followers.display
              : (typeof mergedRecord.followers === 'string' ? mergedRecord.followers : formatNumber(mergedRecord.followers?.count || 0));
            const viewsDisplay = typeof mergedRecord.views === 'object' && mergedRecord.views?.display
              ? mergedRecord.views.display
              : (typeof mergedRecord.views === 'object' && mergedRecord.views?.avg
                ? formatNumber(mergedRecord.views.avg)
                : (typeof mergedRecord.views === 'string' ? mergedRecord.views : formatNumber(mergedRecord.views?.count || 0)));
            try {
              console.log(`[enrichInfluencerProfiles] [${progress}] 📤 推送 influencerAnalysis 到前端: @${mergedRecord.username}`);
              onStepUpdate({
                type: 'influencerAnalysis',
                influencer: {
                  avatar: mergedRecord.avatarUrl || '',
                  profileUrl: mergedRecord.profileUrl || '',
                  platform: mergedRecord.platform || (mergedRecord.profileUrl?.includes('instagram.com') ? 'Instagram' : 'TikTok'),
                  id: mergedRecord.username || '',
                  name: mergedRecord.displayName || mergedRecord.username || '',
                  followers: followersDisplay,
                  views: viewsDisplay,
                  reason: analysisResult.reason || '',
                  isRecommended: analysisResult.isRecommended,
                  analysis: analysisResult.analysis || '',
                  score: analysisResult.score || 0,
                  order: index + 1,
                  timestamp: new Date().toISOString()
                }
              });
            } catch (e) {
              if (e.code !== 'ERR_INVALID_STATE' && !e.message?.includes('closed')) {
                console.warn('[enrichInfluencerProfiles] 推送红人卡片失败:', e.message);
              }
            }
          }
        } catch (analysisError) {
          console.warn(
            `[enrichInfluencerProfiles] 分析红人匹配度失败 (@${mergedRecord.username}):`,
            analysisError
          );
        }
      }
      
      return { mergedRecord, logEntry, success: true, dbSaveResult };
      
    } catch (error) {
      failedCount++;
      console.error(`[enrichInfluencerProfiles] 提取失败 ${record.username}:`, error.message);
      
      // 记录错误日志
      const errorLogEntry = {
        timestamp: new Date().toISOString(),
        progress: progress,
        username: record.username,
        profileUrl: record.profileUrl,
        success: false,
        extractedData: null,
        error: error.message,
        stack: error.stack,
        beforeData: {
          displayName: record.displayName || null,
          avatarUrl: record.avatarUrl || null,
          followers: record.followers || null,
          bio: record.bio || null,
          verified: record.verified || false
        },
        afterData: null
      };
      
      console.log(`\n${'='.repeat(80)}`);
      console.log(`[${progress}] @${record.username} - 数据提取详情:`);
      console.log(`${'='.repeat(80)}`);
      console.log(`❌ 提取异常`);
      console.log(`   错误: ${error.message}`);
      if (error.stack) {
        console.log(`   堆栈: ${error.stack.split('\n').slice(0, 3).join('\n')}`);
      }
      console.log(`${'='.repeat(80)}\n`);
      
      return { mergedRecord: record, logEntry: errorLogEntry, success: false };
    } finally {
      try {
        await profilePage.close();
        console.log(`[enrichInfluencerProfiles] ✅ 已关闭 @${record.username} 的新标签页`);
      } catch (e) {
        console.warn(`[enrichInfluencerProfiles] 关闭新标签页失败: ${e.message}`);
      }
    }
  };



// ========== 主函数 ==========

/**
 * 搜索并提取红人数据
 * @param {Object} params - 参数对象
 * @param {Object} params.keywords - 关键词对象（包含 search_queries 数组）
 * @param {Array<string>} params.platforms - 平台列表（如 ['TikTok']）
 * @param {Array<string>} params.countries - 国家列表
 * @param {Object} params.productInfo - 产品信息
 * @param {Object} params.campaignInfo - Campaign信息
 * @param {Object} params.influencerProfile - 红人画像要求
 * @param {Object} options - 选项
 * @param {number} options.maxResults - 最大结果数（默认20）
 * @param {Function} options.onStepUpdate - 步骤更新回调函数
 * @returns {Promise<Object>} - { success: boolean, influencers: Array, videos: Array, error?: string }
 */
async function searchAndExtractInfluencers_v2(params = {}, options = {}) {
  const {
    keywords = {},
    platforms = [],
    countries = [],
    productInfo = {},
    campaignInfo = {},
    influencerProfile = null,
    campaignId = null,
  } = params;
  const { 
    maxResults = 20, 
    onStepUpdate = null,
    enrichProfileData = true,  // 是否提取主页数据（默认启用）
    maxEnrichCount = 20,       // 最多提取多少个红人的主页数据
    batchSize = 5,             // 每批处理数量
    delayBetweenBatches = 3000 // 批次间延迟（毫秒）
  } = options;
  
  const sendStep = (step, message) => {
    try {
      if (onStepUpdate) {
        onStepUpdate({ step, message });
      }
    } catch (error) {
      // 静默处理 SSE 流关闭错误
      if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
        // 静默忽略
      } else {
        console.error(`[searchAndExtractInfluencers] 发送步骤更新失败:`, error);
      }
    }
  };
  
  try {
    const searchQueries = keywords.search_queries || [];
    if (searchQueries.length === 0) {
      throw new Error('没有提供搜索关键词');
    }
    
    // 1. 搜索红人（使用 playwright + CDP + chrome，需要登录状态）
    sendStep('搜索红人', '正在搜索红人（使用 CDP 连接，需要已登录的 Chrome）...');
    const searchResult = await searchInfluencersByKeyword({ keywords, campaignInfo }, { onStepUpdate });
    const extractionResult = {
      influencerRecords: searchResult.influencerRecords,
      videos: searchResult.videos,
      stats: searchResult.stats
    };
    
    // 2. 立即保存搜索数据到数据库（包含 search_video_data）
    let searchSaveResult = { success: 0 };
    if (extractionResult.influencerRecords.length > 0) {
      sendStep('保存搜索数据', `正在将${extractionResult.influencerRecords.length}个红人的搜索数据保存到数据库...`);
      searchSaveResult = await saveTikTokInfluencers(extractionResult.influencerRecords);
      sendStep('搜索数据已保存', `✅ 成功保存${searchSaveResult.success}个红人的搜索数据（包含 search_video_data）`);
      console.log(`[searchAndExtractInfluencers] ✅ 搜索数据已保存: ${searchSaveResult.success}个红人`);
    }
    
    // 3. 批量提取主页数据（如果启用）- 使用 playwright + CDP + chrome（不需要登录状态）
    let finalInfluencerRecords = extractionResult.influencerRecords;
    if (enrichProfileData && finalInfluencerRecords.length > 0) {
      sendStep('提取主页数据', `开始提取红人主页数据（使用 CDP 连接，不需要登录状态）...`);
      const enrichEndpoint = process.env.CDP_ENDPOINT_ENRICH || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9223';
      console.log(`[searchAndExtractInfluencers] 💡 提示: 主页提取将使用独立的 Chrome 实例（端口 9223），请确保已启动：`);
      console.log(`[searchAndExtractInfluencers]    bash scripts/launch-chrome-remote-debug-enrich.sh`);
      console.log(`[searchAndExtractInfluencers]    CDP 端点: ${enrichEndpoint}`);
      finalInfluencerRecords = await enrichInfluencerProfiles(
        finalInfluencerRecords,
        {
          onStepUpdate,
          maxCount: maxEnrichCount,
          concurrency: 1, // 一次只加载一个主页，模拟人类浏览行为
          delayBetweenBatches: { min: 5000, max: 10000 },
          // 将画像与产品/Campaign 信息传入，用于实时匹配分析
          influencerProfile,
          productInfo,
          campaignInfo,
          enableLiveMatch: !!influencerProfile
        }
      );
    }
    
    // 注意：搜索数据已在步骤2保存，主页数据已在 enrichInfluencerProfiles 中逐条保存
    // 无需再次批量保存
    
    // 4. 分析红人是否匹配画像要求的汇总（实时分析已在 enrichInfluencerProfiles 中完成）
    if (influencerProfile && finalInfluencerRecords.length > 0) {
      const recommendedCount = finalInfluencerRecords.filter(inf => inf.isRecommended).length;
      
      reportStep(onStepUpdate, BROWSER_STEP_IDS.ANALYZE_MATCH, STEP_STATUS.COMPLETED,
        `分析完成：${recommendedCount}/${finalInfluencerRecords.length} 个红人推荐`,
        { 
          recommended: recommendedCount, 
          total: finalInfluencerRecords.length,
          notRecommended: finalInfluencerRecords.length - recommendedCount
        }
      );
      
      sendStep('分析完成', `✅ 分析完成：${recommendedCount}/${finalInfluencerRecords.length} 个红人推荐`);
    }
    
    sendStep('完成', `✅ 成功提取${finalInfluencerRecords.length}个红人数据`);

    // 5. 如果提供了 campaignId，则将分析结果写入候选池表，供执行心跳消费
    // 注意：写入失败必须显式失败，避免“任务成功但候选池为 0”的假阳性结果。
    if (campaignId && finalInfluencerRecords.length > 0) {
      try {
        const { upsertCandidatesForCampaign, bumpSearchTaskProgress } = await import("../../db/campaign-candidates-dao.js");
        await upsertCandidatesForCampaign(campaignId, finalInfluencerRecords);
        const taskId = Number(options?.taskId || 0);
        if (taskId) {
          // 以“写入尝试数”为准（包含 INSERT IGNORE / 重复 upsert）
          await bumpSearchTaskProgress(taskId, finalInfluencerRecords.length);
        }
        sendStep('写入候选池', `✅ 已将分析结果写入候选池：campaignId=${campaignId}`);
      } catch (e) {
        const upsertErrMsg = e?.message || String(e);
        console.warn(
          "[searchAndExtractInfluencers] 写入 tiktok_campaign_influencer_candidates 失败:",
          upsertErrMsg
        );
        sendStep('写入候选池失败', `⚠️ 写入候选池失败：${upsertErrMsg}`);
        return {
          success: false,
          influencers: finalInfluencerRecords,
          videos: extractionResult.videos || [],
          error: `候选池写入失败: ${upsertErrMsg}`
        };
      }
    }
    
    // 返回结果（包含所有UI需要的字段）
    const result = {
      success: true,
      influencers: finalInfluencerRecords.map(record => {
        // 格式化粉丝量（如果是对象，提取 display；否则转换为字符串）
        let followersDisplay = '0';
        if (record.followers) {
          if (typeof record.followers === 'object' && record.followers.display) {
            followersDisplay = record.followers.display;
          } else if (typeof record.followers === 'string') {
            followersDisplay = record.followers;
          } else if (typeof record.followers === 'number') {
            followersDisplay = formatNumber(record.followers);
          }
        }
        
        // 格式化播放量（如果是对象，提取 display；否则转换为字符串）
        let viewsDisplay = '0';
        if (record.views) {
          if (typeof record.views === 'object' && record.views.display) {
            viewsDisplay = record.views.display;
          } else if (typeof record.views === 'object' && record.views.avg) {
            viewsDisplay = formatNumber(record.views.avg);
          } else if (typeof record.views === 'string') {
            viewsDisplay = record.views;
          } else if (typeof record.views === 'number') {
            viewsDisplay = formatNumber(record.views);
          }
        }
        
        return {
          // 基础字段
          id: record.username, // UI需要的 id 字段
          username: record.username,
          name: record.displayName || record.username, // UI需要的 name 字段
          displayName: record.displayName || record.username,
          profileUrl: record.profileUrl,
          platform: record.platform || 'TikTok', // UI需要的 platform 字段
          
          // 头像（UI需要的 avatar 字段）
          avatar: record.avatarUrl || '', // UI需要的 avatar 字段
          avatarUrl: record.avatarUrl || '',
          
          // 粉丝量和播放量（字符串格式，用于UI展示）
          followers: followersDisplay, // UI需要的字符串格式
          views: viewsDisplay, // UI需要的字符串格式
          
          // 推荐相关（来自分析结果）
          isRecommended: record.isRecommended !== undefined ? record.isRecommended : null, // 是否推荐（分析结果）
          reason: record.recommendationReason || record.reason || '', // 推荐理由（分析结果）
          score: record.recommendationScore || record.score || 0, // 推荐分数（分析结果）
          analysis: record.recommendationAnalysis || null, // 详细分析（分析结果）
          profileDataReady: !!record.profile_data,
          analysisReady: !!record.recommendationAnalysis,
          
          // 保留原始数据对象（用于后续处理）
          followersData: record.followers, // 保留原始对象格式
          viewsData: record.views, // 保留原始对象格式
          
          // 其他字段
          bio: record.bio || null,
          verified: record.verified || false,
          engagement: record.engagement || null,
          postsCount: record.postsCount || null
        };
      }),
      videos: extractionResult.videos,
      stats: extractionResult.stats,
      savedCount: searchSaveResult.success || 0
    };
    
    return result;
    
  } catch (error) {
    console.error('[searchAndExtractInfluencers] 错误:', error);
    sendStep('错误', `❌ 发生错误: ${error.message}`);
    return {
      success: false,
      influencers: [],
      videos: [],
      error: error.message
    };
  }
}
  // 分批并发执行
  for (let i = 0; i < recordsToEnrich.length; i += concurrency) {
    const chunk = recordsToEnrich.slice(i, i + concurrency);
    sendStep('提取主页数据', `批次 ${Math.floor(i / concurrency) + 1}：并发提取 ${chunk.length} 个红人...`);
    
    const batchResults = await Promise.all(
      chunk.map((record, j) => processOneRecord(record, i + j))
    );
    
    for (const { mergedRecord, logEntry, success } of batchResults) {
      enrichedRecords.push(mergedRecord);
      detailedLogs.push(logEntry);
      if (success) successCount++; else failedCount++;
    }
    
    // 计算已处理的红人数量
    const processedCount = Math.min(i + concurrency, recordsToEnrich.length);
    
    // 每5个红人：额外等待 10-20秒
    if (processedCount % 5 === 0 && processedCount < recordsToEnrich.length) {
      const extraDelay = 10000 + Math.floor(Math.random() * 10000); // 10-20秒随机
      sendStep('休息', `已处理 ${processedCount} 个红人，额外休息 ${(extraDelay / 1000).toFixed(1)} 秒...`);
      await new Promise(resolve => setTimeout(resolve, extraDelay));
    }
    
    // 每10个红人：休息 30-60秒
    if (processedCount % 10 === 0 && processedCount < recordsToEnrich.length) {
      const longRest = 30000 + Math.floor(Math.random() * 30000); // 30-60秒随机
      sendStep('长时间休息', `已处理 ${processedCount} 个红人，长时间休息 ${(longRest / 1000).toFixed(1)} 秒...`);
      await new Promise(resolve => setTimeout(resolve, longRest));
    }
    
    // 批间等待：当 concurrency 为 1 时，上一环节已包含“分析红人画像”的耗时，相当于自然间隔，不再额外等待
    if (i + concurrency < recordsToEnrich.length) {
      if (concurrency > 1) {
        const delayBetweenInfluencers = 3000 + Math.floor(Math.random() * 5000);
        sendStep('等待', `已处理 ${processedCount}/${recordsToEnrich.length} 个红人，等待 ${(delayBetweenInfluencers / 1000).toFixed(1)} 秒后继续下一批...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenInfluencers));
        const delay = randomDelay(delayBetweenBatches.min, delayBetweenBatches.max);
        sendStep('批间等待', `批间等待 ${(delay / 1000).toFixed(1)} 秒...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      // concurrency === 1 时跳过等待，分析完成后直接打开下一红人主页
    }
  }
  
  // 合并结果：已提取主页数据的记录 + 未提取的记录
  const finalRecords = [
    ...enrichedRecords,
    ...recordsToSkip
  ];
  
  // 保存详细日志到文件
  try {
    const logFilePath = path.join(logsDir, `profile-extraction-details-${timestamp}.json`);
    const logData = {
      summary: {
        total: recordsToEnrich.length,
        success: successCount,
        failed: failedCount,
        skipped: recordsToSkip.length,
        timestamp: new Date().toISOString()
      },
      logs: detailedLogs
    };
    fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2), 'utf-8');
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📝 详细日志已保存到: ${logFilePath}`);
    console.log(`   总计: ${recordsToEnrich.length} 个红人`);
    console.log(`   成功: ${successCount} 个`);
    console.log(`   失败: ${failedCount} 个`);
    console.log(`   跳过: ${recordsToSkip.length} 个`);
    console.log(`${'='.repeat(80)}\n`);
  } catch (e) {
    console.warn(`[enrichInfluencerProfiles] 保存详细日志失败:`, e.message);
  }
  
  sendStep('完成', `✅ 主页数据提取完成：成功 ${successCount}，失败 ${failedCount}，跳过 ${recordsToSkip.length}`);
  
  // 关闭 CDP 连接（不关闭浏览器，因为它是手动启动的）
  if (browser) {
    try {
      await browser.close();
      console.log('[enrichInfluencerProfiles] ✅ CDP 连接已断开');
    } catch (e) {
      console.warn('[enrichInfluencerProfiles] 断开 CDP 连接失败:', e.message);
    }
  }
  
  return finalRecords;
}


// ========== 主函数 ==========

/**
 * 搜索并提取红人数据
 * @param {Object} params - 参数对象
 * @param {Object} params.keywords - 关键词对象（包含 search_queries 数组）
 * @param {Array<string>} params.platforms - 平台列表（如 ['TikTok']）
 * @param {Array<string>} params.countries - 国家列表
 * @param {Object} params.productInfo - 产品信息
 * @param {Object} params.campaignInfo - Campaign信息
 * @param {Object} params.influencerProfile - 红人画像要求
 * @param {Object} options - 选项
 * @param {number} options.maxResults - 最大结果数（默认20）
 * @param {Function} options.onStepUpdate - 步骤更新回调函数
 * @returns {Promise<Object>} - { success: boolean, influencers: Array, videos: Array, error?: string }
 */
async function searchAndExtractInfluencers_v3(params = {}, options = {}) {
  const { keywords = {}, platforms = [], countries = [], campaignInfo = {} } = params;
  const { 
    maxResults = 20, 
    onStepUpdate = null,
    enrichProfileData = true,  // 是否提取主页数据（默认启用）
    maxEnrichCount = 20,       // 最多提取多少个红人的主页数据
    batchSize = 5,             // 每批处理数量
    delayBetweenBatches = 3000 // 批次间延迟（毫秒）
  } = options;
  
  const sendStep = (step, message) => {
    try {
      if (onStepUpdate) {
        onStepUpdate({ step, message });
      }
    } catch (error) {
      // 静默处理 SSE 流关闭错误
      if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
        // 静默忽略
      } else {
        console.error(`[searchAndExtractInfluencers] 发送步骤更新失败:`, error);
      }
    }
  };
  
  try {
    const searchQueries = keywords.search_queries || [];
    if (searchQueries.length === 0) {
      throw new Error('没有提供搜索关键词');
    }
    
    // 1. 搜索红人（使用 playwright + CDP + chrome，需要登录状态）
    sendStep('搜索红人', '正在搜索红人（使用 CDP 连接，需要已登录的 Chrome）...');
    const searchResult = await searchInfluencersByKeyword({ keywords, campaignInfo }, { onStepUpdate });
    const extractionResult = {
      influencerRecords: searchResult.influencerRecords,
      videos: searchResult.videos,
      stats: searchResult.stats
    };
    
    // 2. 立即保存搜索数据到数据库（包含 search_video_data）
    let searchSaveResult = { success: 0 };
    if (extractionResult.influencerRecords.length > 0) {
      sendStep('保存搜索数据', `正在将${extractionResult.influencerRecords.length}个红人的搜索数据保存到数据库...`);
      searchSaveResult = await saveTikTokInfluencers(extractionResult.influencerRecords);
      sendStep('搜索数据已保存', `✅ 成功保存${searchSaveResult.success}个红人的搜索数据（包含 search_video_data）`);
      console.log(`[searchAndExtractInfluencers] ✅ 搜索数据已保存: ${searchSaveResult.success}个红人`);
    }
    
    // 3. 批量提取主页数据（如果启用）- 使用 playwright + CDP + chrome（不需要登录状态）
    let finalInfluencerRecords = extractionResult.influencerRecords;
    if (enrichProfileData && finalInfluencerRecords.length > 0) {
      sendStep('提取主页数据', `开始提取红人主页数据（使用 CDP 连接，不需要登录状态）...`);
      const enrichEndpoint = process.env.CDP_ENDPOINT_ENRICH || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9223';
      console.log(`[searchAndExtractInfluencers] 💡 提示: 主页提取将使用独立的 Chrome 实例（端口 9223），请确保已启动：`);
      console.log(`[searchAndExtractInfluencers]    bash scripts/launch-chrome-remote-debug-enrich.sh`);
      console.log(`[searchAndExtractInfluencers]    CDP 端点: ${enrichEndpoint}`);
      finalInfluencerRecords = await enrichInfluencerProfiles(
        finalInfluencerRecords,
        {
          onStepUpdate,
          maxCount: maxEnrichCount,
          concurrency: 1, // 一次只加载一个主页，模拟人类浏览行为
          delayBetweenBatches: { min: 5000, max: 10000 }
        }
      );
    }
    
    // 注意：搜索数据已在步骤2保存，主页数据已在 enrichInfluencerProfiles 中逐条保存
    // 无需再次批量保存
    
    // 4. 分析红人是否匹配画像要求（如果提供了画像要求）
    if (params.influencerProfile && finalInfluencerRecords.length > 0) {
      sendStep('分析红人匹配度', `开始分析 ${finalInfluencerRecords.length} 个红人是否匹配画像要求...`);
      
      // 动态导入分析函数
      const analyzeModule = await import('./analyze-influencer-match.js');
      const batchAnalyzeInfluencerMatch = analyzeModule.batchAnalyzeInfluencerMatch;
      
      // 报告分析步骤开始（batchAnalyzeInfluencerMatch 内部会自己报告，这里可以省略或只做初始化）
      // reportStep(onStepUpdate, BROWSER_STEP_IDS.ANALYZE_MATCH, STEP_STATUS.RUNNING, 
      //   `正在分析 ${finalInfluencerRecords.length} 个红人是否匹配画像要求...`
      // );
      
      // 批量分析红人
      const analyzedRecords = await batchAnalyzeInfluencerMatch(
        finalInfluencerRecords,
        params.influencerProfile,
        params.productInfo || {},
        params.campaignInfo || {},
        onStepUpdate
      );
      
      finalInfluencerRecords = analyzedRecords;
      
      // 统计推荐数量
      const recommendedCount = analyzedRecords.filter(inf => inf.isRecommended).length;
      
      // 报告分析完成
      reportStep(onStepUpdate, BROWSER_STEP_IDS.ANALYZE_MATCH, STEP_STATUS.COMPLETED,
        `分析完成：${recommendedCount}/${analyzedRecords.length} 个红人推荐`,
        { recommended: recommendedCount, total: analyzedRecords.length }
      );
      
      sendStep('分析完成', `✅ 分析完成：${recommendedCount}/${analyzedRecords.length} 个红人推荐`);
    }
    
    sendStep('完成', `✅ 成功提取${finalInfluencerRecords.length}个红人数据`);
    
    // 返回结果（包含所有UI需要的字段）
    const result = {
      success: true,
      influencers: finalInfluencerRecords.map(record => {
        // 格式化粉丝量（如果是对象，提取 display；否则转换为字符串）
        let followersDisplay = '0';
        if (record.followers) {
          if (typeof record.followers === 'object' && record.followers.display) {
            followersDisplay = record.followers.display;
          } else if (typeof record.followers === 'string') {
            followersDisplay = record.followers;
          } else if (typeof record.followers === 'number') {
            followersDisplay = formatNumber(record.followers);
          }
        }
        
        // 格式化播放量（如果是对象，提取 display；否则转换为字符串）
        let viewsDisplay = '0';
        if (record.views) {
          if (typeof record.views === 'object' && record.views.display) {
            viewsDisplay = record.views.display;
          } else if (typeof record.views === 'object' && record.views.avg) {
            viewsDisplay = formatNumber(record.views.avg);
          } else if (typeof record.views === 'string') {
            viewsDisplay = record.views;
          } else if (typeof record.views === 'number') {
            viewsDisplay = formatNumber(record.views);
          }
        }
        
        return {
          // 基础字段
          id: record.username, // UI需要的 id 字段
          username: record.username,
          name: record.displayName || record.username, // UI需要的 name 字段
          displayName: record.displayName || record.username,
          profileUrl: record.profileUrl,
          platform: record.platform || 'TikTok', // UI需要的 platform 字段
          
          // 头像（UI需要的 avatar 字段）
          avatar: record.avatarUrl || '', // UI需要的 avatar 字段
          avatarUrl: record.avatarUrl || '',
          
          // 粉丝量和播放量（字符串格式，用于UI展示）
          followers: followersDisplay, // UI需要的字符串格式
          views: viewsDisplay, // UI需要的字符串格式
          
          // 推荐相关（来自分析结果）
          isRecommended: record.isRecommended !== undefined ? record.isRecommended : null, // 是否推荐（分析结果）
          reason: record.recommendationReason || record.reason || '', // 推荐理由（分析结果）
          score: record.recommendationScore || record.score || 0, // 推荐分数（分析结果）
          analysis: record.recommendationAnalysis || null, // 详细分析（分析结果）
          
          // 保留原始数据对象（用于后续处理）
          followersData: record.followers, // 保留原始对象格式
          viewsData: record.views, // 保留原始对象格式
          
          // 其他字段
          bio: record.bio || null,
          verified: record.verified || false,
          engagement: record.engagement || null,
          postsCount: record.postsCount || null
        };
      }),
      videos: extractionResult.videos,
      stats: extractionResult.stats,
      savedCount: searchSaveResult.success || 0
    };
    
    return result;
    
  } catch (error) {
    console.error('[searchAndExtractInfluencers] 错误:', error);
    sendStep('错误', `❌ 发生错误: ${error.message}`);
    return {
      success: false,
      influencers: [],
      videos: [],
      error: error.message
    };
  }
}

/**
 * 使用 extractedData 直接提取视频和红人信息（不使用 LLM）
 */
async function extractVideosAndInfluencersWithAI(page, onStepUpdate = null, campaignInfo = {}) {
  const startTime = Date.now();
  
  if (onStepUpdate) {
    onStepUpdate({ step: '等待页面加载', message: '正在等待页面加载...' });
  }
  await page.waitForTimeout(3000);
  
  if (onStepUpdate) {
    onStepUpdate({ step: '滚动页面', message: '正在滚动页面以加载更多内容（目标：至少20个红人）...' });
  }
  
  const targetVideoCount = 20; // 改为20个
  let currentVideoCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 20;
  
  function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  
  async function performScroll() {
    const useMouseWheel = Math.random() > 0.3;
    if (useMouseWheel) {
      const mouseX = randomDelay(300, 700);
      const mouseY = randomDelay(300, 600);
      await page.mouse.move(mouseX, mouseY);
      await page.waitForTimeout(randomDelay(100, 300));
      const scrollDistance = randomDelay(400, 800);
      await page.mouse.wheel(0, scrollDistance);
      if (Math.random() > 0.7) {
        await page.waitForTimeout(randomDelay(200, 500));
        await page.mouse.wheel(0, randomDelay(100, 300));
      }
    } else {
      await page.keyboard.press('PageDown');
    }
    
    await page.evaluate(() => {
      const selectors = [
        '[data-e2e="search-result-list"]',
        '[data-e2e="search_video-item-list"]',
        '[class*="SearchResult"]',
        '[class*="search-result"]',
        'main',
        '[role="main"]',
      ];
      const scrollAmount = Math.floor(window.innerHeight * (0.7 + Math.random() * 0.3));
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.scrollHeight > el.clientHeight) {
            el.scrollTop += scrollAmount;
            return;
          }
        } catch (e) {}
      }
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    });
  }
  
  while (currentVideoCount < targetVideoCount && scrollAttempts < maxScrollAttempts) {
    await performScroll();
    const waitTime = randomDelay(2000, 4000);
    await page.waitForTimeout(waitTime);
    
    currentVideoCount = await page.evaluate(() => {
      const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const uniqueVideoIds = new Set();
      videoLinks.forEach(link => {
        const href = link.getAttribute('href');
        const match = href.match(/\/video\/(\d+)/);
        if (match) uniqueVideoIds.add(match[1]);
      });
      return uniqueVideoIds.size;
    });
    
    scrollAttempts++;
    if (onStepUpdate) {
      onStepUpdate({ step: '滚动页面', message: `滚动第 ${scrollAttempts} 次，当前视频数量: ${currentVideoCount}` });
    }
    
    if (scrollAttempts > 5 && currentVideoCount === 0) break;
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
      if (afterCount === prevCount && prevCount > 0 && scrollAttempts > 15) break;
    }
  }
  
  await page.waitForTimeout(3000);
  
  if (onStepUpdate) {
    onStepUpdate({ step: '提取HTML', message: '正在提取页面HTML...' });
  }
  
  const rawHTML = await page.content();
  const rawHTMLLength = rawHTML.length;
  console.log(`[searchAndExtractInfluencers] 原始 HTML 长度: ${rawHTMLLength.toLocaleString()} 字符`);
  
  const optimizedHTML = optimizeHTML(rawHTML);
  const optimizedHTMLLength = optimizedHTML.length;
  console.log(`[searchAndExtractInfluencers] 优化后 HTML 长度: ${optimizedHTMLLength.toLocaleString()} 字符`);
  console.log(`[searchAndExtractInfluencers] HTML 减少: ${((rawHTMLLength - optimizedHTMLLength) / rawHTMLLength * 100).toFixed(1)}%`);
  
  if (onStepUpdate) {
    onStepUpdate({ step: '转换为Markdown', message: '正在将HTML转换为Markdown...' });
  }
  
  const result = htmlToCompactMarkdown(optimizedHTML);
  const markdownContent = result.markdown || result; // 兼容旧版本（如果只返回字符串）
  const extractedData = result.extractedData || { videos: [], users: [] };
  
  const markdownLength = markdownContent.length;
  console.log(`[searchAndExtractInfluencers] Markdown 长度: ${markdownLength.toLocaleString()} 字符`);
  console.log(`[searchAndExtractInfluencers] 估算 Markdown Token 数: ${Math.ceil(markdownLength / 4).toLocaleString()}`);
  
  // 保存 Markdown 到日志
  const logsDir = path.join(__dirname, '../../../logs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const markdownLogPath = path.join(logsDir, `search-markdown-${timestamp}.md`);
    fs.writeFileSync(markdownLogPath, markdownContent, 'utf-8');
    console.log(`[searchAndExtractInfluencers] Markdown 已保存到: ${markdownLogPath}`);
  } catch (e) {
    console.warn('[searchAndExtractInfluencers] 保存 Markdown 日志失败:', e.message);
  }
  
  if (onStepUpdate) {
    onStepUpdate({ step: '转换数据', message: '正在将提取的数据转换为数据库格式...' });
  }
  
  // 直接使用 htmlToCompactMarkdown 返回的 extractedData，不使用 LLM
  // extractedData 已经在 htmlToCompactMarkdown 函数中提取完成
  console.log(`[searchAndExtractInfluencers] 使用 extractedData 直接转换（不使用 LLM）`);
  console.log(`[searchAndExtractInfluencers] extractedData.videos: ${extractedData.videos.length} 个`);
  console.log(`[searchAndExtractInfluencers] extractedData.users: ${extractedData.users.length} 个`);
  
  // 保存原始 extractedData 到日志
  try {
    const extractedLogPath = path.join(logsDir, `search-extracted-data-${timestamp}.json`);
    fs.writeFileSync(extractedLogPath, JSON.stringify(extractedData, null, 2), 'utf-8');
    console.log(`[searchAndExtractInfluencers] 原始 extractedData 已保存到: ${extractedLogPath}`);
  } catch (e) {
    console.warn('[searchAndExtractInfluencers] 保存 extractedData 失败:', e.message);
  }
  
  // 转换为数据库格式
  const influencerRecords = convertExtractedDataToInfluencers(extractedData, campaignInfo);
  
  // 清理视频数据（包含新提取的字段：description、caption、hashtags、mentions等）
  const cleanedVideos = extractedData.videos.map(video => ({
    videoId: video.videoId || null,
    videoUrl: video.videoUrl || null,
    username: video.username || null,
    profileUrl: video.profileUrl || (video.username ? `https://www.tiktok.com/@${video.username}` : null),
    views: video.views || { count: 0, display: '0' },
    likes: video.likes || { count: 0, display: '0' },
    thumbnail: video.thumbnail || null,
    // 新增字段：视频描述、文案、标签、提及等
    description: video.description || null,
    caption: video.caption || null,
    hashtags: video.hashtags || null,
    mentions: video.mentions || null,
    music: video.music || null,
    creator: video.creator || null,
    postedTime: video.postedTime || null
  }));
  
  // 转换为返回格式（兼容现有代码）
  const cleanedInfluencers = influencerRecords.map(record => ({
    username: record.username,
    displayName: record.displayName,
    profileUrl: record.profileUrl,
    avatarUrl: record.avatarUrl,
    followers: record.followers,
    bio: record.bio,
    verified: record.verified,
    platform: record.platform
  }));
  
  console.log(`[searchAndExtractInfluencers] ✅ 提取完成！`);
  console.log(`[searchAndExtractInfluencers] 提取到 ${cleanedVideos.length} 个视频`);
  console.log(`[searchAndExtractInfluencers] 提取到 ${cleanedInfluencers.length} 个红人（去重后）`);
  
  // 保存最终清理后的数据到日志
  try {
    const finalData = { videos: cleanedVideos, influencers: cleanedInfluencers };
    const finalLogPath = path.join(logsDir, `search-final-data-${timestamp}.json`);
    fs.writeFileSync(finalLogPath, JSON.stringify(finalData, null, 2), 'utf-8');
    console.log(`[searchAndExtractInfluencers] 最终数据已保存到: ${finalLogPath}`);
  } catch (e) {
    console.warn('[searchAndExtractInfluencers] 保存最终数据失败:', e.message);
  }
  
  const endTime = Date.now();
  const totalTime = ((endTime - startTime) / 1000).toFixed(2);
  
  return {
    videos: cleanedVideos,
    influencers: cleanedInfluencers,
    influencerRecords: influencerRecords,  // 数据库格式的记录
    stats: {
      totalTime: totalTime,
      llmTime: '0',  // 不再使用 LLM
      videoCount: cleanedVideos.length,
      influencerCount: cleanedInfluencers.length
    }
  };
}

// ========== 主函数 ==========

/**
 * 搜索并提取红人数据
 * @param {Object} params - 参数对象
 * @param {Object} params.keywords - 关键词对象（包含 search_queries 数组）
 * @param {Array<string>} params.platforms - 平台列表（如 ['TikTok']）
 * @param {Array<string>} params.countries - 国家列表
 * @param {Object} params.productInfo - 产品信息
 * @param {Object} params.campaignInfo - Campaign信息
 * @param {Object} params.influencerProfile - 红人画像要求
 * @param {Object} options - 选项
 * @param {number} options.maxResults - 最大结果数（默认20）
 * @param {Function} options.onStepUpdate - 步骤更新回调函数
 * @returns {Promise<Object>} - { success: boolean, influencers: Array, videos: Array, error?: string }
 */
export async function searchAndExtractInfluencers(params = {}, options = {}) {
  const { keywords = {}, platforms = [], countries = [], productInfo = {}, campaignInfo = {}, influencerProfile = null, campaignId = null } = params;
  const { 
    maxResults = 20, 
    onStepUpdate = null,
    enrichProfileData = true,  // 是否提取主页数据（默认启用）
    maxEnrichCount = 20,       // 最多提取多少个红人的主页数据
    batchSize = 5,             // 每批处理数量
    delayBetweenBatches = 3000 // 批次间延迟（毫秒）
  } = options;

  console.log(`[searchAndExtractInfluencers] maxEnrichCount=${maxEnrichCount}（将提取并分析前 ${maxEnrichCount} 位红人）`);
  
  const sendStep = (step, message) => {
    try {
      if (onStepUpdate) {
        onStepUpdate({ step, message });
      }
    } catch (error) {
      // 静默处理 SSE 流关闭错误
      if (error.code === 'ERR_INVALID_STATE' || error.message?.includes('closed')) {
        // 静默忽略
      } else {
        console.error(`[searchAndExtractInfluencers] 发送步骤更新失败:`, error);
      }
    }
  };
  
  try {
    const searchQueries = keywords.search_queries || [];
    if (searchQueries.length === 0) {
      throw new Error('没有提供搜索关键词');
    }
    
    // 1. 搜索红人（使用 playwright + CDP + chrome，需要登录状态）
    sendStep('搜索红人', '正在搜索红人（使用 CDP 连接，需要已登录的 Chrome）...');
    const searchResult = await searchInfluencersByKeyword({ keywords, campaignInfo }, { onStepUpdate });
    const extractionResult = {
      influencerRecords: searchResult.influencerRecords,
      videos: searchResult.videos,
      stats: searchResult.stats
    };
    
    // 2. 立即保存搜索数据到数据库（包含 search_video_data）
    let searchSaveResult = { success: 0 };
    if (extractionResult.influencerRecords.length > 0) {
      sendStep('保存搜索数据', `正在将${extractionResult.influencerRecords.length}个红人的搜索数据保存到数据库...`);
      searchSaveResult = await saveTikTokInfluencers(extractionResult.influencerRecords);
      sendStep('搜索数据已保存', `✅ 成功保存${searchSaveResult.success}个红人的搜索数据（包含 search_video_data）`);
      console.log(`[searchAndExtractInfluencers] ✅ 搜索数据已保存: ${searchSaveResult.success}个红人`);
    }
    
    // 3. 批量提取主页数据（如果启用）- 使用 playwright + CDP + chrome（不需要登录状态）
    let finalInfluencerRecords = extractionResult.influencerRecords;
    if (enrichProfileData && finalInfluencerRecords.length > 0) {
      sendStep('提取主页数据', `开始提取红人主页数据（使用 CDP 连接，不需要登录状态）...`);
      const enrichEndpoint = process.env.CDP_ENDPOINT_ENRICH || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9223';
      console.log(`[searchAndExtractInfluencers] 💡 提示: 主页提取将使用独立的 Chrome 实例（端口 9223），请确保已启动：`);
      console.log(`[searchAndExtractInfluencers]    bash scripts/launch-chrome-remote-debug-enrich.sh`);
      console.log(`[searchAndExtractInfluencers]    CDP 端点: ${enrichEndpoint}`);
      finalInfluencerRecords = await enrichInfluencerProfiles(
        finalInfluencerRecords,
        {
          onStepUpdate,
          maxCount: maxEnrichCount,
          concurrency: 1, // 一次只加载一个主页，模拟人类浏览行为
          delayBetweenBatches: { min: 5000, max: 10000 },
          // 将画像与产品/Campaign 信息传入，用于实时匹配分析
          influencerProfile,
          productInfo,
          campaignInfo,
          enableLiveMatch: !!influencerProfile
        }
      );
    }
    
    // 注意：搜索数据已在步骤2保存，主页数据已在 enrichInfluencerProfiles 中逐条保存
    // 无需再次批量保存
    
    // 4. 分析红人是否匹配画像要求的汇总（实时分析已在 enrichInfluencerProfiles 中完成）
    if (influencerProfile && finalInfluencerRecords.length > 0) {
      const recommendedCount = finalInfluencerRecords.filter(inf => inf.isRecommended).length;
      
      reportStep(onStepUpdate, BROWSER_STEP_IDS.ANALYZE_MATCH, STEP_STATUS.COMPLETED,
        `分析完成：${recommendedCount}/${finalInfluencerRecords.length} 个红人推荐`,
        { 
          recommended: recommendedCount, 
          total: finalInfluencerRecords.length,
          notRecommended: finalInfluencerRecords.length - recommendedCount
        }
      );
      
      sendStep('分析完成', `✅ 分析完成：${recommendedCount}/${finalInfluencerRecords.length} 个红人推荐`);
    }
    
    sendStep('完成', `✅ 成功提取${finalInfluencerRecords.length}个红人数据`);

    // 5. 写入候选池：供 execution heartbeat 继续把人推进执行表
    // 写入失败时直接返回失败，避免任务显示成功但候选池为 0。
    if (campaignId && finalInfluencerRecords.length > 0) {
      // 仅将“已完成匹配分析”的红人写入候选池，避免大量未分析数据污染 candidates。
      const analyzedCandidates = finalInfluencerRecords.filter((inf) => {
        const hasRecommended = typeof inf?.isRecommended === "boolean";
        const hasScore = typeof inf?.recommendationScore === "number" || typeof inf?.score === "number";
        const hasAnalysis =
          typeof inf?.recommendationAnalysis === "string"
            ? inf.recommendationAnalysis.trim().length > 0
            : typeof inf?.analysis === "string" && inf.analysis.trim().length > 0;
        return hasRecommended || hasScore || hasAnalysis;
      });

      try {
        const { upsertCandidatesForCampaign, bumpSearchTaskProgress } = await import("../../db/campaign-candidates-dao.js");
        await upsertCandidatesForCampaign(campaignId, analyzedCandidates);
        const taskId = Number(options?.taskId || 0);
        if (taskId) {
          // 以“写入尝试数”为准（包含 INSERT IGNORE / 重复 upsert）
          await bumpSearchTaskProgress(taskId, analyzedCandidates.length);
        }
        sendStep(
          "写入候选池",
          `✅ 已将分析结果写入候选池：campaignId=${campaignId}（${analyzedCandidates.length}/${finalInfluencerRecords.length}）`
        );
      } catch (e) {
        const upsertErrMsg = e?.message || String(e);
        console.warn("[searchAndExtractInfluencers] 写入 tiktok_campaign_influencer_candidates 失败:", upsertErrMsg);
        sendStep('写入候选池失败', `⚠️ 写入候选池失败：${upsertErrMsg}`);
        return {
          success: false,
          influencers: finalInfluencerRecords,
          videos: extractionResult.videos || [],
          error: `候选池写入失败: ${upsertErrMsg}`
        };
      }
    }
    
    // 返回结果（包含所有UI需要的字段）
    const result = {
      success: true,
      influencers: finalInfluencerRecords.map(record => {
        // 格式化粉丝量（如果是对象，提取 display；否则转换为字符串）
        let followersDisplay = '0';
        if (record.followers) {
          if (typeof record.followers === 'object' && record.followers.display) {
            followersDisplay = record.followers.display;
          } else if (typeof record.followers === 'string') {
            followersDisplay = record.followers;
          } else if (typeof record.followers === 'number') {
            followersDisplay = formatNumber(record.followers);
          }
        }
        
        // 格式化播放量（如果是对象，提取 display；否则转换为字符串）
        let viewsDisplay = '0';
        if (record.views) {
          if (typeof record.views === 'object' && record.views.display) {
            viewsDisplay = record.views.display;
          } else if (typeof record.views === 'object' && record.views.avg) {
            viewsDisplay = formatNumber(record.views.avg);
          } else if (typeof record.views === 'string') {
            viewsDisplay = record.views;
          } else if (typeof record.views === 'number') {
            viewsDisplay = formatNumber(record.views);
          }
        }
        
        return {
          // 基础字段
          id: record.username, // UI需要的 id 字段
          username: record.username,
          name: record.displayName || record.username, // UI需要的 name 字段
          displayName: record.displayName || record.username,
          profileUrl: record.profileUrl,
          platform: record.platform || 'TikTok', // UI需要的 platform 字段
          
          // 头像（UI需要的 avatar 字段）
          avatar: record.avatarUrl || '', // UI需要的 avatar 字段
          avatarUrl: record.avatarUrl || '',
          
          // 粉丝量和播放量（字符串格式，用于UI展示）
          followers: followersDisplay, // UI需要的字符串格式
          views: viewsDisplay, // UI需要的字符串格式
          
          // 推荐相关（来自分析结果）
          isRecommended: record.isRecommended !== undefined ? record.isRecommended : null, // 是否推荐（分析结果）
          reason: record.recommendationReason || record.reason || '', // 推荐理由（分析结果）
          score: record.recommendationScore || record.score || 0, // 推荐分数（分析结果）
          analysis: record.recommendationAnalysis || null, // 详细分析（分析结果）
          
          // 保留原始数据对象（用于后续处理）
          followersData: record.followers, // 保留原始对象格式
          viewsData: record.views, // 保留原始对象格式
          
          // 其他字段
          bio: record.bio || null,
          verified: record.verified || false,
          engagement: record.engagement || null,
          postsCount: record.postsCount || null
        };
      }),
      videos: extractionResult.videos,
      stats: extractionResult.stats,
      savedCount: searchSaveResult.success || 0
    };
    
    return result;
    
  } catch (error) {
    console.error('[searchAndExtractInfluencers] 错误:', error);
    sendStep('错误', `❌ 发生错误: ${error.message}`);
    return {
      success: false,
      influencers: [],
      videos: [],
      error: error.message
    };
  }
}