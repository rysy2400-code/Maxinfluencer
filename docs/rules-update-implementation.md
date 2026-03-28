# 规则自动更新实现方案

## 📋 需求确认

1. ✅ **阈值**：至少 10 个红人用户名（去重后）
2. ✅ **环境**：所有环境（开发/测试/生产）统一阈值
3. ✅ **重试机制**：未达到阈值时，重新尝试更新规则，最多 3 次
4. ✅ **失败处理**：3 次都失败则继续使用旧规则

---

## 🏗️ 架构设计

### 1. 核心流程

```
提取数据 → 检测去重后的用户名数量 < 10？ → 触发更新
    ↓
需要更新 → 重试循环（最多 3 次）
    ├─ 第 1 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 2 秒
    ├─ 第 2 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 4 秒
    └─ 第 3 次：LLM 生成规则 → 验证
        ├─ 成功 → 应用新规则 ✅
        └─ 失败 → 继续使用旧规则 ⚠️
```

---

## 💻 实现代码

### 1. 验证阈值配置

```javascript
// lib/html-extraction/validation-config.js

export const VALIDATION_THRESHOLDS = {
  // 数量指标
  videoCount: {
    minimum: parseInt(process.env.RULES_MIN_VIDEO_COUNT || '45'),
    target: parseInt(process.env.RULES_TARGET_VIDEO_COUNT || '50'),
    warning: parseInt(process.env.RULES_WARNING_VIDEO_COUNT || '48')
  },
  
  usernameCount: {
    minimum: parseInt(process.env.RULES_MIN_USERNAME_COUNT || '10'),  // ⭐ 用户要求：至少 10 个
    target: parseInt(process.env.RULES_TARGET_USERNAME_COUNT || '15'),
    warning: parseInt(process.env.RULES_WARNING_USERNAME_COUNT || '12')
  },
  
  // 字段完整度
  videoFields: {
    videoId: parseFloat(process.env.RULES_VIDEO_ID_RATE || '0.98'),
    videoUrl: parseFloat(process.env.RULES_VIDEO_URL_RATE || '0.98'),
    username: parseFloat(process.env.RULES_VIDEO_USERNAME_RATE || '0.95'),
    description: parseFloat(process.env.RULES_VIDEO_DESCRIPTION_RATE || '0.80'),
    thumbnail: parseFloat(process.env.RULES_VIDEO_THUMBNAIL_RATE || '0.70')
  },
  
  userFields: {
    username: parseFloat(process.env.RULES_USER_USERNAME_RATE || '0.95'),
    profileUrl: parseFloat(process.env.RULES_USER_PROFILE_URL_RATE || '0.95')
  },
  
  // 数据质量
  dataQuality: {
    maxUrlErrorRate: parseFloat(process.env.RULES_MAX_URL_ERROR_RATE || '0.05'),
    maxUsernameErrorRate: parseFloat(process.env.RULES_MAX_USERNAME_ERROR_RATE || '0.05')
  }
};

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

---

### 2. 验证函数

```javascript
// lib/html-extraction/rule-validator.js

import { VALIDATION_THRESHOLDS } from './validation-config.js';

export function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VALIDATION_THRESHOLDS.videoCount.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VALIDATION_THRESHOLDS.videoCount.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => {
    if (v.username) {
      uniqueUsernames.add(v.username);
    }
  });
  newResult.users.forEach(u => {
    if (u.username) {
      uniqueUsernames.add(u.username);
    }
  });
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < VALIDATION_THRESHOLDS.usernameCount.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${VALIDATION_THRESHOLDS.usernameCount.minimum}`,
      metrics: { usernameCount, videoCount }
    };
  }
  
  // 4. 字段完整度验证
  const videoFieldValidation = validateVideoFields(newResult.videos);
  if (!videoFieldValidation.ok) {
    return videoFieldValidation;
  }
  
  const userFieldValidation = validateUserFields(newResult.users);
  if (!userFieldValidation.ok) {
    return userFieldValidation;
  }
  
  // 5. 数据质量验证
  const urlValidation = validateUrls(newResult);
  if (!urlValidation.ok) {
    return urlValidation;
  }
  
  const usernameValidation = validateUsernames(newResult);
  if (!usernameValidation.ok) {
    return usernameValidation;
  }
  
  // 6. 综合指标计算
  const metrics = {
    videoCount,
    usernameCount,
    videoIdRate: newResult.videos.filter(v => v.videoId).length / videoCount,
    videoUrlRate: newResult.videos.filter(v => v.videoUrl).length / videoCount,
    usernameRate: newResult.videos.filter(v => v.username).length / videoCount,
    descriptionRate: newResult.videos.filter(v => v.description).length / videoCount,
    thumbnailRate: newResult.videos.filter(v => v.thumbnail).length / videoCount,
  };
  
  return { ok: true, metrics };
}

function validateVideoFields(videos) {
  const videoCount = videos.length;
  if (videoCount === 0) {
    return { ok: false, reason: '没有提取到任何视频' };
  }
  
  const videoIdRate = videos.filter(v => v.videoId).length / videoCount;
  const videoUrlRate = videos.filter(v => v.videoUrl).length / videoCount;
  const usernameRate = videos.filter(v => v.username).length / videoCount;
  
  if (videoIdRate < VALIDATION_THRESHOLDS.videoFields.videoId) {
    return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VALIDATION_THRESHOLDS.videoFields.videoId}` };
  }
  
  if (videoUrlRate < VALIDATION_THRESHOLDS.videoFields.videoUrl) {
    return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VALIDATION_THRESHOLDS.videoFields.videoUrl}` };
  }
  
  if (usernameRate < VALIDATION_THRESHOLDS.videoFields.username) {
    return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.videoFields.username}` };
  }
  
  return { ok: true };
}

function validateUserFields(users) {
  const userCount = users.length;
  if (userCount === 0) {
    return { ok: false, reason: '没有提取到任何用户' };
  }
  
  const usernameRate = users.filter(u => u.username).length / userCount;
  const profileUrlRate = users.filter(u => u.profileUrl).length / userCount;
  
  if (usernameRate < VALIDATION_THRESHOLDS.userFields.username) {
    return { ok: false, reason: `用户 username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.userFields.username}` };
  }
  
  if (profileUrlRate < VALIDATION_THRESHOLDS.userFields.profileUrl) {
    return { ok: false, reason: `用户 profileUrl 完整度不足: ${profileUrlRate} < ${VALIDATION_THRESHOLDS.userFields.profileUrl}` };
  }
  
  return { ok: true };
}

function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / Math.max(1, extractedData.videos.length);
  const profileUrlErrorRate = invalidProfileUrls / Math.max(1, extractedData.users.length);
  
  if (videoUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}

function validateUsernames(extractedData) {
  const usernamePattern = /^@?[a-zA-Z0-9._]+$/;
  
  const invalidUsernames = [];
  
  extractedData.videos.forEach(v => {
    if (v.username && !usernamePattern.test(v.username)) {
      invalidUsernames.push(v.username);
    }
  });
  
  extractedData.users.forEach(u => {
    if (u.username && !usernamePattern.test(u.username)) {
      invalidUsernames.push(u.username);
    }
  });
  
  const totalUsernames = extractedData.videos.filter(v => v.username).length + 
                         extractedData.users.filter(u => u.username).length;
  const errorRate = invalidUsernames.length / Math.max(1, totalUsernames);
  
  if (errorRate > VALIDATION_THRESHOLDS.dataQuality.maxUsernameErrorRate) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

### 3. 重试机制实现

```javascript
// lib/html-extraction/rules-updater.js

import { validateRules } from './rule-validator.js';
import { RETRY_CONFIG } from './validation-config.js';
import { generateRulesFromHTML } from './rule-generator.js';
import { saveRules, loadRules } from './rules-manager.js';
import { auditRuleChange } from './rules-audit.js';

export async function updateRulesWithRetry(html, extractionResult, expectedVideoCount = 50) {
  const maxRetries = RETRY_CONFIG.maxRetries;
  const baseDelay = RETRY_CONFIG.retryDelay;
  let lastError = null;
  const currentRules = loadRules();
  
  console.log(`[规则更新] 开始更新规则，最多重试 ${maxRetries} 次...`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      console.log(`[规则更新] 调用 LLM 生成新规则...`);
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      console.log(`[规则更新] 验证新规则...`);
      const validationResult = validateRules(html, newRules, extractionResult, expectedVideoCount);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功！`);
        console.log(`[规则更新] 指标:`, validationResult.metrics);
        
        // 保存规则
        saveRules(newRules);
        
        // 记录审计日志
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { 
          success: true, 
          rules: newRules, 
          attempt,
          metrics: validationResult.metrics
        };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        console.warn(`[规则更新] 指标:`, validationResult.metrics || {});
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
          const waitTime = baseDelay * attempt; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        const waitTime = baseDelay * attempt;
        console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3 次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  // 记录失败日志
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
    currentRuleVersion: currentRules.version,
  });
  
  // 发送告警（可选）
  // sendAlert('规则更新失败', { attempts: maxRetries, lastError: lastError?.reason });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true,  // 继续使用旧规则
    currentRules: currentRules
  };
}
```

---

### 4. 主流程集成

```javascript
// scripts/tiktok-login.js (集成点)

