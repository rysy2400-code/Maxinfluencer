# 规则验证阈值体系设计

## 📋 目标

设计一套严格的验证阈值体系，确保自动更新规则时：
- ✅ 所有环境（开发/测试/生产）都允许自动更新
- ✅ 但必须达到严格的验证阈值才应用新规则
- ✅ 未达到阈值则不更新，保持使用旧规则

---

## 🎯 核心验证指标

### 1. 数量指标（必须满足）

#### 1.1 视频数量阈值

**指标：** `extractedVideos.length`

**当前情况：**
- 目标：滚动获取 50 个视频
- 实际：通常能获取 50-60 个视频

**建议阈值：**
```javascript
const VIDEO_COUNT_THRESHOLD = {
  minimum: 45,      // 至少 45 个视频（90%）
  target: 50,       // 目标 50 个视频
  warning: 48       // 低于 48 个发出警告
};
```

**验证逻辑：**
```javascript
if (extractedVideos.length < VIDEO_COUNT_THRESHOLD.minimum) {
  return { ok: false, reason: `视频数量不足: ${extractedVideos.length} < ${VIDEO_COUNT_THRESHOLD.minimum}` };
}
```

---

#### 1.2 红人用户名数量阈值 ⭐（用户重点关注的指标）

**指标：** `uniqueUsernames.size`

**当前情况：**
- 视频：60 个
- 红人用户名：59 个（去重后）

**用户要求：至少 10 个红人用户名（去重后）**

**最终阈值：**
```javascript
const USERNAME_COUNT_THRESHOLD = {
  minimum: 10,      // ⭐ 至少 10 个不同的红人用户名（用户要求）
  target: 15,       // 目标 15 个
  warning: 12       // 低于 12 个发出警告
};
```

**验证逻辑：**
```javascript
// 提取所有唯一的红人用户名
const uniqueUsernames = new Set();
extractedVideos.forEach(video => {
  if (video.username) {
    uniqueUsernames.add(video.username);
  }
});
extractedUsers.forEach(user => {
  if (user.username) {
    uniqueUsernames.add(user.username);
  }
});

if (uniqueUsernames.size < USERNAME_COUNT_THRESHOLD.minimum) {
  return { 
    ok: false, 
    reason: `红人用户名数量不足: ${uniqueUsernames.size} < ${USERNAME_COUNT_THRESHOLD.minimum}` 
  };
}
```

**为什么这个指标重要？**
- ✅ 红人用户名是核心业务数据
- ✅ 如果用户名提取失败，直接影响业务
- ✅ 比视频数量更能反映提取质量

---

### 2. 字段完整度指标（必须满足）

#### 2.1 视频字段完整度

**关键字段：**
- `videoId`（必须）
- `videoUrl`（必须）
- `username`（必须）
- `description`（重要）
- `thumbnail`（重要）

**建议阈值：**
```javascript
const VIDEO_FIELD_THRESHOLDS = {
  videoId: 0.98,        // 98% 的视频必须有 videoId
  videoUrl: 0.98,       // 98% 的视频必须有 videoUrl
  username: 0.95,       // 95% 的视频必须有 username
  description: 0.80,    // 80% 的视频必须有 description
  thumbnail: 0.70      // 70% 的视频必须有 thumbnail
};
```

**验证逻辑：**
```javascript
const videoCount = extractedVideos.length;
const videoIdRate = extractedVideos.filter(v => v.videoId).length / videoCount;
const videoUrlRate = extractedVideos.filter(v => v.videoUrl).length / videoCount;
const usernameRate = extractedVideos.filter(v => v.username).length / videoCount;
const descriptionRate = extractedVideos.filter(v => v.description).length / videoCount;
const thumbnailRate = extractedVideos.filter(v => v.thumbnail).length / videoCount;

if (videoIdRate < VIDEO_FIELD_THRESHOLDS.videoId) {
  return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VIDEO_FIELD_THRESHOLDS.videoId}` };
}
if (videoUrlRate < VIDEO_FIELD_THRESHOLDS.videoUrl) {
  return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VIDEO_FIELD_THRESHOLDS.videoUrl}` };
}
if (usernameRate < VIDEO_FIELD_THRESHOLDS.username) {
  return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VIDEO_FIELD_THRESHOLDS.username}` };
}
```

---

#### 2.2 红人字段完整度

**关键字段：**
- `username`（必须）
- `profileUrl`（必须）

**建议阈值：**
```javascript
const USER_FIELD_THRESHOLDS = {
  username: 0.95,      // 95% 的红人必须有 username
  profileUrl: 0.95     // 95% 的红人必须有 profileUrl
};
```

---

### 3. 数据质量指标（必须满足）

#### 3.1 URL 合法性验证

**验证逻辑：**
```javascript
function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / extractedData.videos.length;
  const profileUrlErrorRate = invalidProfileUrls / extractedData.users.length;
  
  if (videoUrlErrorRate > 0.05) {  // 超过 5% 的 URL 无效
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > 0.05) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}
```

---

#### 3.2 用户名格式验证

**验证逻辑：**
```javascript
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
  
  const errorRate = invalidUsernames.length / (extractedData.videos.length + extractedData.users.length);
  
  if (errorRate > 0.05) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

## 📊 综合验证函数

```javascript
function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VIDEO_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VIDEO_COUNT_THRESHOLD.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => v.username && uniqueUsernames.add(v.username));
  newResult.users.forEach(u => u.username && uniqueUsernames.add(u.username));
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < USERNAME_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${USERNAME_COUNT_THRESHOLD.minimum}`,
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
```

---

## ⚙️ 可配置的阈值参数

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
```

---

## 📝 环境变量配置示例

