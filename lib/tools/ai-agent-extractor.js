// AI Agent 提取器
// 当函数提取失败时，使用 AI Agent 从视频卡片中提取红人信息

import { callDeepSeekLLM } from "../utils/llm-client.js";

/**
 * 使用 AI Agent 从视频卡片中提取红人信息
 * @param {Object} card - Playwright Locator 对象，指向视频卡片元素
 * @param {string} platform - 平台名称（'TikTok' 或 'Instagram'）
 * @returns {Promise<Object>} - { success: boolean, data: Object, error?: string }
 */
export async function extractCardWithAIAgent(card, platform = 'TikTok') {
  try {
    // 1. 提取卡片的 HTML 内容和文本内容
    const cardHTML = await card.innerHTML().catch(() => '');
    const cardText = await card.textContent().catch(() => '');
    
    // 2. 提取所有链接（可能包含用户名和视频链接）
    const links = [];
    try {
      const linkElements = await card.locator('a').all();
      for (const linkEl of linkElements) {
        const href = await linkEl.getAttribute('href').catch(() => null);
        const text = await linkEl.textContent().catch(() => '');
        if (href) {
          links.push({ href, text: text.trim() });
        }
      }
    } catch (e) {
      console.warn('[AIAgentExtractor] 提取链接失败:', e.message);
    }
    
    // 3. 提取所有图片（可能包含头像和视频封面）
    const images = [];
    try {
      const imgElements = await card.locator('img').all();
      for (const imgEl of imgElements) {
        const src = await imgEl.getAttribute('src').catch(() => null);
        const alt = await imgEl.getAttribute('alt').catch(() => '');
        if (src) {
          images.push({ src, alt });
        }
      }
    } catch (e) {
      console.warn('[AIAgentExtractor] 提取图片失败:', e.message);
    }
    
    // 4. 构建 LLM Prompt
    const prompt = `你是一个专业的社交媒体数据分析专家。请从以下 TikTok 视频卡片信息中提取红人（创作者）的基本信息。

**卡片文本内容**：
${cardText.substring(0, 2000)}  // 限制长度避免 token 过多

**卡片中的链接**：
${JSON.stringify(links.slice(0, 20), null, 2)}  // 限制数量

**卡片中的图片**：
${JSON.stringify(images.slice(0, 10), null, 2)}  // 限制数量

请提取以下信息（如果存在）：
1. **username**: 用户名（从链接中提取，格式如 /@username，只返回 username 部分，不要包含 @ 符号）
2. **displayName**: 显示名称（创作者的名字）
3. **profileUrl**: 个人主页链接（完整的 URL，如 https://www.tiktok.com/@username）
4. **avatarUrl**: 头像图片 URL
5. **followers**: 粉丝数（如果有显示，格式为数字，如 1000000）
6. **bio**: 个人简介（如果有）
7. **verified**: 是否认证（true/false）

**重要提示**：
- 用户名必须从链接中提取，格式为 /@username，只返回 username 部分
- 如果找不到用户名，返回 null
- 所有字段如果找不到，返回 null 或空字符串
- 只返回 JSON 格式，不要其他文字说明

请返回 JSON 格式：
{
  "username": "用户名或null",
  "displayName": "显示名称或null",
  "profileUrl": "完整URL或null",
  "avatarUrl": "图片URL或null",
  "followers": 数字或null,
  "bio": "简介或null",
  "verified": true或false
}`;

    // 5. 调用 LLM
    console.log('[AIAgentExtractor] 开始调用 LLM 提取信息...');
    const llmResponse = await callDeepSeekLLM(
      [{ role: "user", content: prompt }],
      "你是一个专业的社交媒体数据分析专家，擅长从网页内容中提取结构化信息。只返回 JSON 格式，不要其他文字。"
    );
    
    console.log('[AIAgentExtractor] LLM 响应:', llmResponse.substring(0, 200));
    
    // 6. 解析 JSON 响应
    let extractedData;
    try {
      // 尝试直接解析
      extractedData = JSON.parse(llmResponse);
    } catch (e) {
      // 如果直接解析失败，尝试提取 JSON 部分
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('无法从 LLM 响应中提取 JSON');
      }
    }
    
    // 7. 验证和清理数据
    const result = {
      username: extractedData.username || null,
      displayName: extractedData.displayName || null,
      profileUrl: extractedData.profileUrl || null,
      avatarUrl: extractedData.avatarUrl || null,
      followers: extractedData.followers || null,
      bio: extractedData.bio || null,
      verified: extractedData.verified || false
    };
    
    // 8. 如果找到了用户名，尝试构建完整的 profileUrl
    if (result.username && !result.profileUrl) {
      if (platform === 'TikTok') {
        result.profileUrl = `https://www.tiktok.com/@${result.username}`;
      } else if (platform === 'Instagram') {
        result.profileUrl = `https://www.instagram.com/${result.username}/`;
      }
    }
    
    // 9. 验证是否至少提取到了用户名
    if (!result.username) {
      return {
        success: false,
        data: null,
        error: '未能提取到用户名'
      };
    }
    
    // 10. 格式化 followers（如果需要）
    if (result.followers && typeof result.followers === 'number') {
      result.followers = {
        count: result.followers,
        display: formatFollowersCount(result.followers)
      };
    } else if (result.followers && typeof result.followers === 'string') {
      // 如果 LLM 返回的是字符串格式（如 "1.2M"），尝试解析
      const parsed = parseFollowersString(result.followers);
      if (parsed) {
        result.followers = {
          count: parsed,
          display: result.followers
        };
      } else {
        result.followers = null;
      }
    } else {
      result.followers = null;
    }
    
    console.log('[AIAgentExtractor] ✅ 提取成功:', {
      username: result.username,
      displayName: result.displayName,
      hasProfileUrl: !!result.profileUrl,
      hasAvatarUrl: !!result.avatarUrl,
      hasFollowers: !!result.followers
    });
    
    return {
      success: true,
      data: result
    };
    
  } catch (error) {
    console.error('[AIAgentExtractor] ❌ 提取失败:', error.message);
    return {
      success: false,
      data: null,
      error: error.message
    };
  }
}

/**
 * 格式化粉丝数显示
 * @param {number} count - 粉丝数
 * @returns {string} 格式化后的字符串
 */
function formatFollowersCount(count) {
  if (count >= 1000000) {
    return (count / 1000000).toFixed(1) + 'M';
  } else if (count >= 1000) {
    return (count / 1000).toFixed(1) + 'K';
  }
  return count.toString();
}

/**
 * 解析粉丝数字符串（如 "1.2M", "500K"）
 * @param {string} str - 粉丝数字符串
 * @returns {number|null} 解析后的数字
 */
function parseFollowersString(str) {
  if (!str) return null;
  
  const cleaned = str.trim().toUpperCase();
  const match = cleaned.match(/([\d.]+)([KM])?/);
  
  if (!match) return null;
  
  const num = parseFloat(match[1]);
  const unit = match[2];
  
  if (unit === 'M') {
    return Math.round(num * 1000000);
  } else if (unit === 'K') {
    return Math.round(num * 1000);
  }
  
  return Math.round(num);
}