import { updateRulesWithRetry } from '../lib/html-extraction/rules-updater.js';
import { shouldTriggerRuleUpdate } from '../lib/html-extraction/rules-trigger.js';

// 在提取数据后
async function extractVideosAndInfluencersWithAI(page) {
  // ... 现有代码 ...
  
  // 提取数据
  const extractionResult = {
    videos: extractedVideos,
    users: extractedUsers
  };
  
  // 检测是否需要更新规则（去重后的用户名数量 < 10）
  if (shouldTriggerRuleUpdate(extractionResult)) {
    console.log('[规则更新] 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    // 获取 HTML（用于 LLM 学习）
    const html = await page.content();
    const optimizedHTML = optimizeHTML(html);
    
    // 尝试更新规则（最多 3 次）
    const updateResult = await updateRulesWithRetry(
      optimizedHTML, 
      extractionResult, 
      expectedVideoCount
    );
    
    if (updateResult.success) {
      console.log('[规则更新] ✅ 规则更新成功，使用新规则重新提取...');
      // 可选：用新规则重新提取一次
      // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
    } else {
      console.log('[规则更新] ⚠️ 规则更新失败，继续使用旧规则');
      // 继续使用当前提取结果
    }
  }
  
  // ... 继续后续流程 ...
}
```

---

## 📊 配置示例

### 环境变量配置

```bash
# .env (所有环境统一)
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 至少 10 个红人用户名
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_RETRY_DELAY=2000       # 基础延迟 2 秒
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## ✅ 总结

### 核心特性

1. ✅ **触发条件**：去重后的用户名数量 < 10
2. ✅ **阈值**：至少 10 个红人用户名（去重后）
3. ✅ **环境**：所有环境统一阈值
4. ✅ **重试**：最多 3 次，递增延迟（2s, 4s, 6s）
5. ✅ **失败处理**：继续使用旧规则，不中断任务
6. ✅ **审计日志**：记录所有更新尝试和结果

### 验证指标

- ✅ 视频数量 ≥ 45 个
- ✅ 红人用户名数量 ≥ 10 个 ⭐
- ✅ videoId 完整度 ≥ 98%
- ✅ videoUrl 完整度 ≥ 98%
- ✅ username 完整度 ≥ 95%
- ✅ URL 错误率 ≤ 5%

### 重试流程

```
第 1 次尝试 → 失败 → 等待 2 秒
第 2 次尝试 → 失败 → 等待 4 秒
第 3 次尝试 → 失败 → 继续使用旧规则
```
## 📋 需求确认

1. ✅ **阈值**：至少 10 个红人用户名（去重后）
2. ✅ **环境**：所有环境（开发/测试/生产）统一阈值
3. ✅ **重试机制**：未达到阈值时，重新尝试更新规则，最多 3 次
4. ✅ **失败处理**：3 次都失败则继续使用旧规则

---

## 🏗️ 架构设计

### 1. 核心流程

```
提取数据 → 检测去重后的用户名数量 < 10？ → 触发更新
    ↓
需要更新 → 重试循环（最多 3 次）
    ├─ 第 1 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 2 秒
    ├─ 第 2 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 4 秒
    └─ 第 3 次：LLM 生成规则 → 验证
        ├─ 成功 → 应用新规则 ✅
        └─ 失败 → 继续使用旧规则 ⚠️
```

---

## 💻 实现代码

### 1. 验证阈值配置

```javascript
// lib/html-extraction/validation-config.js

export const VALIDATION_THRESHOLDS = {
  // 数量指标
  videoCount: {
    minimum: parseInt(process.env.RULES_MIN_VIDEO_COUNT || '45'),
    target: parseInt(process.env.RULES_TARGET_VIDEO_COUNT || '50'),
    warning: parseInt(process.env.RULES_WARNING_VIDEO_COUNT || '48')
  },
  
  usernameCount: {
    minimum: parseInt(process.env.RULES_MIN_USERNAME_COUNT || '10'),  // ⭐ 用户要求：至少 10 个
    target: parseInt(process.env.RULES_TARGET_USERNAME_COUNT || '15'),
    warning: parseInt(process.env.RULES_WARNING_USERNAME_COUNT || '12')
  },
  
  // 字段完整度
  videoFields: {
    videoId: parseFloat(process.env.RULES_VIDEO_ID_RATE || '0.98'),
    videoUrl: parseFloat(process.env.RULES_VIDEO_URL_RATE || '0.98'),
    username: parseFloat(process.env.RULES_VIDEO_USERNAME_RATE || '0.95'),
    description: parseFloat(process.env.RULES_VIDEO_DESCRIPTION_RATE || '0.80'),
    thumbnail: parseFloat(process.env.RULES_VIDEO_THUMBNAIL_RATE || '0.70')
  },
  
  userFields: {
    username: parseFloat(process.env.RULES_USER_USERNAME_RATE || '0.95'),
    profileUrl: parseFloat(process.env.RULES_USER_PROFILE_URL_RATE || '0.95')
  },
  
  // 数据质量
  dataQuality: {
    maxUrlErrorRate: parseFloat(process.env.RULES_MAX_URL_ERROR_RATE || '0.05'),
    maxUsernameErrorRate: parseFloat(process.env.RULES_MAX_USERNAME_ERROR_RATE || '0.05')
  }
};

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

---

### 2. 验证函数

```javascript
// lib/html-extraction/rule-validator.js

import { VALIDATION_THRESHOLDS } from './validation-config.js';

export function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VALIDATION_THRESHOLDS.videoCount.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VALIDATION_THRESHOLDS.videoCount.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => {
    if (v.username) {
      uniqueUsernames.add(v.username);
    }
  });
  newResult.users.forEach(u => {
    if (u.username) {
      uniqueUsernames.add(u.username);
    }
  });
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < VALIDATION_THRESHOLDS.usernameCount.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${VALIDATION_THRESHOLDS.usernameCount.minimum}`,
      metrics: { usernameCount, videoCount }
    };
  }
  
  // 4. 字段完整度验证
  const videoFieldValidation = validateVideoFields(newResult.videos);
  if (!videoFieldValidation.ok) {
    return videoFieldValidation;
  }
  
  const userFieldValidation = validateUserFields(newResult.users);
  if (!userFieldValidation.ok) {
    return userFieldValidation;
  }
  
  // 5. 数据质量验证
  const urlValidation = validateUrls(newResult);
  if (!urlValidation.ok) {
    return urlValidation;
  }
  
  const usernameValidation = validateUsernames(newResult);
  if (!usernameValidation.ok) {
    return usernameValidation;
  }
  
  // 6. 综合指标计算
  const metrics = {
    videoCount,
    usernameCount,
    videoIdRate: newResult.videos.filter(v => v.videoId).length / videoCount,
    videoUrlRate: newResult.videos.filter(v => v.videoUrl).length / videoCount,
    usernameRate: newResult.videos.filter(v => v.username).length / videoCount,
    descriptionRate: newResult.videos.filter(v => v.description).length / videoCount,
    thumbnailRate: newResult.videos.filter(v => v.thumbnail).length / videoCount,
  };
  
  return { ok: true, metrics };
}

function validateVideoFields(videos) {
  const videoCount = videos.length;
  if (videoCount === 0) {
    return { ok: false, reason: '没有提取到任何视频' };
  }
  
  const videoIdRate = videos.filter(v => v.videoId).length / videoCount;
  const videoUrlRate = videos.filter(v => v.videoUrl).length / videoCount;
  const usernameRate = videos.filter(v => v.username).length / videoCount;
  
  if (videoIdRate < VALIDATION_THRESHOLDS.videoFields.videoId) {
    return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VALIDATION_THRESHOLDS.videoFields.videoId}` };
  }
  
  if (videoUrlRate < VALIDATION_THRESHOLDS.videoFields.videoUrl) {
    return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VALIDATION_THRESHOLDS.videoFields.videoUrl}` };
  }
  
  if (usernameRate < VALIDATION_THRESHOLDS.videoFields.username) {
    return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.videoFields.username}` };
  }
  
  return { ok: true };
}