```bash
# .env.development
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.staging
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.production
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## 🎯 阈值设置建议讨论

### 关于"50个红人用户名"的建议

**你的建议：至少 50 个红人用户名**

**我的分析：**
- ✅ **合理**：当前能提取到 59 个，50 个是合理的下限
- ✅ **重要**：红人用户名是核心业务数据
- ✅ **严格**：50 个意味着至少 83% 的视频必须有有效的用户名

**建议调整（可选）：**
- **保守策略**：`minimum: 50`（你的建议）
- **平衡策略**：`minimum: 48`（允许少量缺失）
- **积极策略**：`minimum: 45`（允许更多容错）

**最终配置：**
```javascript
usernameCount: {
  minimum: 10,  // ⭐ 用户要求：至少 10 个（所有环境统一）
  target: 15,   // 目标值略高，给一些缓冲
  warning: 12   // 低于 12 个发出警告（但不阻止更新）
}
```

---

### 其他阈值建议

1. **视频数量：**
   - `minimum: 45`（90% 的视频）
   - 理由：允许少量视频缺失，但保证大部分数据

2. **字段完整度：**
   - `videoId/videoUrl: 0.98`（98%）
   - `username: 0.95`（95%）
   - 理由：核心字段必须高完整度

3. **数据质量：**
   - `maxUrlErrorRate: 0.05`（5%）
   - 理由：允许少量格式错误，但不允许大规模错误

---

## ✅ 最终建议

### 核心阈值（必须满足）

1. ✅ **视频数量 ≥ 45 个**
2. ✅ **红人用户名数量 ≥ 10 个** ⭐（用户要求，所有环境统一）
3. ✅ **videoId 完整度 ≥ 98%**
4. ✅ **videoUrl 完整度 ≥ 98%**
5. ✅ **username 完整度 ≥ 95%**
6. ✅ **URL 错误率 ≤ 5%**

### 可选阈值（建议满足）

1. ⚠️ **description 完整度 ≥ 80%**（警告但不阻止）
2. ⚠️ **thumbnail 完整度 ≥ 70%**（警告但不阻止）

---

## 🔄 重试机制

### 规则更新重试策略

**用户要求：未达到阈值时，重新尝试更新规则，最多不超过3次**

**实现逻辑：**
```javascript
async function updateRulesWithRetry(html, extractionResult, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      const validationResult = validateRules(html, newRules, extractionResult, 50);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功，应用新规则`);
        
        // 保存规则
        saveRules(newRules);
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { success: true, rules: newRules, attempt };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        
        // 如果不是最后一次尝试，等待一段时间后重试
        if (attempt < maxRetries) {
          const waitTime = attempt * 2000; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
  });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true  // 继续使用旧规则
  };
}
```

### 重试机制配置

```javascript
// lib/html-extraction/validation-config.js

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

### 重试流程

```
1. 检测到需要更新规则
   ↓
2. 第 1 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒
       ↓
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒
       ↓
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️
       ↓
5. 记录失败日志，发送告警
```

---

## ✅ 最终配置确认

### 1. 阈值配置（所有环境统一）

```javascript
const VALIDATION_THRESHOLDS = {
  usernameCount: {
    minimum: 10,  // ⭐ 至少 10 个不同的红人用户名（去重后）
    target: 15,
    warning: 12
  },
  videoCount: {
    minimum: 45,
    target: 50,
    warning: 48
  },
  // ... 其他阈值
};
```

### 2. 重试配置

```javascript
const RETRY_CONFIG = {
  maxRetries: 3,  // 最多重试 3 次
  retryDelay: 2000,  // 基础延迟 2 秒
};
```

### 3. 行为确认

- ✅ **所有环境统一阈值**：10 个红人用户名
- ✅ **未达到阈值时重试**：最多 3 次
- ✅ **3 次都失败**：继续使用旧规则，不中断任务
## 📋 目标

设计一套严格的验证阈值体系，确保自动更新规则时：
- ✅ 所有环境（开发/测试/生产）都允许自动更新
- ✅ 但必须达到严格的验证阈值才应用新规则
- ✅ 未达到阈值则不更新，保持使用旧规则

---

## 🎯 核心验证指标

### 1. 数量指标（必须满足）

#### 1.1 视频数量阈值

**指标：** `extractedVideos.length`

**当前情况：**
- 目标：滚动获取 50 个视频
- 实际：通常能获取 50-60 个视频

**建议阈值：**
```javascript
const VIDEO_COUNT_THRESHOLD = {
  minimum: 45,      // 至少 45 个视频（90%）
  target: 50,       // 目标 50 个视频
  warning: 48       // 低于 48 个发出警告
};
```

**验证逻辑：**
```javascript
if (extractedVideos.length < VIDEO_COUNT_THRESHOLD.minimum) {
  return { ok: false, reason: `视频数量不足: ${extractedVideos.length} < ${VIDEO_COUNT_THRESHOLD.minimum}` };
}
```

---

#### 1.2 红人用户名数量阈值 ⭐（用户重点关注的指标）

**指标：** `uniqueUsernames.size`

**当前情况：**
- 视频：60 个
- 红人用户名：59 个（去重后）

**用户要求：至少 10 个红人用户名（去重后）**

**最终阈值：**
```javascript
const USERNAME_COUNT_THRESHOLD = {
  minimum: 10,      // ⭐ 至少 10 个不同的红人用户名（用户要求）
  target: 15,       // 目标 15 个
  warning: 12       // 低于 12 个发出警告
};
```

**验证逻辑：**
```javascript
// 提取所有唯一的红人用户名
const uniqueUsernames = new Set();
extractedVideos.forEach(video => {
  if (video.username) {
    uniqueUsernames.add(video.username);
  }
});
extractedUsers.forEach(user => {
  if (user.username) {
    uniqueUsernames.add(user.username);
  }
});

if (uniqueUsernames.size < USERNAME_COUNT_THRESHOLD.minimum) {
  return { 
    ok: false, 
    reason: `红人用户名数量不足: ${uniqueUsernames.size} < ${USERNAME_COUNT_THRESHOLD.minimum}` 
  };
}
```

**为什么这个指标重要？**
- ✅ 红人用户名是核心业务数据
- ✅ 如果用户名提取失败，直接影响业务
- ✅ 比视频数量更能反映提取质量

---

### 2. 字段完整度指标（必须满足）

#### 2.1 视频字段完整度

**关键字段：**
- `videoId`（必须）
- `videoUrl`（必须）
- `username`（必须）
- `description`（重要）
- `thumbnail`（重要）

**建议阈值：**
```javascript
const VIDEO_FIELD_THRESHOLDS = {
  videoId: 0.98,        // 98% 的视频必须有 videoId
  videoUrl: 0.98,       // 98% 的视频必须有 videoUrl
  username: 0.95,       // 95% 的视频必须有 username
  description: 0.80,    // 80% 的视频必须有 description
  thumbnail: 0.70      // 70% 的视频必须有 thumbnail
};
```

**验证逻辑：**
```javascript
const videoCount = extractedVideos.length;
const videoIdRate = extractedVideos.filter(v => v.videoId).length / videoCount;
const videoUrlRate = extractedVideos.filter(v => v.videoUrl).length / videoCount;
const usernameRate = extractedVideos.filter(v => v.username).length / videoCount;
const descriptionRate = extractedVideos.filter(v => v.description).length / videoCount;
const thumbnailRate = extractedVideos.filter(v => v.thumbnail).length / videoCount;

if (videoIdRate < VIDEO_FIELD_THRESHOLDS.videoId) {
  return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VIDEO_FIELD_THRESHOLDS.videoId}` };
}
if (videoUrlRate < VIDEO_FIELD_THRESHOLDS.videoUrl) {
  return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VIDEO_FIELD_THRESHOLDS.videoUrl}` };
}
if (usernameRate < VIDEO_FIELD_THRESHOLDS.username) {
  return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VIDEO_FIELD_THRESHOLDS.username}` };
}
```

---

#### 2.2 红人字段完整度

**关键字段：**
- `username`（必须）
- `profileUrl`（必须）

**建议阈值：**
```javascript
const USER_FIELD_THRESHOLDS = {
  username: 0.95,      // 95% 的红人必须有 username
  profileUrl: 0.95     // 95% 的红人必须有 profileUrl
};
```

---

### 3. 数据质量指标（必须满足）

#### 3.1 URL 合法性验证

**验证逻辑：**
```javascript
function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / extractedData.videos.length;
  const profileUrlErrorRate = invalidProfileUrls / extractedData.users.length;
  
  if (videoUrlErrorRate > 0.05) {  // 超过 5% 的 URL 无效
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > 0.05) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}
```

---

#### 3.2 用户名格式验证

**验证逻辑：**
```javascript
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
  
  const errorRate = invalidUsernames.length / (extractedData.videos.length + extractedData.users.length);
  
  if (errorRate > 0.05) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

## 📊 综合验证函数

```javascript
function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VIDEO_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VIDEO_COUNT_THRESHOLD.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => v.username && uniqueUsernames.add(v.username));
  newResult.users.forEach(u => u.username && uniqueUsernames.add(u.username));
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < USERNAME_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${USERNAME_COUNT_THRESHOLD.minimum}`,
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
```

---

## ⚙️ 可配置的阈值参数

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
```

---

## 📝 环境变量配置示例

```bash
# .env.development
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.staging
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.production
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## 🎯 阈值设置建议讨论