function validateUserFields(users) {
  const userCount = users.length;
  if (userCount === 0) {
    return { ok: false, reason: '没有提取到任何用户' };
  }
  
  const usernameRate = users.filter(u => u.username).length / userCount;
  const profileUrlRate = users.filter(u => u.profileUrl).length / userCount;
  
  if (usernameRate < VALIDATION_THRESHOLDS.userFields.username) {
    return { ok: false, reason: `用户 username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.userFields.username}` };
  }
  
  if (profileUrlRate < VALIDATION_THRESHOLDS.userFields.profileUrl) {
    return { ok: false, reason: `用户 profileUrl 完整度不足: ${profileUrlRate} < ${VALIDATION_THRESHOLDS.userFields.profileUrl}` };
  }
  
  return { ok: true };
}

function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / Math.max(1, extractedData.videos.length);
  const profileUrlErrorRate = invalidProfileUrls / Math.max(1, extractedData.users.length);
  
  if (videoUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}

function validateUsernames(extractedData) {
  const usernamePattern = /^@?[a-zA-Z0-9._]+$/;
  
  const invalidUsernames = [];
  
  extractedData.videos.forEach(v => {
    if (v.username && !usernamePattern.test(v.username)) {
      invalidUsernames.push(v.username);
    }
  });
  
  extractedData.users.forEach(u => {
    if (u.username && !usernamePattern.test(u.username)) {
      invalidUsernames.push(u.username);
    }
  });
  
  const totalUsernames = extractedData.videos.filter(v => v.username).length + 
                         extractedData.users.filter(u => u.username).length;
  const errorRate = invalidUsernames.length / Math.max(1, totalUsernames);
  
  if (errorRate > VALIDATION_THRESHOLDS.dataQuality.maxUsernameErrorRate) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

### 3. 重试机制实现

```javascript
// lib/html-extraction/rules-updater.js

import { validateRules } from './rule-validator.js';
import { RETRY_CONFIG } from './validation-config.js';
import { generateRulesFromHTML } from './rule-generator.js';
import { saveRules, loadRules } from './rules-manager.js';
import { auditRuleChange } from './rules-audit.js';

export async function updateRulesWithRetry(html, extractionResult, expectedVideoCount = 50) {
  const maxRetries = RETRY_CONFIG.maxRetries;
  const baseDelay = RETRY_CONFIG.retryDelay;
  let lastError = null;
  const currentRules = loadRules();
  
  console.log(`[规则更新] 开始更新规则，最多重试 ${maxRetries} 次...`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      console.log(`[规则更新] 调用 LLM 生成新规则...`);
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      console.log(`[规则更新] 验证新规则...`);
      const validationResult = validateRules(html, newRules, extractionResult, expectedVideoCount);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功！`);
        console.log(`[规则更新] 指标:`, validationResult.metrics);
        
        // 保存规则
        saveRules(newRules);
        
        // 记录审计日志
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { 
          success: true, 
          rules: newRules, 
          attempt,
          metrics: validationResult.metrics
        };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        console.warn(`[规则更新] 指标:`, validationResult.metrics || {});
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
          const waitTime = baseDelay * attempt; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        const waitTime = baseDelay * attempt;
        console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3 次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  // 记录失败日志
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
    currentRuleVersion: currentRules.version,
  });
  
  // 发送告警（可选）
  // sendAlert('规则更新失败', { attempts: maxRetries, lastError: lastError?.reason });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true,  // 继续使用旧规则
    currentRules: currentRules
  };
}
```

---

### 4. 主流程集成

```javascript
// scripts/tiktok-login.js (集成点)

import { updateRulesWithRetry } from '../lib/html-extraction/rules-updater.js';
import { shouldTriggerRuleUpdate } from '../lib/html-extraction/rules-trigger.js';

// 在提取数据后
async function extractVideosAndInfluencersWithAI(page) {
  // ... 现有代码 ...
  
  // 提取数据
  const extractionResult = {
    videos: extractedVideos,
    users: extractedUsers
  };
  
  // 检测是否需要更新规则（去重后的用户名数量 < 10）
  if (shouldTriggerRuleUpdate(extractionResult)) {
    console.log('[规则更新] 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    // 获取 HTML（用于 LLM 学习）
    const html = await page.content();
    const optimizedHTML = optimizeHTML(html);
    
    // 尝试更新规则（最多 3 次）
    const updateResult = await updateRulesWithRetry(
      optimizedHTML, 
      extractionResult, 
      expectedVideoCount
    );
    
    if (updateResult.success) {
      console.log('[规则更新] ✅ 规则更新成功，使用新规则重新提取...');
      // 可选：用新规则重新提取一次
      // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
    } else {
      console.log('[规则更新] ⚠️ 规则更新失败，继续使用旧规则');
      // 继续使用当前提取结果
    }
  }
  
  // ... 继续后续流程 ...
}
```

---

## 📊 配置示例

### 环境变量配置

```bash
# .env (所有环境统一)
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 至少 10 个红人用户名
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_RETRY_DELAY=2000       # 基础延迟 2 秒
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## ✅ 总结

### 核心特性

1. ✅ **触发条件**：去重后的用户名数量 < 10
2. ✅ **阈值**：至少 10 个红人用户名（去重后）
3. ✅ **环境**：所有环境统一阈值
4. ✅ **重试**：最多 3 次，递增延迟（2s, 4s, 6s）
5. ✅ **失败处理**：继续使用旧规则，不中断任务
6. ✅ **审计日志**：记录所有更新尝试和结果

### 验证指标

- ✅ 视频数量 ≥ 45 个
- ✅ 红人用户名数量 ≥ 10 个 ⭐
- ✅ videoId 完整度 ≥ 98%
- ✅ videoUrl 完整度 ≥ 98%
- ✅ username 完整度 ≥ 95%
- ✅ URL 错误率 ≤ 5%

### 重试流程

```
第 1 次尝试 → 失败 → 等待 2 秒
第 2 次尝试 → 失败 → 等待 4 秒
第 3 次尝试 → 失败 → 继续使用旧规则
```
## 📋 需求确认

1. ✅ **阈值**：至少 10 个红人用户名（去重后）
2. ✅ **环境**：所有环境（开发/测试/生产）统一阈值
3. ✅ **重试机制**：未达到阈值时，重新尝试更新规则，最多 3 次
4. ✅ **失败处理**：3 次都失败则继续使用旧规则

---

## 🏗️ 架构设计

### 1. 核心流程

```
提取数据 → 检测去重后的用户名数量 < 10？ → 触发更新
    ↓
需要更新 → 重试循环（最多 3 次）
    ├─ 第 1 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 2 秒
    ├─ 第 2 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 4 秒
    └─ 第 3 次：LLM 生成规则 → 验证
        ├─ 成功 → 应用新规则 ✅
        └─ 失败 → 继续使用旧规则 ⚠️
```

---

## 💻 实现代码

### 1. 验证阈值配置

```javascript
// lib/html-extraction/validation-config.js

export const VALIDATION_THRESHOLDS = {
  // 数量指标
  videoCount: {
    minimum: parseInt(process.env.RULES_MIN_VIDEO_COUNT || '45'),
    target: parseInt(process.env.RULES_TARGET_VIDEO_COUNT || '50'),
    warning: parseInt(process.env.RULES_WARNING_VIDEO_COUNT || '48')
  },
  
  usernameCount: {
    minimum: parseInt(process.env.RULES_MIN_USERNAME_COUNT || '10'),  // ⭐ 用户要求：至少 10 个
    target: parseInt(process.env.RULES_TARGET_USERNAME_COUNT || '15'),
    warning: parseInt(process.env.RULES_WARNING_USERNAME_COUNT || '12')
  },
  
  // 字段完整度
  videoFields: {
    videoId: parseFloat(process.env.RULES_VIDEO_ID_RATE || '0.98'),
    videoUrl: parseFloat(process.env.RULES_VIDEO_URL_RATE || '0.98'),
    username: parseFloat(process.env.RULES_VIDEO_USERNAME_RATE || '0.95'),
    description: parseFloat(process.env.RULES_VIDEO_DESCRIPTION_RATE || '0.80'),
    thumbnail: parseFloat(process.env.RULES_VIDEO_THUMBNAIL_RATE || '0.70')
  },
  
  userFields: {
    username: parseFloat(process.env.RULES_USER_USERNAME_RATE || '0.95'),
    profileUrl: parseFloat(process.env.RULES_USER_PROFILE_URL_RATE || '0.95')
  },
  
  // 数据质量
  dataQuality: {
    maxUrlErrorRate: parseFloat(process.env.RULES_MAX_URL_ERROR_RATE || '0.05'),
    maxUsernameErrorRate: parseFloat(process.env.RULES_MAX_USERNAME_ERROR_RATE || '0.05')
  }
};

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

---

### 2. 验证函数

```javascript
// lib/html-extraction/rule-validator.js

import { VALIDATION_THRESHOLDS } from './validation-config.js';

export function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VALIDATION_THRESHOLDS.videoCount.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VALIDATION_THRESHOLDS.videoCount.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => {
    if (v.username) {
      uniqueUsernames.add(v.username);
    }
  });
  newResult.users.forEach(u => {
    if (u.username) {
      uniqueUsernames.add(u.username);
    }
  });
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < VALIDATION_THRESHOLDS.usernameCount.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${VALIDATION_THRESHOLDS.usernameCount.minimum}`,
      metrics: { usernameCount, videoCount }
    };
  }
  
  // 4. 字段完整度验证
  const videoFieldValidation = validateVideoFields(newResult.videos);
  if (!videoFieldValidation.ok) {
    return videoFieldValidation;
  }
  
  const userFieldValidation = validateUserFields(newResult.users);
  if (!userFieldValidation.ok) {
    return userFieldValidation;
  }
  
  // 5. 数据质量验证
  const urlValidation = validateUrls(newResult);
  if (!urlValidation.ok) {
    return urlValidation;
  }
  
  const usernameValidation = validateUsernames(newResult);
  if (!usernameValidation.ok) {
    return usernameValidation;
  }
  
  // 6. 综合指标计算
  const metrics = {
    videoCount,
    usernameCount,
    videoIdRate: newResult.videos.filter(v => v.videoId).length / videoCount,
    videoUrlRate: newResult.videos.filter(v => v.videoUrl).length / videoCount,
    usernameRate: newResult.videos.filter(v => v.username).length / videoCount,
    descriptionRate: newResult.videos.filter(v => v.description).length / videoCount,
    thumbnailRate: newResult.videos.filter(v => v.thumbnail).length / videoCount,
  };
  
  return { ok: true, metrics };
}

function validateVideoFields(videos) {
  const videoCount = videos.length;
  if (videoCount === 0) {
    return { ok: false, reason: '没有提取到任何视频' };
  }
  
  const videoIdRate = videos.filter(v => v.videoId).length / videoCount;
  const videoUrlRate = videos.filter(v => v.videoUrl).length / videoCount;
  const usernameRate = videos.filter(v => v.username).length / videoCount;
  
  if (videoIdRate < VALIDATION_THRESHOLDS.videoFields.videoId) {
    return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VALIDATION_THRESHOLDS.videoFields.videoId}` };
  }
  
  if (videoUrlRate < VALIDATION_THRESHOLDS.videoFields.videoUrl) {
    return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VALIDATION_THRESHOLDS.videoFields.videoUrl}` };
  }
  
  if (usernameRate < VALIDATION_THRESHOLDS.videoFields.username) {
    return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.videoFields.username}` };
  }
  
  return { ok: true };
}

function validateUserFields(users) {
  const userCount = users.length;
  if (userCount === 0) {
    return { ok: false, reason: '没有提取到任何用户' };
  }
  
  const usernameRate = users.filter(u => u.username).length / userCount;
  const profileUrlRate = users.filter(u => u.profileUrl).length / userCount;
  
  if (usernameRate < VALIDATION_THRESHOLDS.userFields.username) {
    return { ok: false, reason: `用户 username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.userFields.username}` };
  }
  
  if (profileUrlRate < VALIDATION_THRESHOLDS.userFields.profileUrl) {
    return { ok: false, reason: `用户 profileUrl 完整度不足: ${profileUrlRate} < ${VALIDATION_THRESHOLDS.userFields.profileUrl}` };
  }
  
  return { ok: true };
}

function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / Math.max(1, extractedData.videos.length);
  const profileUrlErrorRate = invalidProfileUrls / Math.max(1, extractedData.users.length);
  
  if (videoUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}

function validateUsernames(extractedData) {
  const usernamePattern = /^@?[a-zA-Z0-9._]+$/;
  
  const invalidUsernames = [];
  
  extractedData.videos.forEach(v => {
    if (v.username && !usernamePattern.test(v.username)) {
      invalidUsernames.push(v.username);
    }
  });
  
  extractedData.users.forEach(u => {
    if (u.username && !usernamePattern.test(u.username)) {
      invalidUsernames.push(u.username);
    }
  });
  
  const totalUsernames = extractedData.videos.filter(v => v.username).length + 
                         extractedData.users.filter(u => u.username).length;
  const errorRate = invalidUsernames.length / Math.max(1, totalUsernames);
  
  if (errorRate > VALIDATION_THRESHOLDS.dataQuality.maxUsernameErrorRate) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

### 3. 重试机制实现

```javascript
// lib/html-extraction/rules-updater.js

import { validateRules } from './rule-validator.js';
import { RETRY_CONFIG } from './validation-config.js';
import { generateRulesFromHTML } from './rule-generator.js';
import { saveRules, loadRules } from './rules-manager.js';
import { auditRuleChange } from './rules-audit.js';

export async function updateRulesWithRetry(html, extractionResult, expectedVideoCount = 50) {
  const maxRetries = RETRY_CONFIG.maxRetries;
  const baseDelay = RETRY_CONFIG.retryDelay;
  let lastError = null;
  const currentRules = loadRules();
  
  console.log(`[规则更新] 开始更新规则，最多重试 ${maxRetries} 次...`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      console.log(`[规则更新] 调用 LLM 生成新规则...`);
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      console.log(`[规则更新] 验证新规则...`);
      const validationResult = validateRules(html, newRules, extractionResult, expectedVideoCount);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功！`);
        console.log(`[规则更新] 指标:`, validationResult.metrics);
        
        // 保存规则
        saveRules(newRules);
        
        // 记录审计日志
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { 
          success: true, 
          rules: newRules, 
          attempt,
          metrics: validationResult.metrics
        };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        console.warn(`[规则更新] 指标:`, validationResult.metrics || {});
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
          const waitTime = baseDelay * attempt; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        const waitTime = baseDelay * attempt;
        console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3 次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  // 记录失败日志
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
    currentRuleVersion: currentRules.version,
  });
  
  // 发送告警（可选）
  // sendAlert('规则更新失败', { attempts: maxRetries, lastError: lastError?.reason });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true,  // 继续使用旧规则
    currentRules: currentRules
  };
}
```

---

### 4. 主流程集成

```javascript
// scripts/tiktok-login.js (集成点)

import { updateRulesWithRetry } from '../lib/html-extraction/rules-updater.js';
import { shouldTriggerRuleUpdate } from '../lib/html-extraction/rules-trigger.js';