### 关于"50个红人用户名"的建议

**你的建议：至少 50 个红人用户名**

**我的分析：**
- ✅ **合理**：当前能提取到 59 个，50 个是合理的下限
- ✅ **重要**：红人用户名是核心业务数据
- ✅ **严格**：50 个意味着至少 83% 的视频必须有有效的用户名

**建议调整（可选）：**
- **保守策略**：`minimum: 50`（你的建议）
- **平衡策略**：`minimum: 48`（允许少量缺失）
- **积极策略**：`minimum: 45`（允许更多容错）

**最终配置：**
```javascript
usernameCount: {
  minimum: 10,  // ⭐ 用户要求：至少 10 个（所有环境统一）
  target: 15,   // 目标值略高，给一些缓冲
  warning: 12   // 低于 12 个发出警告（但不阻止更新）
}
```

---

### 其他阈值建议

1. **视频数量：**
   - `minimum: 45`（90% 的视频）
   - 理由：允许少量视频缺失，但保证大部分数据

2. **字段完整度：**
   - `videoId/videoUrl: 0.98`（98%）
   - `username: 0.95`（95%）
   - 理由：核心字段必须高完整度

3. **数据质量：**
   - `maxUrlErrorRate: 0.05`（5%）
   - 理由：允许少量格式错误，但不允许大规模错误

---

## ✅ 最终建议

### 核心阈值（必须满足）

1. ✅ **视频数量 ≥ 45 个**
2. ✅ **红人用户名数量 ≥ 10 个** ⭐（用户要求，所有环境统一）
3. ✅ **videoId 完整度 ≥ 98%**
4. ✅ **videoUrl 完整度 ≥ 98%**
5. ✅ **username 完整度 ≥ 95%**
6. ✅ **URL 错误率 ≤ 5%**

### 可选阈值（建议满足）

1. ⚠️ **description 完整度 ≥ 80%**（警告但不阻止）
2. ⚠️ **thumbnail 完整度 ≥ 70%**（警告但不阻止）

---

## 🔄 重试机制

### 规则更新重试策略

**用户要求：未达到阈值时，重新尝试更新规则，最多不超过3次**

**实现逻辑：**
```javascript
async function updateRulesWithRetry(html, extractionResult, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      const validationResult = validateRules(html, newRules, extractionResult, 50);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功，应用新规则`);
        
        // 保存规则
        saveRules(newRules);
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { success: true, rules: newRules, attempt };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        
        // 如果不是最后一次尝试，等待一段时间后重试
        if (attempt < maxRetries) {
          const waitTime = attempt * 2000; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
  });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true  // 继续使用旧规则
  };
}
```

### 重试机制配置

```javascript
// lib/html-extraction/validation-config.js

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

### 重试流程

```
1. 检测到需要更新规则
   ↓
2. 第 1 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒
       ↓
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒
       ↓
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️
       ↓
5. 记录失败日志，发送告警
```

---

## ✅ 最终配置确认

### 1. 阈值配置（所有环境统一）

```javascript
const VALIDATION_THRESHOLDS = {
  usernameCount: {
    minimum: 10,  // ⭐ 至少 10 个不同的红人用户名（去重后）
    target: 15,
    warning: 12
  },
  videoCount: {
    minimum: 45,
    target: 50,
    warning: 48
  },
  // ... 其他阈值
};
```

### 2. 重试配置

```javascript
const RETRY_CONFIG = {
  maxRetries: 3,  // 最多重试 3 次
  retryDelay: 2000,  // 基础延迟 2 秒
};
```

### 3. 行为确认

- ✅ **所有环境统一阈值**：10 个红人用户名
- ✅ **未达到阈值时重试**：最多 3 次
- ✅ **3 次都失败**：继续使用旧规则，不中断任务
## 📋 目标

设计一套严格的验证阈值体系，确保自动更新规则时：
- ✅ 所有环境（开发/测试/生产）都允许自动更新
- ✅ 但必须达到严格的验证阈值才应用新规则
- ✅ 未达到阈值则不更新，保持使用旧规则

---

## 🎯 核心验证指标

### 1. 数量指标（必须满足）

#### 1.1 视频数量阈值

**指标：** `extractedVideos.length`

**当前情况：**
- 目标：滚动获取 50 个视频
- 实际：通常能获取 50-60 个视频

**建议阈值：**
```javascript
const VIDEO_COUNT_THRESHOLD = {
  minimum: 45,      // 至少 45 个视频（90%）
  target: 50,       // 目标 50 个视频
  warning: 48       // 低于 48 个发出警告
};
```

**验证逻辑：**
```javascript
if (extractedVideos.length < VIDEO_COUNT_THRESHOLD.minimum) {
  return { ok: false, reason: `视频数量不足: ${extractedVideos.length} < ${VIDEO_COUNT_THRESHOLD.minimum}` };
}
```

---

#### 1.2 红人用户名数量阈值 ⭐（用户重点关注的指标）

**指标：** `uniqueUsernames.size`

**当前情况：**
- 视频：60 个
- 红人用户名：59 个（去重后）

**用户要求：至少 10 个红人用户名（去重后）**

**最终阈值：**
```javascript
const USERNAME_COUNT_THRESHOLD = {
  minimum: 10,      // ⭐ 至少 10 个不同的红人用户名（用户要求）
  target: 15,       // 目标 15 个
  warning: 12       // 低于 12 个发出警告
};
```

**验证逻辑：**
```javascript
// 提取所有唯一的红人用户名
const uniqueUsernames = new Set();
extractedVideos.forEach(video => {
  if (video.username) {
    uniqueUsernames.add(video.username);
  }
});
extractedUsers.forEach(user => {
  if (user.username) {
    uniqueUsernames.add(user.username);
  }
});

if (uniqueUsernames.size < USERNAME_COUNT_THRESHOLD.minimum) {
  return { 
    ok: false, 
    reason: `红人用户名数量不足: ${uniqueUsernames.size} < ${USERNAME_COUNT_THRESHOLD.minimum}` 
  };
}
```

**为什么这个指标重要？**
- ✅ 红人用户名是核心业务数据
- ✅ 如果用户名提取失败，直接影响业务
- ✅ 比视频数量更能反映提取质量

---

### 2. 字段完整度指标（必须满足）

#### 2.1 视频字段完整度

**关键字段：**
- `videoId`（必须）
- `videoUrl`（必须）
- `username`（必须）
- `description`（重要）
- `thumbnail`（重要）

**建议阈值：**
```javascript
const VIDEO_FIELD_THRESHOLDS = {
  videoId: 0.98,        // 98% 的视频必须有 videoId
  videoUrl: 0.98,       // 98% 的视频必须有 videoUrl
  username: 0.95,       // 95% 的视频必须有 username
  description: 0.80,    // 80% 的视频必须有 description
  thumbnail: 0.70      // 70% 的视频必须有 thumbnail
};
```