// 在提取数据后
async function extractVideosAndInfluencersWithAI(page) {
  // ... 现有代码 ...
  
  // 提取数据
  const extractionResult = {
    videos: extractedVideos,
    users: extractedUsers
  };
  
  // 检测是否需要更新规则（去重后的用户名数量 < 10）
  if (shouldTriggerRuleUpdate(extractionResult)) {
    console.log('[规则更新] 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    // 获取 HTML（用于 LLM 学习）
    const html = await page.content();
    const optimizedHTML = optimizeHTML(html);
    
    // 尝试更新规则（最多 3 次）
    const updateResult = await updateRulesWithRetry(
      optimizedHTML, 
      extractionResult, 
      expectedVideoCount
    );
    
    if (updateResult.success) {
      console.log('[规则更新] ✅ 规则更新成功，使用新规则重新提取...');
      // 可选：用新规则重新提取一次
      // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
    } else {
      console.log('[规则更新] ⚠️ 规则更新失败，继续使用旧规则');
      // 继续使用当前提取结果
    }
  }
  
  // ... 继续后续流程 ...
}
```

---

## 📊 配置示例

### 环境变量配置

```bash
# .env (所有环境统一)
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 至少 10 个红人用户名
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_RETRY_DELAY=2000       # 基础延迟 2 秒
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## ✅ 总结

### 核心特性

1. ✅ **触发条件**：去重后的用户名数量 < 10
2. ✅ **阈值**：至少 10 个红人用户名（去重后）
3. ✅ **环境**：所有环境统一阈值
4. ✅ **重试**：最多 3 次，递增延迟（2s, 4s, 6s）
5. ✅ **失败处理**：继续使用旧规则，不中断任务
6. ✅ **审计日志**：记录所有更新尝试和结果

### 验证指标

- ✅ 视频数量 ≥ 45 个
- ✅ 红人用户名数量 ≥ 10 个 ⭐
- ✅ videoId 完整度 ≥ 98%
- ✅ videoUrl 完整度 ≥ 98%
- ✅ username 完整度 ≥ 95%
- ✅ URL 错误率 ≤ 5%

### 重试流程

```
第 1 次尝试 → 失败 → 等待 2 秒
第 2 次尝试 → 失败 → 等待 4 秒
第 3 次尝试 → 失败 → 继续使用旧规则
```
## 📋 需求确认

1. ✅ **阈值**：至少 10 个红人用户名（去重后）
2. ✅ **环境**：所有环境（开发/测试/生产）统一阈值
3. ✅ **重试机制**：未达到阈值时，重新尝试更新规则，最多 3 次
4. ✅ **失败处理**：3 次都失败则继续使用旧规则

---

## 🏗️ 架构设计

### 1. 核心流程

```
提取数据 → 检测去重后的用户名数量 < 10？ → 触发更新
    ↓
需要更新 → 重试循环（最多 3 次）
    ├─ 第 1 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 2 秒
    ├─ 第 2 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 4 秒
    └─ 第 3 次：LLM 生成规则 → 验证
        ├─ 成功 → 应用新规则 ✅
        └─ 失败 → 继续使用旧规则 ⚠️
```

---

## 💻 实现代码

### 1. 验证阈值配置

```javascript
// lib/html-extraction/validation-config.js

export const VALIDATION_THRESHOLDS = {
  // 数量指标
  videoCount: {
    minimum: parseInt(process.env.RULES_MIN_VIDEO_COUNT || '45'),
    target: parseInt(process.env.RULES_TARGET_VIDEO_COUNT || '50'),
    warning: parseInt(process.env.RULES_WARNING_VIDEO_COUNT || '48')
  },
  
  usernameCount: {
    minimum: parseInt(process.env.RULES_MIN_USERNAME_COUNT || '10'),  // ⭐ 用户要求：至少 10 个
    target: parseInt(process.env.RULES_TARGET_USERNAME_COUNT || '15'),
    warning: parseInt(process.env.RULES_WARNING_USERNAME_COUNT || '12')
  },
  
  // 字段完整度
  videoFields: {
    videoId: parseFloat(process.env.RULES_VIDEO_ID_RATE || '0.98'),
    videoUrl: parseFloat(process.env.RULES_VIDEO_URL_RATE || '0.98'),
    username: parseFloat(process.env.RULES_VIDEO_USERNAME_RATE || '0.95'),
    description: parseFloat(process.env.RULES_VIDEO_DESCRIPTION_RATE || '0.80'),
    thumbnail: parseFloat(process.env.RULES_VIDEO_THUMBNAIL_RATE || '0.70')
  },
  
  userFields: {
    username: parseFloat(process.env.RULES_USER_USERNAME_RATE || '0.95'),
    profileUrl: parseFloat(process.env.RULES_USER_PROFILE_URL_RATE || '0.95')
  },
  
  // 数据质量
  dataQuality: {
    maxUrlErrorRate: parseFloat(process.env.RULES_MAX_URL_ERROR_RATE || '0.05'),
    maxUsernameErrorRate: parseFloat(process.env.RULES_MAX_USERNAME_ERROR_RATE || '0.05')
  }
};

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

---

### 2. 验证函数

```javascript
// lib/html-extraction/rule-validator.js

import { VALIDATION_THRESHOLDS } from './validation-config.js';

export function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VALIDATION_THRESHOLDS.videoCount.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VALIDATION_THRESHOLDS.videoCount.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => {
    if (v.username) {
      uniqueUsernames.add(v.username);
    }
  });
  newResult.users.forEach(u => {
    if (u.username) {
      uniqueUsernames.add(u.username);
    }
  });
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < VALIDATION_THRESHOLDS.usernameCount.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${VALIDATION_THRESHOLDS.usernameCount.minimum}`,
      metrics: { usernameCount, videoCount }
    };
  }
  
  // 4. 字段完整度验证
  const videoFieldValidation = validateVideoFields(newResult.videos);
  if (!videoFieldValidation.ok) {
    return videoFieldValidation;
  }
  
  const userFieldValidation = validateUserFields(newResult.users);
  if (!userFieldValidation.ok) {
    return userFieldValidation;
  }
  
  // 5. 数据质量验证
  const urlValidation = validateUrls(newResult);
  if (!urlValidation.ok) {
    return urlValidation;
  }
  
  const usernameValidation = validateUsernames(newResult);
  if (!usernameValidation.ok) {
    return usernameValidation;
  }
  
  // 6. 综合指标计算
  const metrics = {
    videoCount,
    usernameCount,
    videoIdRate: newResult.videos.filter(v => v.videoId).length / videoCount,
    videoUrlRate: newResult.videos.filter(v => v.videoUrl).length / videoCount,
    usernameRate: newResult.videos.filter(v => v.username).length / videoCount,
    descriptionRate: newResult.videos.filter(v => v.description).length / videoCount,
    thumbnailRate: newResult.videos.filter(v => v.thumbnail).length / videoCount,
  };
  
  return { ok: true, metrics };
}

function validateVideoFields(videos) {
  const videoCount = videos.length;
  if (videoCount === 0) {
    return { ok: false, reason: '没有提取到任何视频' };
  }
  
  const videoIdRate = videos.filter(v => v.videoId).length / videoCount;
  const videoUrlRate = videos.filter(v => v.videoUrl).length / videoCount;
  const usernameRate = videos.filter(v => v.username).length / videoCount;
  
  if (videoIdRate < VALIDATION_THRESHOLDS.videoFields.videoId) {
    return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VALIDATION_THRESHOLDS.videoFields.videoId}` };
  }
  
  if (videoUrlRate < VALIDATION_THRESHOLDS.videoFields.videoUrl) {
    return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VALIDATION_THRESHOLDS.videoFields.videoUrl}` };
  }
  
  if (usernameRate < VALIDATION_THRESHOLDS.videoFields.username) {
    return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.videoFields.username}` };
  }
  
  return { ok: true };
}

function validateUserFields(users) {
  const userCount = users.length;
  if (userCount === 0) {
    return { ok: false, reason: '没有提取到任何用户' };
  }
  
  const usernameRate = users.filter(u => u.username).length / userCount;
  const profileUrlRate = users.filter(u => u.profileUrl).length / userCount;
  
  if (usernameRate < VALIDATION_THRESHOLDS.userFields.username) {
    return { ok: false, reason: `用户 username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.userFields.username}` };
  }
  
  if (profileUrlRate < VALIDATION_THRESHOLDS.userFields.profileUrl) {
    return { ok: false, reason: `用户 profileUrl 完整度不足: ${profileUrlRate} < ${VALIDATION_THRESHOLDS.userFields.profileUrl}` };
  }
  
  return { ok: true };
}

function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / Math.max(1, extractedData.videos.length);
  const profileUrlErrorRate = invalidProfileUrls / Math.max(1, extractedData.users.length);
  
  if (videoUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}

function validateUsernames(extractedData) {
  const usernamePattern = /^@?[a-zA-Z0-9._]+$/;
  
  const invalidUsernames = [];
  
  extractedData.videos.forEach(v => {
    if (v.username && !usernamePattern.test(v.username)) {
      invalidUsernames.push(v.username);
    }
  });
  
  extractedData.users.forEach(u => {
    if (u.username && !usernamePattern.test(u.username)) {
      invalidUsernames.push(u.username);
    }
  });
  
  const totalUsernames = extractedData.videos.filter(v => v.username).length + 
                         extractedData.users.filter(u => u.username).length;
  const errorRate = invalidUsernames.length / Math.max(1, totalUsernames);
  
  if (errorRate > VALIDATION_THRESHOLDS.dataQuality.maxUsernameErrorRate) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

### 3. 重试机制实现

```javascript
// lib/html-extraction/rules-updater.js

import { validateRules } from './rule-validator.js';
import { RETRY_CONFIG } from './validation-config.js';
import { generateRulesFromHTML } from './rule-generator.js';
import { saveRules, loadRules } from './rules-manager.js';
import { auditRuleChange } from './rules-audit.js';

export async function updateRulesWithRetry(html, extractionResult, expectedVideoCount = 50) {
  const maxRetries = RETRY_CONFIG.maxRetries;
  const baseDelay = RETRY_CONFIG.retryDelay;
  let lastError = null;
  const currentRules = loadRules();
  
  console.log(`[规则更新] 开始更新规则，最多重试 ${maxRetries} 次...`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      console.log(`[规则更新] 调用 LLM 生成新规则...`);
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      console.log(`[规则更新] 验证新规则...`);
      const validationResult = validateRules(html, newRules, extractionResult, expectedVideoCount);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功！`);
        console.log(`[规则更新] 指标:`, validationResult.metrics);
        
        // 保存规则
        saveRules(newRules);
        
        // 记录审计日志
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { 
          success: true, 
          rules: newRules, 
          attempt,
          metrics: validationResult.metrics
        };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        console.warn(`[规则更新] 指标:`, validationResult.metrics || {});
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
          const waitTime = baseDelay * attempt; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        const waitTime = baseDelay * attempt;
        console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3 次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  // 记录失败日志
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
    currentRuleVersion: currentRules.version,
  });
  
  // 发送告警（可选）
  // sendAlert('规则更新失败', { attempts: maxRetries, lastError: lastError?.reason });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true,  // 继续使用旧规则
    currentRules: currentRules
  };
}
```

---

### 4. 主流程集成

```javascript
// scripts/tiktok-login.js (集成点)