**验证逻辑：**
```javascript
const videoCount = extractedVideos.length;
const videoIdRate = extractedVideos.filter(v => v.videoId).length / videoCount;
const videoUrlRate = extractedVideos.filter(v => v.videoUrl).length / videoCount;
const usernameRate = extractedVideos.filter(v => v.username).length / videoCount;
const descriptionRate = extractedVideos.filter(v => v.description).length / videoCount;
const thumbnailRate = extractedVideos.filter(v => v.thumbnail).length / videoCount;

if (videoIdRate < VIDEO_FIELD_THRESHOLDS.videoId) {
  return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VIDEO_FIELD_THRESHOLDS.videoId}` };
}
if (videoUrlRate < VIDEO_FIELD_THRESHOLDS.videoUrl) {
  return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VIDEO_FIELD_THRESHOLDS.videoUrl}` };
}
if (usernameRate < VIDEO_FIELD_THRESHOLDS.username) {
  return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VIDEO_FIELD_THRESHOLDS.username}` };
}
```

---

#### 2.2 红人字段完整度

**关键字段：**
- `username`（必须）
- `profileUrl`（必须）

**建议阈值：**
```javascript
const USER_FIELD_THRESHOLDS = {
  username: 0.95,      // 95% 的红人必须有 username
  profileUrl: 0.95     // 95% 的红人必须有 profileUrl
};
```

---

### 3. 数据质量指标（必须满足）

#### 3.1 URL 合法性验证

**验证逻辑：**
```javascript
function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / extractedData.videos.length;
  const profileUrlErrorRate = invalidProfileUrls / extractedData.users.length;
  
  if (videoUrlErrorRate > 0.05) {  // 超过 5% 的 URL 无效
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > 0.05) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}
```

---

#### 3.2 用户名格式验证

**验证逻辑：**
```javascript
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
  
  const errorRate = invalidUsernames.length / (extractedData.videos.length + extractedData.users.length);
  
  if (errorRate > 0.05) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

## 📊 综合验证函数

```javascript
function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VIDEO_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VIDEO_COUNT_THRESHOLD.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => v.username && uniqueUsernames.add(v.username));
  newResult.users.forEach(u => u.username && uniqueUsernames.add(u.username));
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < USERNAME_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${USERNAME_COUNT_THRESHOLD.minimum}`,
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
```

---

## ⚙️ 可配置的阈值参数

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
```

---

## 📝 环境变量配置示例

```bash
# .env.development
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.staging
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.production
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## 🎯 阈值设置建议讨论

### 关于"50个红人用户名"的建议

**你的建议：至少 50 个红人用户名**

**我的分析：**
- ✅ **合理**：当前能提取到 59 个，50 个是合理的下限
- ✅ **重要**：红人用户名是核心业务数据
- ✅ **严格**：50 个意味着至少 83% 的视频必须有有效的用户名

**建议调整（可选）：**
- **保守策略**：`minimum: 50`（你的建议）
- **平衡策略**：`minimum: 48`（允许少量缺失）
- **积极策略**：`minimum: 45`（允许更多容错）

**最终配置：**
```javascript
usernameCount: {
  minimum: 10,  // ⭐ 用户要求：至少 10 个（所有环境统一）
  target: 15,   // 目标值略高，给一些缓冲
  warning: 12   // 低于 12 个发出警告（但不阻止更新）
}
```

---

### 其他阈值建议

1. **视频数量：**
   - `minimum: 45`（90% 的视频）
   - 理由：允许少量视频缺失，但保证大部分数据

2. **字段完整度：**
   - `videoId/videoUrl: 0.98`（98%）
   - `username: 0.95`（95%）
   - 理由：核心字段必须高完整度

3. **数据质量：**
   - `maxUrlErrorRate: 0.05`（5%）
   - 理由：允许少量格式错误，但不允许大规模错误

---

## ✅ 最终建议

### 核心阈值（必须满足）

1. ✅ **视频数量 ≥ 45 个**
2. ✅ **红人用户名数量 ≥ 10 个** ⭐（用户要求，所有环境统一）
3. ✅ **videoId 完整度 ≥ 98%**
4. ✅ **videoUrl 完整度 ≥ 98%**
5. ✅ **username 完整度 ≥ 95%**
6. ✅ **URL 错误率 ≤ 5%**

### 可选阈值（建议满足）

1. ⚠️ **description 完整度 ≥ 80%**（警告但不阻止）
2. ⚠️ **thumbnail 完整度 ≥ 70%**（警告但不阻止）

---

## 🔄 重试机制

### 规则更新重试策略

**用户要求：未达到阈值时，重新尝试更新规则，最多不超过3次**

**实现逻辑：**
```javascript
async function updateRulesWithRetry(html, extractionResult, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      const validationResult = validateRules(html, newRules, extractionResult, 50);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功，应用新规则`);
        
        // 保存规则
        saveRules(newRules);
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { success: true, rules: newRules, attempt };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        
        // 如果不是最后一次尝试，等待一段时间后重试
        if (attempt < maxRetries) {
          const waitTime = attempt * 2000; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
  });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true  // 继续使用旧规则
  };
}
```

### 重试机制配置

```javascript
// lib/html-extraction/validation-config.js

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

### 重试流程

```
1. 检测到需要更新规则
   ↓
2. 第 1 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒
       ↓
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒
       ↓
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️
       ↓
5. 记录失败日志，发送告警
```

---

## ✅ 最终配置确认

### 1. 阈值配置（所有环境统一）

```javascript
const VALIDATION_THRESHOLDS = {
  usernameCount: {
    minimum: 10,  // ⭐ 至少 10 个不同的红人用户名（去重后）
    target: 15,
    warning: 12
  },
  videoCount: {
    minimum: 45,
    target: 50,
    warning: 48
  },
  // ... 其他阈值
};
```

### 2. 重试配置

```javascript
const RETRY_CONFIG = {
  maxRetries: 3,  // 最多重试 3 次
  retryDelay: 2000,  // 基础延迟 2 秒
};
```

### 3. 行为确认

- ✅ **所有环境统一阈值**：10 个红人用户名
- ✅ **未达到阈值时重试**：最多 3 次
- ✅ **3 次都失败**：继续使用旧规则，不中断任务
## 📋 目标

设计一套严格的验证阈值体系，确保自动更新规则时：
- ✅ 所有环境（开发/测试/生产）都允许自动更新
- ✅ 但必须达到严格的验证阈值才应用新规则
- ✅ 未达到阈值则不更新，保持使用旧规则

---

## 🎯 核心验证指标

### 1. 数量指标（必须满足）

#### 1.1 视频数量阈值

**指标：** `extractedVideos.length`

**当前情况：**
- 目标：滚动获取 50 个视频
- 实际：通常能获取 50-60 个视频

**建议阈值：**
```javascript
const VIDEO_COUNT_THRESHOLD = {
  minimum: 45,      // 至少 45 个视频（90%）
  target: 50,       // 目标 50 个视频
  warning: 48       // 低于 48 个发出警告
};
```

**验证逻辑：**
```javascript
if (extractedVideos.length < VIDEO_COUNT_THRESHOLD.minimum) {
  return { ok: false, reason: `视频数量不足: ${extractedVideos.length} < ${VIDEO_COUNT_THRESHOLD.minimum}` };
}
```

---

#### 1.2 红人用户名数量阈值 ⭐（用户重点关注的指标）

**指标：** `uniqueUsernames.size`

**当前情况：**
- 视频：60 个
- 红人用户名：59 个（去重后）

**用户要求：至少 10 个红人用户名（去重后）**

**最终阈值：**
```javascript
const USERNAME_COUNT_THRESHOLD = {
  minimum: 10,      // ⭐ 至少 10 个不同的红人用户名（用户要求）
  target: 15,       // 目标 15 个
  warning: 12       // 低于 12 个发出警告
};
```

**验证逻辑：**
```javascript
// 提取所有唯一的红人用户名
const uniqueUsernames = new Set();
extractedVideos.forEach(video => {
  if (video.username) {
    uniqueUsernames.add(video.username);
  }
});
extractedUsers.forEach(user => {
  if (user.username) {
    uniqueUsernames.add(user.username);
  }
});

if (uniqueUsernames.size < USERNAME_COUNT_THRESHOLD.minimum) {
  return { 
    ok: false, 
    reason: `红人用户名数量不足: ${uniqueUsernames.size} < ${USERNAME_COUNT_THRESHOLD.minimum}` 
  };
}
```

**为什么这个指标重要？**
- ✅ 红人用户名是核心业务数据
- ✅ 如果用户名提取失败，直接影响业务
- ✅ 比视频数量更能反映提取质量

---

### 2. 字段完整度指标（必须满足）

#### 2.1 视频字段完整度

**关键字段：**
- `videoId`（必须）
- `videoUrl`（必须）
- `username`（必须）
- `description`（重要）
- `thumbnail`（重要）

**建议阈值：**
```javascript
const VIDEO_FIELD_THRESHOLDS = {
  videoId: 0.98,        // 98% 的视频必须有 videoId
  videoUrl: 0.98,       // 98% 的视频必须有 videoUrl
  username: 0.95,       // 95% 的视频必须有 username
  description: 0.80,    // 80% 的视频必须有 description
  thumbnail: 0.70      // 70% 的视频必须有 thumbnail
};
```

**验证逻辑：**
```javascript
const videoCount = extractedVideos.length;
const videoIdRate = extractedVideos.filter(v => v.videoId).length / videoCount;
const videoUrlRate = extractedVideos.filter(v => v.videoUrl).length / videoCount;
const usernameRate = extractedVideos.filter(v => v.username).length / videoCount;
const descriptionRate = extractedVideos.filter(v => v.description).length / videoCount;
const thumbnailRate = extractedVideos.filter(v => v.thumbnail).length / videoCount;

if (videoIdRate < VIDEO_FIELD_THRESHOLDS.videoId) {
  return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VIDEO_FIELD_THRESHOLDS.videoId}` };
}
if (videoUrlRate < VIDEO_FIELD_THRESHOLDS.videoUrl) {
  return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VIDEO_FIELD_THRESHOLDS.videoUrl}` };
}
if (usernameRate < VIDEO_FIELD_THRESHOLDS.username) {
  return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VIDEO_FIELD_THRESHOLDS.username}` };
}
```