import { updateRulesWithRetry } from '../lib/html-extraction/rules-updater.js';
import { shouldTriggerRuleUpdate } from '../lib/html-extraction/rules-trigger.js';

// 在提取数据后
async function extractVideosAndInfluencersWithAI(page) {
  // ... 现有代码 ...
  
  // 提取数据
  const extractionResult = {
    videos: extractedVideos,
    users: extractedUsers
  };
  
  // 检测是否需要更新规则（去重后的用户名数量 < 10）
  if (shouldTriggerRuleUpdate(extractionResult)) {
    console.log('[规则更新] 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    // 获取 HTML（用于 LLM 学习）
    const html = await page.content();
    const optimizedHTML = optimizeHTML(html);
    
    // 尝试更新规则（最多 3 次）
    const updateResult = await updateRulesWithRetry(
      optimizedHTML, 
      extractionResult, 
      expectedVideoCount
    );
    
    if (updateResult.success) {
      console.log('[规则更新] ✅ 规则更新成功，使用新规则重新提取...');
      // 可选：用新规则重新提取一次
      // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
    } else {
      console.log('[规则更新] ⚠️ 规则更新失败，继续使用旧规则');
      // 继续使用当前提取结果
    }
  }
  
  // ... 继续后续流程 ...
}
```

---

## 📊 配置示例

### 环境变量配置

```bash
# .env (所有环境统一)
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 至少 10 个红人用户名
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_RETRY_DELAY=2000       # 基础延迟 2 秒
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## ✅ 总结

### 核心特性

1. ✅ **触发条件**：去重后的用户名数量 < 10
2. ✅ **阈值**：至少 10 个红人用户名（去重后）
3. ✅ **环境**：所有环境统一阈值
4. ✅ **重试**：最多 3 次，递增延迟（2s, 4s, 6s）
5. ✅ **失败处理**：继续使用旧规则，不中断任务
6. ✅ **审计日志**：记录所有更新尝试和结果

### 验证指标

- ✅ 视频数量 ≥ 45 个
- ✅ 红人用户名数量 ≥ 10 个 ⭐
- ✅ videoId 完整度 ≥ 98%
- ✅ videoUrl 完整度 ≥ 98%
- ✅ username 完整度 ≥ 95%
- ✅ URL 错误率 ≤ 5%

### 重试流程

```
第 1 次尝试 → 失败 → 等待 2 秒
第 2 次尝试 → 失败 → 等待 4 秒
第 3 次尝试 → 失败 → 继续使用旧规则
```
## 📋 需求确认

1. ✅ **阈值**：至少 10 个红人用户名（去重后）
2. ✅ **环境**：所有环境（开发/测试/生产）统一阈值
3. ✅ **重试机制**：未达到阈值时，重新尝试更新规则，最多 3 次
4. ✅ **失败处理**：3 次都失败则继续使用旧规则

---

## 🏗️ 架构设计

### 1. 核心流程

```
提取数据 → 检测去重后的用户名数量 < 10？ → 触发更新
    ↓
需要更新 → 重试循环（最多 3 次）
    ├─ 第 1 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 2 秒
    ├─ 第 2 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 4 秒
    └─ 第 3 次：LLM 生成规则 → 验证
        ├─ 成功 → 应用新规则 ✅
        └─ 失败 → 继续使用旧规则 ⚠️
```

---

## 💻 实现代码

### 1. 验证阈值配置

```javascript
// lib/html-extraction/validation-config.js

export const VALIDATION_THRESHOLDS = {
  // 数量指标
  videoCount: {
    minimum: parseInt(process.env.RULES_MIN_VIDEO_COUNT || '45'),
    target: parseInt(process.env.RULES_TARGET_VIDEO_COUNT || '50'),
    warning: parseInt(process.env.RULES_WARNING_VIDEO_COUNT || '48')
  },
  
  usernameCount: {
    minimum: parseInt(process.env.RULES_MIN_USERNAME_COUNT || '10'),  // ⭐ 用户要求：至少 10 个
    target: parseInt(process.env.RULES_TARGET_USERNAME_COUNT || '15'),
    warning: parseInt(process.env.RULES_WARNING_USERNAME_COUNT || '12')
  },
  
  // 字段完整度
  videoFields: {
    videoId: parseFloat(process.env.RULES_VIDEO_ID_RATE || '0.98'),
    videoUrl: parseFloat(process.env.RULES_VIDEO_URL_RATE || '0.98'),
    username: parseFloat(process.env.RULES_VIDEO_USERNAME_RATE || '0.95'),
    description: parseFloat(process.env.RULES_VIDEO_DESCRIPTION_RATE || '0.80'),
    thumbnail: parseFloat(process.env.RULES_VIDEO_THUMBNAIL_RATE || '0.70')
  },
  
  userFields: {
    username: parseFloat(process.env.RULES_USER_USERNAME_RATE || '0.95'),
    profileUrl: parseFloat(process.env.RULES_USER_PROFILE_URL_RATE || '0.95')
  },
  
  // 数据质量
  dataQuality: {
    maxUrlErrorRate: parseFloat(process.env.RULES_MAX_URL_ERROR_RATE || '0.05'),
    maxUsernameErrorRate: parseFloat(process.env.RULES_MAX_USERNAME_ERROR_RATE || '0.05')
  }
};

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

---

### 2. 验证函数

```javascript
// lib/html-extraction/rule-validator.js

import { VALIDATION_THRESHOLDS } from './validation-config.js';

export function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VALIDATION_THRESHOLDS.videoCount.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VALIDATION_THRESHOLDS.videoCount.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => {
    if (v.username) {
      uniqueUsernames.add(v.username);
    }
  });
  newResult.users.forEach(u => {
    if (u.username) {
      uniqueUsernames.add(u.username);
    }
  });
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < VALIDATION_THRESHOLDS.usernameCount.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${VALIDATION_THRESHOLDS.usernameCount.minimum}`,
      metrics: { usernameCount, videoCount }
    };
  }
  
  // 4. 字段完整度验证
  const videoFieldValidation = validateVideoFields(newResult.videos);
  if (!videoFieldValidation.ok) {
    return videoFieldValidation;
  }
  
  const userFieldValidation = validateUserFields(newResult.users);
  if (!userFieldValidation.ok) {
    return userFieldValidation;
  }
  
  // 5. 数据质量验证
  const urlValidation = validateUrls(newResult);
  if (!urlValidation.ok) {
    return urlValidation;
  }
  
  const usernameValidation = validateUsernames(newResult);
  if (!usernameValidation.ok) {
    return usernameValidation;
  }
  
  // 6. 综合指标计算
  const metrics = {
    videoCount,
    usernameCount,
    videoIdRate: newResult.videos.filter(v => v.videoId).length / videoCount,
    videoUrlRate: newResult.videos.filter(v => v.videoUrl).length / videoCount,
    usernameRate: newResult.videos.filter(v => v.username).length / videoCount,
    descriptionRate: newResult.videos.filter(v => v.description).length / videoCount,
    thumbnailRate: newResult.videos.filter(v => v.thumbnail).length / videoCount,
  };
  
  return { ok: true, metrics };
}

function validateVideoFields(videos) {
  const videoCount = videos.length;
  if (videoCount === 0) {
    return { ok: false, reason: '没有提取到任何视频' };
  }
  
  const videoIdRate = videos.filter(v => v.videoId).length / videoCount;
  const videoUrlRate = videos.filter(v => v.videoUrl).length / videoCount;
  const usernameRate = videos.filter(v => v.username).length / videoCount;
  
  if (videoIdRate < VALIDATION_THRESHOLDS.videoFields.videoId) {
    return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VALIDATION_THRESHOLDS.videoFields.videoId}` };
  }
  
  if (videoUrlRate < VALIDATION_THRESHOLDS.videoFields.videoUrl) {
    return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VALIDATION_THRESHOLDS.videoFields.videoUrl}` };
  }
  
  if (usernameRate < VALIDATION_THRESHOLDS.videoFields.username) {
    return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.videoFields.username}` };
  }
  
  return { ok: true };
}

function validateUserFields(users) {
  const userCount = users.length;
  if (userCount === 0) {
    return { ok: false, reason: '没有提取到任何用户' };
  }
  
  const usernameRate = users.filter(u => u.username).length / userCount;
  const profileUrlRate = users.filter(u => u.profileUrl).length / userCount;
  
  if (usernameRate < VALIDATION_THRESHOLDS.userFields.username) {
    return { ok: false, reason: `用户 username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.userFields.username}` };
  }
  
  if (profileUrlRate < VALIDATION_THRESHOLDS.userFields.profileUrl) {
    return { ok: false, reason: `用户 profileUrl 完整度不足: ${profileUrlRate} < ${VALIDATION_THRESHOLDS.userFields.profileUrl}` };
  }
  
  return { ok: true };
}