---

#### 2.2 红人字段完整度

**关键字段：**
- `username`（必须）
- `profileUrl`（必须）

**建议阈值：**
```javascript
const USER_FIELD_THRESHOLDS = {
  username: 0.95,      // 95% 的红人必须有 username
  profileUrl: 0.95     // 95% 的红人必须有 profileUrl
};
```

---

### 3. 数据质量指标（必须满足）

#### 3.1 URL 合法性验证

**验证逻辑：**
```javascript
function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / extractedData.videos.length;
  const profileUrlErrorRate = invalidProfileUrls / extractedData.users.length;
  
  if (videoUrlErrorRate > 0.05) {  // 超过 5% 的 URL 无效
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > 0.05) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}
```

---

#### 3.2 用户名格式验证

**验证逻辑：**
```javascript
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
  
  const errorRate = invalidUsernames.length / (extractedData.videos.length + extractedData.users.length);
  
  if (errorRate > 0.05) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

## 📊 综合验证函数

```javascript
function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VIDEO_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VIDEO_COUNT_THRESHOLD.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => v.username && uniqueUsernames.add(v.username));
  newResult.users.forEach(u => u.username && uniqueUsernames.add(u.username));
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < USERNAME_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${USERNAME_COUNT_THRESHOLD.minimum}`,
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
```

---

## ⚙️ 可配置的阈值参数

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
```

---

## 📝 环境变量配置示例

```bash
# .env.development
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.staging
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.production
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## 🎯 阈值设置建议讨论

### 关于"50个红人用户名"的建议

**你的建议：至少 50 个红人用户名**

**我的分析：**
- ✅ **合理**：当前能提取到 59 个，50 个是合理的下限
- ✅ **重要**：红人用户名是核心业务数据
- ✅ **严格**：50 个意味着至少 83% 的视频必须有有效的用户名

**建议调整（可选）：**
- **保守策略**：`minimum: 50`（你的建议）
- **平衡策略**：`minimum: 48`（允许少量缺失）
- **积极策略**：`minimum: 45`（允许更多容错）

**最终配置：**
```javascript
usernameCount: {
  minimum: 10,  // ⭐ 用户要求：至少 10 个（所有环境统一）
  target: 15,   // 目标值略高，给一些缓冲
  warning: 12   // 低于 12 个发出警告（但不阻止更新）
}
```

---

### 其他阈值建议

1. **视频数量：**
   - `minimum: 45`（90% 的视频）
   - 理由：允许少量视频缺失，但保证大部分数据

2. **字段完整度：**
   - `videoId/videoUrl: 0.98`（98%）
   - `username: 0.95`（95%）
   - 理由：核心字段必须高完整度

3. **数据质量：**
   - `maxUrlErrorRate: 0.05`（5%）
   - 理由：允许少量格式错误，但不允许大规模错误

---

## ✅ 最终建议

### 核心阈值（必须满足）

1. ✅ **视频数量 ≥ 45 个**
2. ✅ **红人用户名数量 ≥ 10 个** ⭐（用户要求，所有环境统一）
3. ✅ **videoId 完整度 ≥ 98%**
4. ✅ **videoUrl 完整度 ≥ 98%**
5. ✅ **username 完整度 ≥ 95%**
6. ✅ **URL 错误率 ≤ 5%**

### 可选阈值（建议满足）

1. ⚠️ **description 完整度 ≥ 80%**（警告但不阻止）
2. ⚠️ **thumbnail 完整度 ≥ 70%**（警告但不阻止）

---

## 🔄 重试机制

### 规则更新重试策略

**用户要求：未达到阈值时，重新尝试更新规则，最多不超过3次**

**实现逻辑：**
```javascript
async function updateRulesWithRetry(html, extractionResult, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      const validationResult = validateRules(html, newRules, extractionResult, 50);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功，应用新规则`);
        
        // 保存规则
        saveRules(newRules);
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { success: true, rules: newRules, attempt };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        
        // 如果不是最后一次尝试，等待一段时间后重试
        if (attempt < maxRetries) {
          const waitTime = attempt * 2000; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
  });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true  // 继续使用旧规则
  };
}
```

### 重试机制配置

```javascript
// lib/html-extraction/validation-config.js

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

### 重试流程

```
1. 检测到需要更新规则
   ↓
2. 第 1 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒
       ↓
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒
       ↓
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️
       ↓
5. 记录失败日志，发送告警
```

---

## ✅ 最终配置确认

### 1. 阈值配置（所有环境统一）

```javascript
const VALIDATION_THRESHOLDS = {
  usernameCount: {
    minimum: 10,  // ⭐ 至少 10 个不同的红人用户名（去重后）
    target: 15,
    warning: 12
  },
  videoCount: {
    minimum: 45,
    target: 50,
    warning: 48
  },
  // ... 其他阈值
};
```

### 2. 重试配置

```javascript
const RETRY_CONFIG = {
  maxRetries: 3,  // 最多重试 3 次
  retryDelay: 2000,  // 基础延迟 2 秒
};
```

### 3. 行为确认

- ✅ **所有环境统一阈值**：10 个红人用户名
- ✅ **未达到阈值时重试**：最多 3 次
- ✅ **3 次都失败**：继续使用旧规则，不中断任务
## 📋 目标