function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / Math.max(1, extractedData.videos.length);
  const profileUrlErrorRate = invalidProfileUrls / Math.max(1, extractedData.users.length);
  
  if (videoUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}

function validateUsernames(extractedData) {
  const usernamePattern = /^@?[a-zA-Z0-9._]+$/;
  
  const invalidUsernames = [];
  
  extractedData.videos.forEach(v => {
    if (v.username && !usernamePattern.test(v.username)) {
      invalidUsernames.push(v.username);
    }
  });
  
  extractedData.users.forEach(u => {
    if (u.username && !usernamePattern.test(u.username)) {
      invalidUsernames.push(u.username);
    }
  });
  
  const totalUsernames = extractedData.videos.filter(v => v.username).length + 
                         extractedData.users.filter(u => u.username).length;
  const errorRate = invalidUsernames.length / Math.max(1, totalUsernames);
  
  if (errorRate > VALIDATION_THRESHOLDS.dataQuality.maxUsernameErrorRate) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

### 3. 重试机制实现

```javascript
// lib/html-extraction/rules-updater.js

import { validateRules } from './rule-validator.js';
import { RETRY_CONFIG } from './validation-config.js';
import { generateRulesFromHTML } from './rule-generator.js';
import { saveRules, loadRules } from './rules-manager.js';
import { auditRuleChange } from './rules-audit.js';

export async function updateRulesWithRetry(html, extractionResult, expectedVideoCount = 50) {
  const maxRetries = RETRY_CONFIG.maxRetries;
  const baseDelay = RETRY_CONFIG.retryDelay;
  let lastError = null;
  const currentRules = loadRules();
  
  console.log(`[规则更新] 开始更新规则，最多重试 ${maxRetries} 次...`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      console.log(`[规则更新] 调用 LLM 生成新规则...`);
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      console.log(`[规则更新] 验证新规则...`);
      const validationResult = validateRules(html, newRules, extractionResult, expectedVideoCount);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功！`);
        console.log(`[规则更新] 指标:`, validationResult.metrics);
        
        // 保存规则
        saveRules(newRules);
        
        // 记录审计日志
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { 
          success: true, 
          rules: newRules, 
          attempt,
          metrics: validationResult.metrics
        };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        console.warn(`[规则更新] 指标:`, validationResult.metrics || {});
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
          const waitTime = baseDelay * attempt; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        const waitTime = baseDelay * attempt;
        console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3 次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  // 记录失败日志
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
    currentRuleVersion: currentRules.version,
  });
  
  // 发送告警（可选）
  // sendAlert('规则更新失败', { attempts: maxRetries, lastError: lastError?.reason });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true,  // 继续使用旧规则
    currentRules: currentRules
  };
}
```

---

### 4. 主流程集成

```javascript
// scripts/tiktok-login.js (集成点)

import { updateRulesWithRetry } from '../lib/html-extraction/rules-updater.js';
import { shouldTriggerRuleUpdate } from '../lib/html-extraction/rules-trigger.js';

// 在提取数据后
async function extractVideosAndInfluencersWithAI(page) {
  // ... 现有代码 ...
  
  // 提取数据
  const extractionResult = {
    videos: extractedVideos,
    users: extractedUsers
  };
  
  // 检测是否需要更新规则（去重后的用户名数量 < 10）
  if (shouldTriggerRuleUpdate(extractionResult)) {
    console.log('[规则更新] 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    // 获取 HTML（用于 LLM 学习）
    const html = await page.content();
    const optimizedHTML = optimizeHTML(html);
    
    // 尝试更新规则（最多 3 次）
    const updateResult = await updateRulesWithRetry(
      optimizedHTML, 
      extractionResult, 
      expectedVideoCount
    );
    
    if (updateResult.success) {
      console.log('[规则更新] ✅ 规则更新成功，使用新规则重新提取...');
      // 可选：用新规则重新提取一次
      // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
    } else {
      console.log('[规则更新] ⚠️ 规则更新失败，继续使用旧规则');
      // 继续使用当前提取结果
    }
  }
  
  // ... 继续后续流程 ...
}
```

---

## 📊 配置示例

### 环境变量配置

```bash
# .env (所有环境统一)
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 至少 10 个红人用户名
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_RETRY_DELAY=2000       # 基础延迟 2 秒
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## ✅ 总结

### 核心特性

1. ✅ **触发条件**：去重后的用户名数量 < 10
2. ✅ **阈值**：至少 10 个红人用户名（去重后）
3. ✅ **环境**：所有环境统一阈值
4. ✅ **重试**：最多 3 次，递增延迟（2s, 4s, 6s）
5. ✅ **失败处理**：继续使用旧规则，不中断任务
6. ✅ **审计日志**：记录所有更新尝试和结果

### 验证指标

- ✅ 视频数量 ≥ 45 个
- ✅ 红人用户名数量 ≥ 10 个 ⭐
- ✅ videoId 完整度 ≥ 98%
- ✅ videoUrl 完整度 ≥ 98%
- ✅ username 完整度 ≥ 95%
- ✅ URL 错误率 ≤ 5%

### 重试流程

```
第 1 次尝试 → 失败 → 等待 2 秒
第 2 次尝试 → 失败 → 等待 4 秒
第 3 次尝试 → 失败 → 继续使用旧规则
```
## 📋 需求确认

1. ✅ **阈值**：至少 10 个红人用户名（去重后）
2. ✅ **环境**：所有环境（开发/测试/生产）统一阈值
3. ✅ **重试机制**：未达到阈值时，重新尝试更新规则，最多 3 次
4. ✅ **失败处理**：3 次都失败则继续使用旧规则

---

## 🏗️ 架构设计

### 1. 核心流程

```
提取数据 → 检测去重后的用户名数量 < 10？ → 触发更新
    ↓
需要更新 → 重试循环（最多 3 次）
    ├─ 第 1 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 2 秒
    ├─ 第 2 次：LLM 生成规则 → 验证
    │   ├─ 成功 → 应用新规则 ✅
    │   └─ 失败 → 等待 4 秒
    └─ 第 3 次：LLM 生成规则 → 验证
        ├─ 成功 → 应用新规则 ✅
        └─ 失败 → 继续使用旧规则 ⚠️
```

---

## 💻 实现代码

### 1. 验证阈值配置

```javascript
// lib/html-extraction/validation-config.js

export const VALIDATION_THRESHOLDS = {
  // 数量指标
  videoCount: {
    minimum: parseInt(process.env.RULES_MIN_VIDEO_COUNT || '45'),
    target: parseInt(process.env.RULES_TARGET_VIDEO_COUNT || '50'),
    warning: parseInt(process.env.RULES_WARNING_VIDEO_COUNT || '48')
  },
  
  usernameCount: {
    minimum: parseInt(process.env.RULES_MIN_USERNAME_COUNT || '10'),  // ⭐ 用户要求：至少 10 个
    target: parseInt(process.env.RULES_TARGET_USERNAME_COUNT || '15'),
    warning: parseInt(process.env.RULES_WARNING_USERNAME_COUNT || '12')
  },
  
  // 字段完整度
  videoFields: {
    videoId: parseFloat(process.env.RULES_VIDEO_ID_RATE || '0.98'),
    videoUrl: parseFloat(process.env.RULES_VIDEO_URL_RATE || '0.98'),
    username: parseFloat(process.env.RULES_VIDEO_USERNAME_RATE || '0.95'),
    description: parseFloat(process.env.RULES_VIDEO_DESCRIPTION_RATE || '0.80'),
    thumbnail: parseFloat(process.env.RULES_VIDEO_THUMBNAIL_RATE || '0.70')
  },
  
  userFields: {
    username: parseFloat(process.env.RULES_USER_USERNAME_RATE || '0.95'),
    profileUrl: parseFloat(process.env.RULES_USER_PROFILE_URL_RATE || '0.95')
  },
  
  // 数据质量
  dataQuality: {
    maxUrlErrorRate: parseFloat(process.env.RULES_MAX_URL_ERROR_RATE || '0.05'),
    maxUsernameErrorRate: parseFloat(process.env.RULES_MAX_USERNAME_ERROR_RATE || '0.05')
  }
};

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

---

### 2. 验证函数

```javascript
// lib/html-extraction/rule-validator.js

import { VALIDATION_THRESHOLDS } from './validation-config.js';

export function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VALIDATION_THRESHOLDS.videoCount.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VALIDATION_THRESHOLDS.videoCount.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => {
    if (v.username) {
      uniqueUsernames.add(v.username);
    }
  });
  newResult.users.forEach(u => {
    if (u.username) {
      uniqueUsernames.add(u.username);
    }
  });
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < VALIDATION_THRESHOLDS.usernameCount.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${VALIDATION_THRESHOLDS.usernameCount.minimum}`,
      metrics: { usernameCount, videoCount }
    };
  }
  
  // 4. 字段完整度验证
  const videoFieldValidation = validateVideoFields(newResult.videos);
  if (!videoFieldValidation.ok) {
    return videoFieldValidation;
  }
  
  const userFieldValidation = validateUserFields(newResult.users);
  if (!userFieldValidation.ok) {
    return userFieldValidation;
  }
  
  // 5. 数据质量验证
  const urlValidation = validateUrls(newResult);
  if (!urlValidation.ok) {
    return urlValidation;
  }
  
  const usernameValidation = validateUsernames(newResult);
  if (!usernameValidation.ok) {
    return usernameValidation;
  }
  
  // 6. 综合指标计算
  const metrics = {
    videoCount,
    usernameCount,
    videoIdRate: newResult.videos.filter(v => v.videoId).length / videoCount,
    videoUrlRate: newResult.videos.filter(v => v.videoUrl).length / videoCount,
    usernameRate: newResult.videos.filter(v => v.username).length / videoCount,
    descriptionRate: newResult.videos.filter(v => v.description).length / videoCount,
    thumbnailRate: newResult.videos.filter(v => v.thumbnail).length / videoCount,
  };
  
  return { ok: true, metrics };
}

function validateVideoFields(videos) {
  const videoCount = videos.length;
  if (videoCount === 0) {
    return { ok: false, reason: '没有提取到任何视频' };
  }
  
  const videoIdRate = videos.filter(v => v.videoId).length / videoCount;
  const videoUrlRate = videos.filter(v => v.videoUrl).length / videoCount;
  const usernameRate = videos.filter(v => v.username).length / videoCount;
  
  if (videoIdRate < VALIDATION_THRESHOLDS.videoFields.videoId) {
    return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VALIDATION_THRESHOLDS.videoFields.videoId}` };
  }
  
  if (videoUrlRate < VALIDATION_THRESHOLDS.videoFields.videoUrl) {
    return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VALIDATION_THRESHOLDS.videoFields.videoUrl}` };
  }
  
  if (usernameRate < VALIDATION_THRESHOLDS.videoFields.username) {
    return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.videoFields.username}` };
  }
  
  return { ok: true };
}

function validateUserFields(users) {
  const userCount = users.length;
  if (userCount === 0) {
    return { ok: false, reason: '没有提取到任何用户' };
  }
  
  const usernameRate = users.filter(u => u.username).length / userCount;
  const profileUrlRate = users.filter(u => u.profileUrl).length / userCount;
  
  if (usernameRate < VALIDATION_THRESHOLDS.userFields.username) {
    return { ok: false, reason: `用户 username 完整度不足: ${usernameRate} < ${VALIDATION_THRESHOLDS.userFields.username}` };
  }
  
  if (profileUrlRate < VALIDATION_THRESHOLDS.userFields.profileUrl) {
    return { ok: false, reason: `用户 profileUrl 完整度不足: ${profileUrlRate} < ${VALIDATION_THRESHOLDS.userFields.profileUrl}` };
  }
  
  return { ok: true };
}

function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / Math.max(1, extractedData.videos.length);
  const profileUrlErrorRate = invalidProfileUrls / Math.max(1, extractedData.users.length);
  
  if (videoUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > VALIDATION_THRESHOLDS.dataQuality.maxUrlErrorRate) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}

function validateUsernames(extractedData) {
  const usernamePattern = /^@?[a-zA-Z0-9._]+$/;
  
  const invalidUsernames = [];
  
  extractedData.videos.forEach(v => {
    if (v.username && !usernamePattern.test(v.username)) {
      invalidUsernames.push(v.username);
    }
  });
  
  extractedData.users.forEach(u => {
    if (u.username && !usernamePattern.test(u.username)) {
      invalidUsernames.push(u.username);
    }
  });
  
  const totalUsernames = extractedData.videos.filter(v => v.username).length + 
                         extractedData.users.filter(u => u.username).length;
  const errorRate = invalidUsernames.length / Math.max(1, totalUsernames);
  
  if (errorRate > VALIDATION_THRESHOLDS.dataQuality.maxUsernameErrorRate) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

### 3. 重试机制实现

```javascript
// lib/html-extraction/rules-updater.js

import { validateRules } from './rule-validator.js';
import { RETRY_CONFIG } from './validation-config.js';
import { generateRulesFromHTML } from './rule-generator.js';
import { saveRules, loadRules } from './rules-manager.js';
import { auditRuleChange } from './rules-audit.js';

export async function updateRulesWithRetry(html, extractionResult, expectedVideoCount = 50) {
  const maxRetries = RETRY_CONFIG.maxRetries;
  const baseDelay = RETRY_CONFIG.retryDelay;
  let lastError = null;
  const currentRules = loadRules();
  
  console.log(`[规则更新] 开始更新规则，最多重试 ${maxRetries} 次...`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      console.log(`[规则更新] 调用 LLM 生成新规则...`);
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      console.log(`[规则更新] 验证新规则...`);
      const validationResult = validateRules(html, newRules, extractionResult, expectedVideoCount);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功！`);
        console.log(`[规则更新] 指标:`, validationResult.metrics);
        
        // 保存规则
        saveRules(newRules);
        
        // 记录审计日志
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { 
          success: true, 
          rules: newRules, 
          attempt,
          metrics: validationResult.metrics
        };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        console.warn(`[规则更新] 指标:`, validationResult.metrics || {});
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries) {
          const waitTime = baseDelay * attempt; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        const waitTime = baseDelay * attempt;
        console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3 次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  // 记录失败日志
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
    currentRuleVersion: currentRules.version,
  });
  
  // 发送告警（可选）
  // sendAlert('规则更新失败', { attempts: maxRetries, lastError: lastError?.reason });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true,  // 继续使用旧规则
    currentRules: currentRules
  };
}
```

---

### 4. 主流程集成

```javascript
// scripts/tiktok-login.js (集成点)

import { updateRulesWithRetry } from '../lib/html-extraction/rules-updater.js';
import { shouldTriggerRuleUpdate } from '../lib/html-extraction/rules-trigger.js';

// 在提取数据后
async function extractVideosAndInfluencersWithAI(page) {
  // ... 现有代码 ...
  
  // 提取数据
  const extractionResult = {
    videos: extractedVideos,
    users: extractedUsers
  };
  
  // 检测是否需要更新规则（去重后的用户名数量 < 10）
  if (shouldTriggerRuleUpdate(extractionResult)) {
    console.log('[规则更新] 检测到去重后的用户名数量 < 10，触发规则更新...');
    
    // 获取 HTML（用于 LLM 学习）
    const html = await page.content();
    const optimizedHTML = optimizeHTML(html);
    
    // 尝试更新规则（最多 3 次）
    const updateResult = await updateRulesWithRetry(
      optimizedHTML, 
      extractionResult, 
      expectedVideoCount
    );
    
    if (updateResult.success) {
      console.log('[规则更新] ✅ 规则更新成功，使用新规则重新提取...');
      // 可选：用新规则重新提取一次
      // const newResult = extractWithRules(optimizedHTML, updateResult.rules);
    } else {
      console.log('[规则更新] ⚠️ 规则更新失败，继续使用旧规则');
      // 继续使用当前提取结果
    }
  }
  
  // ... 继续后续流程 ...
}
```

---

## 📊 配置示例

### 环境变量配置

```bash
# .env (所有环境统一)
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 至少 10 个红人用户名
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_RETRY_DELAY=2000       # 基础延迟 2 秒
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## ✅ 总结

### 核心特性

1. ✅ **触发条件**：去重后的用户名数量 < 10
2. ✅ **阈值**：至少 10 个红人用户名（去重后）
3. ✅ **环境**：所有环境统一阈值
4. ✅ **重试**：最多 3 次，递增延迟（2s, 4s, 6s）
5. ✅ **失败处理**：继续使用旧规则，不中断任务
6. ✅ **审计日志**：记录所有更新尝试和结果

### 验证指标

- ✅ 视频数量 ≥ 45 个
- ✅ 红人用户名数量 ≥ 10 个 ⭐
- ✅ videoId 完整度 ≥ 98%
- ✅ videoUrl 完整度 ≥ 98%
- ✅ username 完整度 ≥ 95%
- ✅ URL 错误率 ≤ 5%

### 重试流程

```
第 1 次尝试 → 失败 → 等待 2 秒
第 2 次尝试 → 失败 → 等待 4 秒
第 3 次尝试 → 失败 → 继续使用旧规则
```