设计一套严格的验证阈值体系，确保自动更新规则时：
- ✅ 所有环境（开发/测试/生产）都允许自动更新
- ✅ 但必须达到严格的验证阈值才应用新规则
- ✅ 未达到阈值则不更新，保持使用旧规则

---

## 🎯 核心验证指标

### 1. 数量指标（必须满足）

#### 1.1 视频数量阈值

**指标：** `extractedVideos.length`

**当前情况：**
- 目标：滚动获取 50 个视频
- 实际：通常能获取 50-60 个视频

**建议阈值：**
```javascript
const VIDEO_COUNT_THRESHOLD = {
  minimum: 45,      // 至少 45 个视频（90%）
  target: 50,       // 目标 50 个视频
  warning: 48       // 低于 48 个发出警告
};
```

**验证逻辑：**
```javascript
if (extractedVideos.length < VIDEO_COUNT_THRESHOLD.minimum) {
  return { ok: false, reason: `视频数量不足: ${extractedVideos.length} < ${VIDEO_COUNT_THRESHOLD.minimum}` };
}
```

---

#### 1.2 红人用户名数量阈值 ⭐（用户重点关注的指标）

**指标：** `uniqueUsernames.size`

**当前情况：**
- 视频：60 个
- 红人用户名：59 个（去重后）

**用户要求：至少 10 个红人用户名（去重后）**

**最终阈值：**
```javascript
const USERNAME_COUNT_THRESHOLD = {
  minimum: 10,      // ⭐ 至少 10 个不同的红人用户名（用户要求）
  target: 15,       // 目标 15 个
  warning: 12       // 低于 12 个发出警告
};
```

**验证逻辑：**
```javascript
// 提取所有唯一的红人用户名
const uniqueUsernames = new Set();
extractedVideos.forEach(video => {
  if (video.username) {
    uniqueUsernames.add(video.username);
  }
});
extractedUsers.forEach(user => {
  if (user.username) {
    uniqueUsernames.add(user.username);
  }
});

if (uniqueUsernames.size < USERNAME_COUNT_THRESHOLD.minimum) {
  return { 
    ok: false, 
    reason: `红人用户名数量不足: ${uniqueUsernames.size} < ${USERNAME_COUNT_THRESHOLD.minimum}` 
  };
}
```

**为什么这个指标重要？**
- ✅ 红人用户名是核心业务数据
- ✅ 如果用户名提取失败，直接影响业务
- ✅ 比视频数量更能反映提取质量

---

### 2. 字段完整度指标（必须满足）

#### 2.1 视频字段完整度

**关键字段：**
- `videoId`（必须）
- `videoUrl`（必须）
- `username`（必须）
- `description`（重要）
- `thumbnail`（重要）

**建议阈值：**
```javascript
const VIDEO_FIELD_THRESHOLDS = {
  videoId: 0.98,        // 98% 的视频必须有 videoId
  videoUrl: 0.98,       // 98% 的视频必须有 videoUrl
  username: 0.95,       // 95% 的视频必须有 username
  description: 0.80,    // 80% 的视频必须有 description
  thumbnail: 0.70      // 70% 的视频必须有 thumbnail
};
```

**验证逻辑：**
```javascript
const videoCount = extractedVideos.length;
const videoIdRate = extractedVideos.filter(v => v.videoId).length / videoCount;
const videoUrlRate = extractedVideos.filter(v => v.videoUrl).length / videoCount;
const usernameRate = extractedVideos.filter(v => v.username).length / videoCount;
const descriptionRate = extractedVideos.filter(v => v.description).length / videoCount;
const thumbnailRate = extractedVideos.filter(v => v.thumbnail).length / videoCount;

if (videoIdRate < VIDEO_FIELD_THRESHOLDS.videoId) {
  return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VIDEO_FIELD_THRESHOLDS.videoId}` };
}
if (videoUrlRate < VIDEO_FIELD_THRESHOLDS.videoUrl) {
  return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VIDEO_FIELD_THRESHOLDS.videoUrl}` };
}
if (usernameRate < VIDEO_FIELD_THRESHOLDS.username) {
  return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VIDEO_FIELD_THRESHOLDS.username}` };
}
```

---

#### 2.2 红人字段完整度

**关键字段：**
- `username`（必须）
- `profileUrl`（必须）

**建议阈值：**
```javascript
const USER_FIELD_THRESHOLDS = {
  username: 0.95,      // 95% 的红人必须有 username
  profileUrl: 0.95     // 95% 的红人必须有 profileUrl
};
```

---

### 3. 数据质量指标（必须满足）

#### 3.1 URL 合法性验证

**验证逻辑：**
```javascript
function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / extractedData.videos.length;
  const profileUrlErrorRate = invalidProfileUrls / extractedData.users.length;
  
  if (videoUrlErrorRate > 0.05) {  // 超过 5% 的 URL 无效
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > 0.05) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}
```

---

#### 3.2 用户名格式验证

**验证逻辑：**
```javascript
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
  
  const errorRate = invalidUsernames.length / (extractedData.videos.length + extractedData.users.length);
  
  if (errorRate > 0.05) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

## 📊 综合验证函数

```javascript
function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VIDEO_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VIDEO_COUNT_THRESHOLD.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => v.username && uniqueUsernames.add(v.username));
  newResult.users.forEach(u => u.username && uniqueUsernames.add(u.username));
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < USERNAME_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${USERNAME_COUNT_THRESHOLD.minimum}`,
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
```

---

## ⚙️ 可配置的阈值参数

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
```

---

## 📝 环境变量配置示例

```bash
# .env.development
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.staging
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.production
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## 🎯 阈值设置建议讨论

### 关于"50个红人用户名"的建议

**你的建议：至少 50 个红人用户名**

**我的分析：**
- ✅ **合理**：当前能提取到 59 个，50 个是合理的下限
- ✅ **重要**：红人用户名是核心业务数据
- ✅ **严格**：50 个意味着至少 83% 的视频必须有有效的用户名

**建议调整（可选）：**
- **保守策略**：`minimum: 50`（你的建议）
- **平衡策略**：`minimum: 48`（允许少量缺失）
- **积极策略**：`minimum: 45`（允许更多容错）

**最终配置：**
```javascript
usernameCount: {
  minimum: 10,  // ⭐ 用户要求：至少 10 个（所有环境统一）
  target: 15,   // 目标值略高，给一些缓冲
  warning: 12   // 低于 12 个发出警告（但不阻止更新）
}
```

---

### 其他阈值建议

1. **视频数量：**
   - `minimum: 45`（90% 的视频）
   - 理由：允许少量视频缺失，但保证大部分数据

2. **字段完整度：**
   - `videoId/videoUrl: 0.98`（98%）
   - `username: 0.95`（95%）
   - 理由：核心字段必须高完整度

3. **数据质量：**
   - `maxUrlErrorRate: 0.05`（5%）
   - 理由：允许少量格式错误，但不允许大规模错误

---

## ✅ 最终建议

### 核心阈值（必须满足）

1. ✅ **视频数量 ≥ 45 个**
2. ✅ **红人用户名数量 ≥ 10 个** ⭐（用户要求，所有环境统一）
3. ✅ **videoId 完整度 ≥ 98%**
4. ✅ **videoUrl 完整度 ≥ 98%**
5. ✅ **username 完整度 ≥ 95%**
6. ✅ **URL 错误率 ≤ 5%**

### 可选阈值（建议满足）

1. ⚠️ **description 完整度 ≥ 80%**（警告但不阻止）
2. ⚠️ **thumbnail 完整度 ≥ 70%**（警告但不阻止）

---

## 🔄 重试机制

### 规则更新重试策略

**用户要求：未达到阈值时，重新尝试更新规则，最多不超过3次**

**实现逻辑：**
```javascript
async function updateRulesWithRetry(html, extractionResult, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      const validationResult = validateRules(html, newRules, extractionResult, 50);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功，应用新规则`);
        
        // 保存规则
        saveRules(newRules);
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { success: true, rules: newRules, attempt };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        
        // 如果不是最后一次尝试，等待一段时间后重试
        if (attempt < maxRetries) {
          const waitTime = attempt * 2000; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
  });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true  // 继续使用旧规则
  };
}
```

### 重试机制配置

```javascript
// lib/html-extraction/validation-config.js

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

### 重试流程

```
1. 检测到需要更新规则
   ↓
2. 第 1 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒
       ↓
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒
       ↓
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️
       ↓
5. 记录失败日志，发送告警
```

---

## ✅ 最终配置确认

### 1. 阈值配置（所有环境统一）

```javascript
const VALIDATION_THRESHOLDS = {
  usernameCount: {
    minimum: 10,  // ⭐ 至少 10 个不同的红人用户名（去重后）
    target: 15,
    warning: 12
  },
  videoCount: {
    minimum: 45,
    target: 50,
    warning: 48
  },
  // ... 其他阈值
};
```

### 2. 重试配置

```javascript
const RETRY_CONFIG = {
  maxRetries: 3,  // 最多重试 3 次
  retryDelay: 2000,  // 基础延迟 2 秒
};
```

### 3. 行为确认

- ✅ **所有环境统一阈值**：10 个红人用户名
- ✅ **未达到阈值时重试**：最多 3 次
- ✅ **3 次都失败**：继续使用旧规则，不中断任务
## 📋 目标

设计一套严格的验证阈值体系，确保自动更新规则时：
- ✅ 所有环境（开发/测试/生产）都允许自动更新
- ✅ 但必须达到严格的验证阈值才应用新规则
- ✅ 未达到阈值则不更新，保持使用旧规则

---

## 🎯 核心验证指标

### 1. 数量指标（必须满足）

#### 1.1 视频数量阈值

**指标：** `extractedVideos.length`

**当前情况：**
- 目标：滚动获取 50 个视频
- 实际：通常能获取 50-60 个视频

**建议阈值：**
```javascript
const VIDEO_COUNT_THRESHOLD = {
  minimum: 45,      // 至少 45 个视频（90%）
  target: 50,       // 目标 50 个视频
  warning: 48       // 低于 48 个发出警告
};
```

**验证逻辑：**
```javascript
if (extractedVideos.length < VIDEO_COUNT_THRESHOLD.minimum) {
  return { ok: false, reason: `视频数量不足: ${extractedVideos.length} < ${VIDEO_COUNT_THRESHOLD.minimum}` };
}
```

---

#### 1.2 红人用户名数量阈值 ⭐（用户重点关注的指标）

**指标：** `uniqueUsernames.size`

**当前情况：**
- 视频：60 个
- 红人用户名：59 个（去重后）

**用户要求：至少 10 个红人用户名（去重后）**

**最终阈值：**
```javascript
const USERNAME_COUNT_THRESHOLD = {
  minimum: 10,      // ⭐ 至少 10 个不同的红人用户名（用户要求）
  target: 15,       // 目标 15 个
  warning: 12       // 低于 12 个发出警告
};
```

**验证逻辑：**
```javascript
// 提取所有唯一的红人用户名
const uniqueUsernames = new Set();
extractedVideos.forEach(video => {
  if (video.username) {
    uniqueUsernames.add(video.username);
  }
});
extractedUsers.forEach(user => {
  if (user.username) {
    uniqueUsernames.add(user.username);
  }
});

if (uniqueUsernames.size < USERNAME_COUNT_THRESHOLD.minimum) {
  return { 
    ok: false, 
    reason: `红人用户名数量不足: ${uniqueUsernames.size} < ${USERNAME_COUNT_THRESHOLD.minimum}` 
  };
}
```

**为什么这个指标重要？**
- ✅ 红人用户名是核心业务数据
- ✅ 如果用户名提取失败，直接影响业务
- ✅ 比视频数量更能反映提取质量

---

### 2. 字段完整度指标（必须满足）

#### 2.1 视频字段完整度

**关键字段：**
- `videoId`（必须）
- `videoUrl`（必须）
- `username`（必须）
- `description`（重要）
- `thumbnail`（重要）

**建议阈值：**
```javascript
const VIDEO_FIELD_THRESHOLDS = {
  videoId: 0.98,        // 98% 的视频必须有 videoId
  videoUrl: 0.98,       // 98% 的视频必须有 videoUrl
  username: 0.95,       // 95% 的视频必须有 username
  description: 0.80,    // 80% 的视频必须有 description
  thumbnail: 0.70      // 70% 的视频必须有 thumbnail
};
```

**验证逻辑：**
```javascript
const videoCount = extractedVideos.length;
const videoIdRate = extractedVideos.filter(v => v.videoId).length / videoCount;
const videoUrlRate = extractedVideos.filter(v => v.videoUrl).length / videoCount;
const usernameRate = extractedVideos.filter(v => v.username).length / videoCount;
const descriptionRate = extractedVideos.filter(v => v.description).length / videoCount;
const thumbnailRate = extractedVideos.filter(v => v.thumbnail).length / videoCount;

if (videoIdRate < VIDEO_FIELD_THRESHOLDS.videoId) {
  return { ok: false, reason: `videoId 完整度不足: ${videoIdRate} < ${VIDEO_FIELD_THRESHOLDS.videoId}` };
}
if (videoUrlRate < VIDEO_FIELD_THRESHOLDS.videoUrl) {
  return { ok: false, reason: `videoUrl 完整度不足: ${videoUrlRate} < ${VIDEO_FIELD_THRESHOLDS.videoUrl}` };
}
if (usernameRate < VIDEO_FIELD_THRESHOLDS.username) {
  return { ok: false, reason: `username 完整度不足: ${usernameRate} < ${VIDEO_FIELD_THRESHOLDS.username}` };
}
```

---

#### 2.2 红人字段完整度

**关键字段：**
- `username`（必须）
- `profileUrl`（必须）

**建议阈值：**
```javascript
const USER_FIELD_THRESHOLDS = {
  username: 0.95,      // 95% 的红人必须有 username
  profileUrl: 0.95     // 95% 的红人必须有 profileUrl
};
```

---

### 3. 数据质量指标（必须满足）

#### 3.1 URL 合法性验证

**验证逻辑：**
```javascript
function validateUrls(extractedData) {
  const videoUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/;
  const profileUrlPattern = /^https:\/\/www\.tiktok\.com\/@[^/]+$/;
  
  const invalidVideoUrls = extractedData.videos.filter(v => 
    v.videoUrl && !videoUrlPattern.test(v.videoUrl)
  ).length;
  
  const invalidProfileUrls = extractedData.users.filter(u => 
    u.profileUrl && !profileUrlPattern.test(u.profileUrl)
  ).length;
  
  const videoUrlErrorRate = invalidVideoUrls / extractedData.videos.length;
  const profileUrlErrorRate = invalidProfileUrls / extractedData.users.length;
  
  if (videoUrlErrorRate > 0.05) {  // 超过 5% 的 URL 无效
    return { ok: false, reason: `视频 URL 错误率过高: ${videoUrlErrorRate}` };
  }
  
  if (profileUrlErrorRate > 0.05) {
    return { ok: false, reason: `红人 URL 错误率过高: ${profileUrlErrorRate}` };
  }
  
  return { ok: true };
}
```

---

#### 3.2 用户名格式验证

**验证逻辑：**
```javascript
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
  
  const errorRate = invalidUsernames.length / (extractedData.videos.length + extractedData.users.length);
  
  if (errorRate > 0.05) {
    return { ok: false, reason: `用户名格式错误率过高: ${errorRate}` };
  }
  
  return { ok: true };
}
```

---

## 📊 综合验证函数

```javascript
function validateRules(html, newRules, baselineResult, expectedVideoCount = 50) {
  // 1. 用新规则提取数据
  const newResult = extractWithRules(html, newRules);
  
  // 2. 数量指标验证
  const videoCount = newResult.videos.length;
  if (videoCount < VIDEO_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `视频数量不足: ${videoCount} < ${VIDEO_COUNT_THRESHOLD.minimum}`,
      metrics: { videoCount }
    };
  }
  
  // 3. 红人用户名数量验证 ⭐（用户重点关注）
  const uniqueUsernames = new Set();
  newResult.videos.forEach(v => v.username && uniqueUsernames.add(v.username));
  newResult.users.forEach(u => u.username && uniqueUsernames.add(u.username));
  
  const usernameCount = uniqueUsernames.size;
  if (usernameCount < USERNAME_COUNT_THRESHOLD.minimum) {
    return { 
      ok: false, 
      reason: `红人用户名数量不足: ${usernameCount} < ${USERNAME_COUNT_THRESHOLD.minimum}`,
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
```

---

## ⚙️ 可配置的阈值参数

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
```

---

## 📝 环境变量配置示例

```bash
# .env.development
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.staging
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95

# .env.production
RULES_MIN_VIDEO_COUNT=45
RULES_MIN_USERNAME_COUNT=10  # ⭐ 用户要求：至少 10 个（所有环境统一）
RULES_VIDEO_ID_RATE=0.98
RULES_VIDEO_URL_RATE=0.98
RULES_VIDEO_USERNAME_RATE=0.95
```

---

## 🎯 阈值设置建议讨论

### 关于"50个红人用户名"的建议

**你的建议：至少 50 个红人用户名**

**我的分析：**
- ✅ **合理**：当前能提取到 59 个，50 个是合理的下限
- ✅ **重要**：红人用户名是核心业务数据
- ✅ **严格**：50 个意味着至少 83% 的视频必须有有效的用户名

**建议调整（可选）：**
- **保守策略**：`minimum: 50`（你的建议）
- **平衡策略**：`minimum: 48`（允许少量缺失）
- **积极策略**：`minimum: 45`（允许更多容错）

**最终配置：**
```javascript
usernameCount: {
  minimum: 10,  // ⭐ 用户要求：至少 10 个（所有环境统一）
  target: 15,   // 目标值略高，给一些缓冲
  warning: 12   // 低于 12 个发出警告（但不阻止更新）
}
```

---

### 其他阈值建议

1. **视频数量：**
   - `minimum: 45`（90% 的视频）
   - 理由：允许少量视频缺失，但保证大部分数据

2. **字段完整度：**
   - `videoId/videoUrl: 0.98`（98%）
   - `username: 0.95`（95%）
   - 理由：核心字段必须高完整度

3. **数据质量：**
   - `maxUrlErrorRate: 0.05`（5%）
   - 理由：允许少量格式错误，但不允许大规模错误

---

## ✅ 最终建议

### 核心阈值（必须满足）

1. ✅ **视频数量 ≥ 45 个**
2. ✅ **红人用户名数量 ≥ 10 个** ⭐（用户要求，所有环境统一）
3. ✅ **videoId 完整度 ≥ 98%**
4. ✅ **videoUrl 完整度 ≥ 98%**
5. ✅ **username 完整度 ≥ 95%**
6. ✅ **URL 错误率 ≤ 5%**

### 可选阈值（建议满足）

1. ⚠️ **description 完整度 ≥ 80%**（警告但不阻止）
2. ⚠️ **thumbnail 完整度 ≥ 70%**（警告但不阻止）

---

## 🔄 重试机制

### 规则更新重试策略

**用户要求：未达到阈值时，重新尝试更新规则，最多不超过3次**

**实现逻辑：**
```javascript
async function updateRulesWithRetry(html, extractionResult, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[规则更新] 尝试第 ${attempt}/${maxRetries} 次...`);
    
    try {
      // 1. LLM 生成新规则
      const newRules = await generateRulesFromHTML(html);
      
      // 2. 验证新规则
      const validationResult = validateRules(html, newRules, extractionResult, 50);
      
      if (validationResult.ok) {
        console.log(`[规则更新] ✅ 第 ${attempt} 次尝试成功，应用新规则`);
        
        // 保存规则
        saveRules(newRules);
        auditRuleChange('update', {
          attempt,
          ruleVersion: newRules.version,
          metrics: validationResult.metrics,
        });
        
        return { success: true, rules: newRules, attempt };
      } else {
        lastError = validationResult;
        console.warn(`[规则更新] ⚠️ 第 ${attempt} 次尝试失败: ${validationResult.reason}`);
        
        // 如果不是最后一次尝试，等待一段时间后重试
        if (attempt < maxRetries) {
          const waitTime = attempt * 2000; // 递增等待时间：2s, 4s, 6s
          console.log(`[规则更新] 等待 ${waitTime}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } catch (error) {
      lastError = { ok: false, reason: error.message };
      console.error(`[规则更新] ❌ 第 ${attempt} 次尝试出错:`, error);
      
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // 3次都失败，继续使用旧规则
  console.error(`[规则更新] ❌ ${maxRetries} 次尝试均失败，继续使用旧规则`);
  console.error(`[规则更新] 最后失败原因: ${lastError?.reason || '未知错误'}`);
  
  auditRuleChange('update_failed', {
    attempts: maxRetries,
    lastError: lastError?.reason,
  });
  
  return { 
    success: false, 
    attempts: maxRetries, 
    lastError: lastError?.reason,
    continueWithOldRules: true  // 继续使用旧规则
  };
}
```

### 重试机制配置

```javascript
// lib/html-extraction/validation-config.js

export const RETRY_CONFIG = {
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
  retryDelayMultiplier: parseFloat(process.env.RULES_RETRY_DELAY_MULTIPLIER || '1.0'),  // 延迟倍数
};
```

### 重试流程

```
1. 检测到需要更新规则
   ↓
2. 第 1 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒
       ↓
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒
       ↓
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️
       ↓
5. 记录失败日志，发送告警
```

---

## ✅ 最终配置确认

### 1. 阈值配置（所有环境统一）

```javascript
const VALIDATION_THRESHOLDS = {
  usernameCount: {
    minimum: 10,  // ⭐ 至少 10 个不同的红人用户名（去重后）
    target: 15,
    warning: 12
  },
  videoCount: {
    minimum: 45,
    target: 50,
    warning: 48
  },
  // ... 其他阈值
};
```

### 2. 重试配置

```javascript
const RETRY_CONFIG = {
  maxRetries: 3,  // 最多重试 3 次
  retryDelay: 2000,  // 基础延迟 2 秒
};
```

### 3. 行为确认

- ✅ **所有环境统一阈值**：10 个红人用户名
- ✅ **未达到阈值时重试**：最多 3 次
- ✅ **3 次都失败**：继续使用旧规则，不中断任务