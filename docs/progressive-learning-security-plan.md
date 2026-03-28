# 渐进式学习方案：生产环境安全与权限控制

## 📋 目录

1. [安全风险分析](#安全风险分析)
2. [权限控制方案](#权限控制方案)
3. [环境隔离策略](#环境隔离策略)
4. [审计与日志](#审计与日志)
5. [回滚机制](#回滚机制)
6. [实施建议](#实施建议)

---

## 🔒 安全风险分析

### 1. 文件系统权限风险

**问题：**
- 生产环境可能运行在受限用户下（如 `www-data`, `nobody`）
- 可能没有写入 `.cache/` 目录的权限
- Docker 容器可能挂载只读文件系统

**风险等级：** ⚠️ **高**

### 2. LLM 生成内容安全风险

**问题：**
- LLM 可能生成恶意代码（如果走路径B：生成 JavaScript）
- JSON 规则可能包含路径遍历攻击（`../../etc/passwd`）
- 规则可能被注入恶意正则表达式（ReDoS 攻击）

**风险等级：** ⚠️ **高**

### 3. 规则覆盖风险

**问题：**
- 新规则可能覆盖已验证的旧规则
- 规则文件可能被外部修改
- 没有版本控制，无法追溯变更

**风险等级：** ⚠️ **中**

### 4. 环境混淆风险

**问题：**
- 测试环境的规则可能被应用到生产环境
- 生产环境的规则可能被测试环境覆盖

**风险等级：** ⚠️ **高**

---

## 🔐 权限控制方案

### 方案 A：基于环境变量的权限控制（推荐）

```javascript
// lib/html-extraction/rules-manager.js

const RULES_CONFIG = {
  // 规则存储路径（按环境区分）
  rulesDir: process.env.RULES_CACHE_DIR || path.join(projectRoot, '.cache/rules'),
  
  // 是否允许自动更新规则（所有环境都允许）
  allowAutoUpdate: process.env.ALLOW_RULES_AUTO_UPDATE !== 'false',  // 默认允许
  
  // 是否允许写入规则文件（所有环境都允许）
  allowWriteRules: process.env.ALLOW_RULES_WRITE !== 'false',  // 默认允许
  
  // 当前环境
  environment: process.env.NODE_ENV || 'development',
  
  // 规则文件权限
  rulesFileMode: 0o644,
  
  // 重试配置
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
};

// 权限检查函数
function checkWritePermission() {
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  // 检查目录权限
  try {
    fs.accessSync(RULES_CONFIG.rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${RULES_CONFIG.rulesDir}`);
  }
}
```

**环境变量配置（所有环境统一）：**

```bash
# .env.development（开发环境）
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.staging（测试环境）
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.production（生产环境）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新（用户要求）
ALLOW_RULES_WRITE=true       # ✅ 允许写入（用户要求）
RULES_CACHE_DIR=/app/data/rules  # 使用持久化存储
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名（所有环境统一）
```

### 方案 B：基于数据库的规则存储（更安全）

如果文件系统不可写，可以将规则存储在数据库中：

```javascript
// lib/html-extraction/rules-db.js

const RULES_TABLE = 'tiktok_extraction_rules';

async function loadRulesFromDB(environment) {
  const [rows] = await query(
    `SELECT rules_json, version, created_at 
     FROM ${RULES_TABLE} 
     WHERE environment = ? AND is_active = 1 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [environment]
  );
  
  return rows[0] ? JSON.parse(rows[0].rules_json) : getDefaultRules();
}

async function saveRulesToDB(rules, environment, userId = null) {
  // 1. 验证规则
  if (!validateRules(rules)) {
    throw new Error('规则验证失败');
  }
  
  // 2. 插入新规则（不删除旧规则，用于回滚）
  await query(
    `INSERT INTO ${RULES_TABLE} 
     (environment, rules_json, version, created_by, created_at, is_active) 
     VALUES (?, ?, ?, ?, NOW(), 0)`,
    [environment, JSON.stringify(rules), generateVersion(), userId]
  );
  
  // 3. 标记为待审核（生产环境需要人工审核）
  if (environment === 'production') {
    await query(
      `UPDATE ${RULES_TABLE} SET status = 'pending_review' WHERE id = LAST_INSERT_ID()`
    );
  } else {
    // 测试环境自动激活
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 1, status = 'active' WHERE id = LAST_INSERT_ID()`
    );
    // 停用旧规则
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 0 WHERE environment = ? AND id != LAST_INSERT_ID()`,
      [environment]
    );
  }
}
```

**数据库表结构：**

```sql
CREATE TABLE tiktok_extraction_rules (
  id INT PRIMARY KEY AUTO_INCREMENT,
  environment ENUM('development', 'staging', 'production') NOT NULL,
  rules_json TEXT NOT NULL,
  version VARCHAR(50) NOT NULL,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 0,
  status ENUM('pending_review', 'active', 'rejected', 'deprecated') DEFAULT 'pending_review',
  review_notes TEXT,
  INDEX idx_env_active (environment, is_active),
  INDEX idx_env_status (environment, status)
);
```

---

## 🌍 环境隔离策略

### 1. 规则文件隔离

```
.cache/rules/
├── development/
│   ├── tiktok-rules-v1.0.json
│   ├── tiktok-rules-v1.1.json
│   └── current -> tiktok-rules-v1.1.json  (符号链接)
├── staging/
│   └── tiktok-rules-v1.0.json
└── production/
    └── tiktok-rules-v1.0.json  (只读，需手动更新)
```

### 2. 环境检测与隔离

```javascript
function getRulesPath() {
  const env = process.env.NODE_ENV || 'development';
  const rulesDir = path.join(
    RULES_CONFIG.rulesDir,
    env  // 按环境隔离
  );
  
  // 确保目录存在
  fs.mkdirSync(rulesDir, { recursive: true });
  
  return path.join(rulesDir, 'tiktok-rules-current.json');
}

function loadRules() {
  const rulesPath = getRulesPath();
  
  // 生产环境：如果文件不存在，使用默认规则（不允许自动创建）
  if (RULES_CONFIG.environment === 'production' && !fs.existsSync(rulesPath)) {
    console.warn('[规则] 生产环境未找到规则文件，使用默认规则');
    return getDefaultRules();
  }
  
  // 其他环境：如果文件不存在，创建默认规则
  if (!fs.existsSync(rulesPath)) {
    const defaultRules = getDefaultRules();
    saveRules(defaultRules);  // 自动创建
    return defaultRules;
  }
  
  return JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
}
```

---

## 📝 审计与日志

### 1. 规则变更审计日志

```javascript
// lib/html-extraction/rules-audit.js

const AUDIT_LOG_PATH = path.join(projectRoot, 'logs/rules-audit.log');

function auditRuleChange(action, details) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    environment: RULES_CONFIG.environment,
    action,  // 'create', 'update', 'delete', 'rollback'
    details,
    user: process.env.USER || 'system',
    hostname: require('os').hostname(),
  };
  
  // 写入日志文件
  fs.appendFileSync(
    AUDIT_LOG_PATH,
    JSON.stringify(logEntry) + '\n',
    'utf-8'
  );
  
  // 生产环境：同时写入数据库（如果可用）
  if (RULES_CONFIG.environment === 'production') {
    saveAuditToDB(logEntry).catch(err => {
      console.error('[审计] 写入数据库失败:', err);
    });
  }
}
```

### 2. 规则验证日志

```javascript
async function updateRulesIfNeeded(html, extractionResult) {
  if (!shouldTriggerRuleUpdate(extractionResult, 50)) return;
  
  console.log('[规则更新] 检测到提取成功率低，触发 LLM 学习...');
  
  const newRules = await generateRulesFromHTML(html);
  const validationResult = validateRules(html, newRules, extractionResult, 50);
  
  // 记录验证结果
  auditRuleChange('validate', {
    success: validationResult.ok,
    metrics: validationResult.metrics,
    ruleVersion: newRules.version,
  });
  
  if (!validationResult.ok) {
    console.warn('[规则更新] 新规则验证失败，保持使用当前规则');
    return;
  }
  
  // 保存规则（会触发权限检查）
  try {
    saveRules(newRules);
    auditRuleChange('update', {
      ruleVersion: newRules.version,
      metrics: validationResult.metrics,
    });
  } catch (e) {
    auditRuleChange('update_failed', {
      error: e.message,
      ruleVersion: newRules.version,
    });
    throw e;
  }
}
```

---

## 🔄 回滚机制

### 1. 版本化规则存储

```javascript
function saveRules(rules) {
  checkWritePermission();  // 权限检查
  
  const rulesPath = getRulesPath();
  const version = rules.version || generateVersion();
  
  // 1. 保存版本化文件
  const versionedPath = rulesPath.replace('current.json', `v${version}.json`);
  fs.writeFileSync(versionedPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 2. 更新 current.json（符号链接或直接复制）
  if (RULES_CONFIG.environment === 'production') {
    // 生产环境：创建备份后再更新
    const backupPath = `${rulesPath}.backup.${Date.now()}`;
    if (fs.existsSync(rulesPath)) {
      fs.copyFileSync(rulesPath, backupPath);
    }
  }
  
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 3. 记录变更
  auditRuleChange('update', { version });
}

function rollbackRules(targetVersion) {
  checkWritePermission();
  
  const rulesPath = getRulesPath();
  const versionedPath = rulesPath.replace('current.json', `v${targetVersion}.json`);
  
  if (!fs.existsSync(versionedPath)) {
    throw new Error(`版本 ${targetVersion} 不存在`);
  }
  
  const rules = JSON.parse(fs.readFileSync(versionedPath, 'utf-8'));
  saveRules(rules);
  
  auditRuleChange('rollback', { targetVersion });
}
```

### 2. 自动回滚机制

```javascript
async function updateRulesWithAutoRollback(html, extractionResult) {
  const currentRules = loadRules();
  const currentVersion = currentRules.version;
  
  try {
    await updateRulesIfNeeded(html, extractionResult);
    
    // 验证新规则（运行一次完整提取）
    const testResult = extractWithRules(html, loadRules());
    if (!validateRules(html, loadRules(), testResult, 50).ok) {
      throw new Error('新规则验证失败');
    }
  } catch (e) {
    console.error('[规则更新] 自动回滚到版本:', currentVersion);
    
    // 回滚到之前的版本
    rollbackRules(currentVersion);
    
    auditRuleChange('auto_rollback', {
      error: e.message,
      rolledBackTo: currentVersion,
    });
    
    throw e;
  }
}
```

---

## 🛡️ 安全验证

### 1. 规则内容安全验证

```javascript
function validateRuleSecurity(rules) {
  const issues = [];
  
  // 1. 检查 JSON 结构合法性
  if (!rules.video || !rules.user) {
    issues.push('规则结构不完整');
  }
  
  // 2. 检查正则表达式安全性（防止 ReDoS）
  function checkRegexSafety(pattern) {
    // 简单检查：避免嵌套量词
    if (/(\*|\+|\?|\{.*,.*\}).*\1/.test(pattern)) {
      issues.push(`潜在 ReDoS 风险的正则: ${pattern}`);
    }
  }
  
  // 3. 检查路径遍历攻击
  function checkPathTraversal(value) {
    if (typeof value === 'string' && value.includes('../')) {
      issues.push(`潜在路径遍历攻击: ${value}`);
    }
  }
  
  // 递归检查所有字符串值
  function traverse(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        checkPathTraversal(value);
        if (key === 'pattern' || key.includes('regex')) {
          checkRegexSafety(value);
        }
      } else if (typeof value === 'object' && value !== null) {
        traverse(value);
      }
    }
  }
  
  traverse(rules);
  
  if (issues.length > 0) {
    throw new Error(`规则安全验证失败:\n${issues.join('\n')}`);
  }
  
  return true;
}
```

### 2. LLM 输出内容验证

```javascript
async function generateRulesFromHTML(html) {
  const response = await callDeepSeekLLM([...], systemPrompt);
  
  // 1. 提取 JSON（移除 markdown 代码块）
  let jsonStr = extractJSON(response);
  
  // 2. 解析 JSON
  let rules;
  try {
    rules = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`LLM 返回的不是有效 JSON: ${e.message}`);
  }
  
  // 3. 安全验证
  validateRuleSecurity(rules);
  
  // 4. 结构验证
  if (!rules.video || !rules.user) {
    throw new Error('规则缺少必要字段');
  }
  
  // 5. 添加元数据
  rules.version = generateVersion();
  rules.generatedAt = new Date().toISOString();
  rules.environment = RULES_CONFIG.environment;
  
  return rules;
}
```

---

## ✅ 实施建议

### 环境自动更新策略对比

| 环境 | 自动更新 | 验证要求 | 回滚机制 | 推荐场景 |
|------|---------|---------|---------|---------|
| **开发环境** | ✅ **强烈推荐** | 基础验证 | 自动回滚 | 快速迭代，频繁测试 |
| **测试环境** | ⚠️ **条件推荐** | 严格验证 + 人工确认 | 自动回滚 + 告警 | 验证新规则稳定性 |
| **生产环境** | ❌ **不推荐** | 人工审核 + 灰度发布 | 快速回滚 + 监控 | 稳定性优先 |

---

### 阶段 1：开发环境（立即实施）

**策略：完全自动更新**

1. ✅ 实现文件系统规则存储
2. ✅ 添加权限检查（基于环境变量）
3. ✅ 实现审计日志
4. ✅ 实现版本化存储

**配置：**
```bash
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发更新
```

**优点：**
- 快速适应 TikTok 改版
- 减少人工维护成本
- 适合频繁测试

---

### 阶段 2：测试环境（1-2周后）

**策略：条件自动更新（推荐）**

**方案 A：保守策略（推荐用于关键业务）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.3  # 成功率 < 30% 才触发
RULES_REQUIRE_MANUAL_CONFIRM=true  # 需要人工确认
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**方案 B：积极策略（推荐用于快速迭代）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发
RULES_REQUIRE_MANUAL_CONFIRM=false  # 自动应用
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**实现要点：**
1. ✅ 更严格的验证（成功率 > 80% 才应用）
2. ✅ 自动回滚（验证失败立即回滚）
3. ✅ 通知机制（Slack/邮件通知规则变更）
4. ✅ 可选人工确认（关键业务建议开启）

**建议：**
- **如果你的测试环境用于验证生产前准备**：使用方案 A（保守）
- **如果你的测试环境用于快速迭代**：使用方案 B（积极）

---

### 阶段 3：生产环境（1个月后）

**策略：禁止自动更新（强烈推荐）**

**配置：**
```bash
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false  # 🔒 禁止自动更新
ALLOW_RULES_WRITE=false        # 🔒 禁止写入
RULES_REQUIRE_MANUAL_DEPLOY=true  # 必须手动部署
```

**更新流程（所有环境统一）：**
```
1. 检测到去重后的用户名数量 < 10 → 触发规则更新
2. 第 1 次尝试：LLM 生成规则 → 验证（至少 10 个红人用户名）
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒后重试
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒后重试
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️（记录日志，发送告警）
```

**关键点：**
- ✅ **触发条件**：去重后的用户名数量 < 10
- ✅ 所有环境都允许自动更新
- ✅ 必须达到验证阈值（至少 10 个红人用户名）才应用
- ✅ 未达到阈值时重试最多 3 次
- ✅ 3 次都失败则继续使用旧规则，不中断任务

**例外情况：紧急自动更新（不推荐，但可配置）**

如果 TikTok 突然大规模改版，导致提取完全失败，可以配置紧急模式：

```bash
# 紧急模式（仅在极端情况下启用）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_EMERGENCY_UPDATE=true  # 紧急更新开关
RULES_EMERGENCY_THRESHOLD=0.1      # 成功率 < 10% 才触发
RULES_EMERGENCY_REQUIRE_ADMIN=true # 需要管理员确认
```

**紧急更新流程：**
```
1. 检测到成功率 < 10%（严重失败）
2. 发送紧急告警（电话/短信）
3. 等待管理员确认（5分钟内）
4. 如果确认 → LLM 生成新规则 → 严格验证 → 应用
5. 如果未确认 → 保持旧规则，继续告警
```

---

## 🤔 是否建议测试和生产环境自动更新？

### 测试环境：条件推荐 ✅

**推荐自动更新的理由：**
1. ✅ **快速验证**：TikTok 改版后，测试环境可以快速适应
2. ✅ **降低维护成本**：减少人工干预
3. ✅ **风险可控**：测试环境失败不影响生产

**但需要：**
- ⚠️ **严格验证**：成功率必须 > 80% 才应用
- ⚠️ **自动回滚**：验证失败立即回滚
- ⚠️ **通知机制**：规则变更必须通知团队
- ⚠️ **可选人工确认**：关键业务建议开启

**建议配置：**
```bash
# 测试环境：积极策略
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5
RULES_MIN_SUCCESS_RATE=0.8  # 新规则成功率必须 > 80%
RULES_AUTO_ROLLBACK=true     # 自动回滚
RULES_NOTIFICATION_ENABLED=true
```

---

### 生产环境：不推荐自动更新 ❌

**不推荐的理由：**
1. ❌ **稳定性优先**：生产环境失败直接影响业务
2. ❌ **数据质量风险**：错误的规则可能导致数据错误
3. ❌ **难以追溯**：自动更新难以追溯问题原因
4. ❌ **合规风险**：某些行业需要人工审核

**但可以配置紧急模式：**
- 仅在极端情况下（成功率 < 10%）启用
- 需要管理员确认
- 严格验证和监控

**建议配置：**
```bash
# 生产环境：禁止自动更新
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_WRITE=false
RULES_REQUIRE_MANUAL_DEPLOY=true

# 可选：紧急模式（仅在极端情况下启用）
ALLOW_RULES_EMERGENCY_UPDATE=false  # 默认关闭
RULES_EMERGENCY_THRESHOLD=0.1
RULES_EMERGENCY_REQUIRE_ADMIN=true
```

---

## 📊 最终建议

### 推荐配置

**开发环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 完全自动
```

**测试环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 条件自动（成功率 < 50% 触发）
RULES_MIN_SUCCESS_RATE=0.8    # ⚠️ 新规则必须 > 80% 成功率
RULES_AUTO_ROLLBACK=true      # ✅ 自动回滚
RULES_NOTIFICATION_ENABLED=true  # ✅ 通知团队
```

**生产环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=false  # ❌ 禁止自动更新
ALLOW_RULES_EMERGENCY_UPDATE=false  # ❌ 紧急模式默认关闭
RULES_REQUIRE_MANUAL_DEPLOY=true   # ✅ 必须手动部署
```

### 总结

| 环境 | 自动更新 | 原因 |
|------|---------|------|
| **开发** | ✅ **强烈推荐** | 快速迭代，风险低 |
| **测试** | ✅ **条件推荐** | 快速验证，风险可控 |
| **生产** | ❌ **不推荐** | 稳定性优先，风险高 |

**测试环境可以自动更新，但需要：**
- 严格验证（成功率 > 80%）
- 自动回滚机制
- 通知机制
- 可选人工确认

**生产环境不建议自动更新，但可以配置紧急模式作为最后手段。**

---

## 📊 总结

### 安全等级对比

| 方案 | 文件权限 | 自动更新 | 审计日志 | 回滚 | 推荐场景 |
|------|---------|---------|---------|------|---------|
| **方案A：文件系统+权限控制** | ✅ | ✅/❌ | ✅ | ✅ | 中小型项目 |
| **方案B：数据库存储** | ✅ | ✅/❌ | ✅ | ✅ | 大型项目，多环境 |

### 关键安全措施

1. ✅ **环境隔离**：测试和生产规则完全分离
2. ✅ **权限控制**：生产环境禁止自动更新
3. ✅ **审计日志**：所有规则变更可追溯
4. ✅ **安全验证**：防止注入攻击和 ReDoS
5. ✅ **回滚机制**：快速恢复错误规则

### 推荐配置

**开发/测试环境：**
- 允许自动更新
- 文件系统存储
- 完整审计日志

**生产环境：**
- **禁止自动更新**（必须人工审核）
- 数据库存储（可选，更安全）
- 规则变更需通过 CI/CD 流程
## 📋 目录

1. [安全风险分析](#安全风险分析)
2. [权限控制方案](#权限控制方案)
3. [环境隔离策略](#环境隔离策略)
4. [审计与日志](#审计与日志)
5. [回滚机制](#回滚机制)
6. [实施建议](#实施建议)

---

## 🔒 安全风险分析

### 1. 文件系统权限风险

**问题：**
- 生产环境可能运行在受限用户下（如 `www-data`, `nobody`）
- 可能没有写入 `.cache/` 目录的权限
- Docker 容器可能挂载只读文件系统

**风险等级：** ⚠️ **高**

### 2. LLM 生成内容安全风险

**问题：**
- LLM 可能生成恶意代码（如果走路径B：生成 JavaScript）
- JSON 规则可能包含路径遍历攻击（`../../etc/passwd`）
- 规则可能被注入恶意正则表达式（ReDoS 攻击）

**风险等级：** ⚠️ **高**

### 3. 规则覆盖风险

**问题：**
- 新规则可能覆盖已验证的旧规则
- 规则文件可能被外部修改
- 没有版本控制，无法追溯变更

**风险等级：** ⚠️ **中**

### 4. 环境混淆风险

**问题：**
- 测试环境的规则可能被应用到生产环境
- 生产环境的规则可能被测试环境覆盖

**风险等级：** ⚠️ **高**

---

## 🔐 权限控制方案

### 方案 A：基于环境变量的权限控制（推荐）

```javascript
// lib/html-extraction/rules-manager.js

const RULES_CONFIG = {
  // 规则存储路径（按环境区分）
  rulesDir: process.env.RULES_CACHE_DIR || path.join(projectRoot, '.cache/rules'),
  
  // 是否允许自动更新规则（所有环境都允许）
  allowAutoUpdate: process.env.ALLOW_RULES_AUTO_UPDATE !== 'false',  // 默认允许
  
  // 是否允许写入规则文件（所有环境都允许）
  allowWriteRules: process.env.ALLOW_RULES_WRITE !== 'false',  // 默认允许
  
  // 当前环境
  environment: process.env.NODE_ENV || 'development',
  
  // 规则文件权限
  rulesFileMode: 0o644,
  
  // 重试配置
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
};

// 权限检查函数
function checkWritePermission() {
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  // 检查目录权限
  try {
    fs.accessSync(RULES_CONFIG.rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${RULES_CONFIG.rulesDir}`);
  }
}
```

**环境变量配置（所有环境统一）：**

```bash
# .env.development（开发环境）
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.staging（测试环境）
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.production（生产环境）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新（用户要求）
ALLOW_RULES_WRITE=true       # ✅ 允许写入（用户要求）
RULES_CACHE_DIR=/app/data/rules  # 使用持久化存储
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名（所有环境统一）
```

### 方案 B：基于数据库的规则存储（更安全）

如果文件系统不可写，可以将规则存储在数据库中：

```javascript
// lib/html-extraction/rules-db.js

const RULES_TABLE = 'tiktok_extraction_rules';

async function loadRulesFromDB(environment) {
  const [rows] = await query(
    `SELECT rules_json, version, created_at 
     FROM ${RULES_TABLE} 
     WHERE environment = ? AND is_active = 1 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [environment]
  );
  
  return rows[0] ? JSON.parse(rows[0].rules_json) : getDefaultRules();
}

async function saveRulesToDB(rules, environment, userId = null) {
  // 1. 验证规则
  if (!validateRules(rules)) {
    throw new Error('规则验证失败');
  }
  
  // 2. 插入新规则（不删除旧规则，用于回滚）
  await query(
    `INSERT INTO ${RULES_TABLE} 
     (environment, rules_json, version, created_by, created_at, is_active) 
     VALUES (?, ?, ?, ?, NOW(), 0)`,
    [environment, JSON.stringify(rules), generateVersion(), userId]
  );
  
  // 3. 标记为待审核（生产环境需要人工审核）
  if (environment === 'production') {
    await query(
      `UPDATE ${RULES_TABLE} SET status = 'pending_review' WHERE id = LAST_INSERT_ID()`
    );
  } else {
    // 测试环境自动激活
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 1, status = 'active' WHERE id = LAST_INSERT_ID()`
    );
    // 停用旧规则
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 0 WHERE environment = ? AND id != LAST_INSERT_ID()`,
      [environment]
    );
  }
}
```

**数据库表结构：**

```sql
CREATE TABLE tiktok_extraction_rules (
  id INT PRIMARY KEY AUTO_INCREMENT,
  environment ENUM('development', 'staging', 'production') NOT NULL,
  rules_json TEXT NOT NULL,
  version VARCHAR(50) NOT NULL,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 0,
  status ENUM('pending_review', 'active', 'rejected', 'deprecated') DEFAULT 'pending_review',
  review_notes TEXT,
  INDEX idx_env_active (environment, is_active),
  INDEX idx_env_status (environment, status)
);
```

---

## 🌍 环境隔离策略

### 1. 规则文件隔离

```
.cache/rules/
├── development/
│   ├── tiktok-rules-v1.0.json
│   ├── tiktok-rules-v1.1.json
│   └── current -> tiktok-rules-v1.1.json  (符号链接)
├── staging/
│   └── tiktok-rules-v1.0.json
└── production/
    └── tiktok-rules-v1.0.json  (只读，需手动更新)
```

### 2. 环境检测与隔离

```javascript
function getRulesPath() {
  const env = process.env.NODE_ENV || 'development';
  const rulesDir = path.join(
    RULES_CONFIG.rulesDir,
    env  // 按环境隔离
  );
  
  // 确保目录存在
  fs.mkdirSync(rulesDir, { recursive: true });
  
  return path.join(rulesDir, 'tiktok-rules-current.json');
}

function loadRules() {
  const rulesPath = getRulesPath();
  
  // 生产环境：如果文件不存在，使用默认规则（不允许自动创建）
  if (RULES_CONFIG.environment === 'production' && !fs.existsSync(rulesPath)) {
    console.warn('[规则] 生产环境未找到规则文件，使用默认规则');
    return getDefaultRules();
  }
  
  // 其他环境：如果文件不存在，创建默认规则
  if (!fs.existsSync(rulesPath)) {
    const defaultRules = getDefaultRules();
    saveRules(defaultRules);  // 自动创建
    return defaultRules;
  }
  
  return JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
}
```

---

## 📝 审计与日志

### 1. 规则变更审计日志

```javascript
// lib/html-extraction/rules-audit.js

const AUDIT_LOG_PATH = path.join(projectRoot, 'logs/rules-audit.log');

function auditRuleChange(action, details) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    environment: RULES_CONFIG.environment,
    action,  // 'create', 'update', 'delete', 'rollback'
    details,
    user: process.env.USER || 'system',
    hostname: require('os').hostname(),
  };
  
  // 写入日志文件
  fs.appendFileSync(
    AUDIT_LOG_PATH,
    JSON.stringify(logEntry) + '\n',
    'utf-8'
  );
  
  // 生产环境：同时写入数据库（如果可用）
  if (RULES_CONFIG.environment === 'production') {
    saveAuditToDB(logEntry).catch(err => {
      console.error('[审计] 写入数据库失败:', err);
    });
  }
}
```

### 2. 规则验证日志

```javascript
async function updateRulesIfNeeded(html, extractionResult) {
  if (!shouldTriggerRuleUpdate(extractionResult, 50)) return;
  
  console.log('[规则更新] 检测到提取成功率低，触发 LLM 学习...');
  
  const newRules = await generateRulesFromHTML(html);
  const validationResult = validateRules(html, newRules, extractionResult, 50);
  
  // 记录验证结果
  auditRuleChange('validate', {
    success: validationResult.ok,
    metrics: validationResult.metrics,
    ruleVersion: newRules.version,
  });
  
  if (!validationResult.ok) {
    console.warn('[规则更新] 新规则验证失败，保持使用当前规则');
    return;
  }
  
  // 保存规则（会触发权限检查）
  try {
    saveRules(newRules);
    auditRuleChange('update', {
      ruleVersion: newRules.version,
      metrics: validationResult.metrics,
    });
  } catch (e) {
    auditRuleChange('update_failed', {
      error: e.message,
      ruleVersion: newRules.version,
    });
    throw e;
  }
}
```

---

## 🔄 回滚机制

### 1. 版本化规则存储

```javascript
function saveRules(rules) {
  checkWritePermission();  // 权限检查
  
  const rulesPath = getRulesPath();
  const version = rules.version || generateVersion();
  
  // 1. 保存版本化文件
  const versionedPath = rulesPath.replace('current.json', `v${version}.json`);
  fs.writeFileSync(versionedPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 2. 更新 current.json（符号链接或直接复制）
  if (RULES_CONFIG.environment === 'production') {
    // 生产环境：创建备份后再更新
    const backupPath = `${rulesPath}.backup.${Date.now()}`;
    if (fs.existsSync(rulesPath)) {
      fs.copyFileSync(rulesPath, backupPath);
    }
  }
  
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 3. 记录变更
  auditRuleChange('update', { version });
}

function rollbackRules(targetVersion) {
  checkWritePermission();
  
  const rulesPath = getRulesPath();
  const versionedPath = rulesPath.replace('current.json', `v${targetVersion}.json`);
  
  if (!fs.existsSync(versionedPath)) {
    throw new Error(`版本 ${targetVersion} 不存在`);
  }
  
  const rules = JSON.parse(fs.readFileSync(versionedPath, 'utf-8'));
  saveRules(rules);
  
  auditRuleChange('rollback', { targetVersion });
}
```

### 2. 自动回滚机制

```javascript
async function updateRulesWithAutoRollback(html, extractionResult) {
  const currentRules = loadRules();
  const currentVersion = currentRules.version;
  
  try {
    await updateRulesIfNeeded(html, extractionResult);
    
    // 验证新规则（运行一次完整提取）
    const testResult = extractWithRules(html, loadRules());
    if (!validateRules(html, loadRules(), testResult, 50).ok) {
      throw new Error('新规则验证失败');
    }
  } catch (e) {
    console.error('[规则更新] 自动回滚到版本:', currentVersion);
    
    // 回滚到之前的版本
    rollbackRules(currentVersion);
    
    auditRuleChange('auto_rollback', {
      error: e.message,
      rolledBackTo: currentVersion,
    });
    
    throw e;
  }
}
```

---

## 🛡️ 安全验证

### 1. 规则内容安全验证

```javascript
function validateRuleSecurity(rules) {
  const issues = [];
  
  // 1. 检查 JSON 结构合法性
  if (!rules.video || !rules.user) {
    issues.push('规则结构不完整');
  }
  
  // 2. 检查正则表达式安全性（防止 ReDoS）
  function checkRegexSafety(pattern) {
    // 简单检查：避免嵌套量词
    if (/(\*|\+|\?|\{.*,.*\}).*\1/.test(pattern)) {
      issues.push(`潜在 ReDoS 风险的正则: ${pattern}`);
    }
  }
  
  // 3. 检查路径遍历攻击
  function checkPathTraversal(value) {
    if (typeof value === 'string' && value.includes('../')) {
      issues.push(`潜在路径遍历攻击: ${value}`);
    }
  }
  
  // 递归检查所有字符串值
  function traverse(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        checkPathTraversal(value);
        if (key === 'pattern' || key.includes('regex')) {
          checkRegexSafety(value);
        }
      } else if (typeof value === 'object' && value !== null) {
        traverse(value);
      }
    }
  }
  
  traverse(rules);
  
  if (issues.length > 0) {
    throw new Error(`规则安全验证失败:\n${issues.join('\n')}`);
  }
  
  return true;
}
```

### 2. LLM 输出内容验证

```javascript
async function generateRulesFromHTML(html) {
  const response = await callDeepSeekLLM([...], systemPrompt);
  
  // 1. 提取 JSON（移除 markdown 代码块）
  let jsonStr = extractJSON(response);
  
  // 2. 解析 JSON
  let rules;
  try {
    rules = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`LLM 返回的不是有效 JSON: ${e.message}`);
  }
  
  // 3. 安全验证
  validateRuleSecurity(rules);
  
  // 4. 结构验证
  if (!rules.video || !rules.user) {
    throw new Error('规则缺少必要字段');
  }
  
  // 5. 添加元数据
  rules.version = generateVersion();
  rules.generatedAt = new Date().toISOString();
  rules.environment = RULES_CONFIG.environment;
  
  return rules;
}
```

---

## ✅ 实施建议

### 环境自动更新策略对比

| 环境 | 自动更新 | 验证要求 | 回滚机制 | 推荐场景 |
|------|---------|---------|---------|---------|
| **开发环境** | ✅ **强烈推荐** | 基础验证 | 自动回滚 | 快速迭代，频繁测试 |
| **测试环境** | ⚠️ **条件推荐** | 严格验证 + 人工确认 | 自动回滚 + 告警 | 验证新规则稳定性 |
| **生产环境** | ❌ **不推荐** | 人工审核 + 灰度发布 | 快速回滚 + 监控 | 稳定性优先 |

---

### 阶段 1：开发环境（立即实施）

**策略：完全自动更新**

1. ✅ 实现文件系统规则存储
2. ✅ 添加权限检查（基于环境变量）
3. ✅ 实现审计日志
4. ✅ 实现版本化存储

**配置：**
```bash
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发更新
```

**优点：**
- 快速适应 TikTok 改版
- 减少人工维护成本
- 适合频繁测试

---

### 阶段 2：测试环境（1-2周后）

**策略：条件自动更新（推荐）**

**方案 A：保守策略（推荐用于关键业务）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.3  # 成功率 < 30% 才触发
RULES_REQUIRE_MANUAL_CONFIRM=true  # 需要人工确认
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**方案 B：积极策略（推荐用于快速迭代）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发
RULES_REQUIRE_MANUAL_CONFIRM=false  # 自动应用
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**实现要点：**
1. ✅ 更严格的验证（成功率 > 80% 才应用）
2. ✅ 自动回滚（验证失败立即回滚）
3. ✅ 通知机制（Slack/邮件通知规则变更）
4. ✅ 可选人工确认（关键业务建议开启）

**建议：**
- **如果你的测试环境用于验证生产前准备**：使用方案 A（保守）
- **如果你的测试环境用于快速迭代**：使用方案 B（积极）

---

### 阶段 3：生产环境（1个月后）

**策略：禁止自动更新（强烈推荐）**

**配置：**
```bash
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false  # 🔒 禁止自动更新
ALLOW_RULES_WRITE=false        # 🔒 禁止写入
RULES_REQUIRE_MANUAL_DEPLOY=true  # 必须手动部署
```

**更新流程（所有环境统一）：**
```
1. 检测到去重后的用户名数量 < 10 → 触发规则更新
2. 第 1 次尝试：LLM 生成规则 → 验证（至少 10 个红人用户名）
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒后重试
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒后重试
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️（记录日志，发送告警）
```

**关键点：**
- ✅ **触发条件**：去重后的用户名数量 < 10
- ✅ 所有环境都允许自动更新
- ✅ 必须达到验证阈值（至少 10 个红人用户名）才应用
- ✅ 未达到阈值时重试最多 3 次
- ✅ 3 次都失败则继续使用旧规则，不中断任务

**例外情况：紧急自动更新（不推荐，但可配置）**

如果 TikTok 突然大规模改版，导致提取完全失败，可以配置紧急模式：

```bash
# 紧急模式（仅在极端情况下启用）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_EMERGENCY_UPDATE=true  # 紧急更新开关
RULES_EMERGENCY_THRESHOLD=0.1      # 成功率 < 10% 才触发
RULES_EMERGENCY_REQUIRE_ADMIN=true # 需要管理员确认
```

**紧急更新流程：**
```
1. 检测到成功率 < 10%（严重失败）
2. 发送紧急告警（电话/短信）
3. 等待管理员确认（5分钟内）
4. 如果确认 → LLM 生成新规则 → 严格验证 → 应用
5. 如果未确认 → 保持旧规则，继续告警
```

---

## 🤔 是否建议测试和生产环境自动更新？

### 测试环境：条件推荐 ✅

**推荐自动更新的理由：**
1. ✅ **快速验证**：TikTok 改版后，测试环境可以快速适应
2. ✅ **降低维护成本**：减少人工干预
3. ✅ **风险可控**：测试环境失败不影响生产

**但需要：**
- ⚠️ **严格验证**：成功率必须 > 80% 才应用
- ⚠️ **自动回滚**：验证失败立即回滚
- ⚠️ **通知机制**：规则变更必须通知团队
- ⚠️ **可选人工确认**：关键业务建议开启

**建议配置：**
```bash
# 测试环境：积极策略
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5
RULES_MIN_SUCCESS_RATE=0.8  # 新规则成功率必须 > 80%
RULES_AUTO_ROLLBACK=true     # 自动回滚
RULES_NOTIFICATION_ENABLED=true
```

---

### 生产环境：不推荐自动更新 ❌

**不推荐的理由：**
1. ❌ **稳定性优先**：生产环境失败直接影响业务
2. ❌ **数据质量风险**：错误的规则可能导致数据错误
3. ❌ **难以追溯**：自动更新难以追溯问题原因
4. ❌ **合规风险**：某些行业需要人工审核

**但可以配置紧急模式：**
- 仅在极端情况下（成功率 < 10%）启用
- 需要管理员确认
- 严格验证和监控

**建议配置：**
```bash
# 生产环境：禁止自动更新
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_WRITE=false
RULES_REQUIRE_MANUAL_DEPLOY=true

# 可选：紧急模式（仅在极端情况下启用）
ALLOW_RULES_EMERGENCY_UPDATE=false  # 默认关闭
RULES_EMERGENCY_THRESHOLD=0.1
RULES_EMERGENCY_REQUIRE_ADMIN=true
```

---

## 📊 最终建议

### 推荐配置

**开发环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 完全自动
```

**测试环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 条件自动（成功率 < 50% 触发）
RULES_MIN_SUCCESS_RATE=0.8    # ⚠️ 新规则必须 > 80% 成功率
RULES_AUTO_ROLLBACK=true      # ✅ 自动回滚
RULES_NOTIFICATION_ENABLED=true  # ✅ 通知团队
```

**生产环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=false  # ❌ 禁止自动更新
ALLOW_RULES_EMERGENCY_UPDATE=false  # ❌ 紧急模式默认关闭
RULES_REQUIRE_MANUAL_DEPLOY=true   # ✅ 必须手动部署
```

### 总结

| 环境 | 自动更新 | 原因 |
|------|---------|------|
| **开发** | ✅ **强烈推荐** | 快速迭代，风险低 |
| **测试** | ✅ **条件推荐** | 快速验证，风险可控 |
| **生产** | ❌ **不推荐** | 稳定性优先，风险高 |

**测试环境可以自动更新，但需要：**
- 严格验证（成功率 > 80%）
- 自动回滚机制
- 通知机制
- 可选人工确认

**生产环境不建议自动更新，但可以配置紧急模式作为最后手段。**

---

## 📊 总结

### 安全等级对比

| 方案 | 文件权限 | 自动更新 | 审计日志 | 回滚 | 推荐场景 |
|------|---------|---------|---------|------|---------|
| **方案A：文件系统+权限控制** | ✅ | ✅/❌ | ✅ | ✅ | 中小型项目 |
| **方案B：数据库存储** | ✅ | ✅/❌ | ✅ | ✅ | 大型项目，多环境 |

### 关键安全措施

1. ✅ **环境隔离**：测试和生产规则完全分离
2. ✅ **权限控制**：生产环境禁止自动更新
3. ✅ **审计日志**：所有规则变更可追溯
4. ✅ **安全验证**：防止注入攻击和 ReDoS
5. ✅ **回滚机制**：快速恢复错误规则

### 推荐配置

**开发/测试环境：**
- 允许自动更新
- 文件系统存储
- 完整审计日志

**生产环境：**
- **禁止自动更新**（必须人工审核）
- 数据库存储（可选，更安全）
- 规则变更需通过 CI/CD 流程
## 📋 目录

1. [安全风险分析](#安全风险分析)
2. [权限控制方案](#权限控制方案)
3. [环境隔离策略](#环境隔离策略)
4. [审计与日志](#审计与日志)
5. [回滚机制](#回滚机制)
6. [实施建议](#实施建议)

---

## 🔒 安全风险分析

### 1. 文件系统权限风险

**问题：**
- 生产环境可能运行在受限用户下（如 `www-data`, `nobody`）
- 可能没有写入 `.cache/` 目录的权限
- Docker 容器可能挂载只读文件系统

**风险等级：** ⚠️ **高**

### 2. LLM 生成内容安全风险

**问题：**
- LLM 可能生成恶意代码（如果走路径B：生成 JavaScript）
- JSON 规则可能包含路径遍历攻击（`../../etc/passwd`）
- 规则可能被注入恶意正则表达式（ReDoS 攻击）

**风险等级：** ⚠️ **高**

### 3. 规则覆盖风险

**问题：**
- 新规则可能覆盖已验证的旧规则
- 规则文件可能被外部修改
- 没有版本控制，无法追溯变更

**风险等级：** ⚠️ **中**

### 4. 环境混淆风险

**问题：**
- 测试环境的规则可能被应用到生产环境
- 生产环境的规则可能被测试环境覆盖

**风险等级：** ⚠️ **高**

---

## 🔐 权限控制方案

### 方案 A：基于环境变量的权限控制（推荐）

```javascript
// lib/html-extraction/rules-manager.js

const RULES_CONFIG = {
  // 规则存储路径（按环境区分）
  rulesDir: process.env.RULES_CACHE_DIR || path.join(projectRoot, '.cache/rules'),
  
  // 是否允许自动更新规则（所有环境都允许）
  allowAutoUpdate: process.env.ALLOW_RULES_AUTO_UPDATE !== 'false',  // 默认允许
  
  // 是否允许写入规则文件（所有环境都允许）
  allowWriteRules: process.env.ALLOW_RULES_WRITE !== 'false',  // 默认允许
  
  // 当前环境
  environment: process.env.NODE_ENV || 'development',
  
  // 规则文件权限
  rulesFileMode: 0o644,
  
  // 重试配置
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
};

// 权限检查函数
function checkWritePermission() {
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  // 检查目录权限
  try {
    fs.accessSync(RULES_CONFIG.rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${RULES_CONFIG.rulesDir}`);
  }
}
```

**环境变量配置（所有环境统一）：**

```bash
# .env.development（开发环境）
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.staging（测试环境）
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.production（生产环境）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新（用户要求）
ALLOW_RULES_WRITE=true       # ✅ 允许写入（用户要求）
RULES_CACHE_DIR=/app/data/rules  # 使用持久化存储
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名（所有环境统一）
```

### 方案 B：基于数据库的规则存储（更安全）

如果文件系统不可写，可以将规则存储在数据库中：

```javascript
// lib/html-extraction/rules-db.js

const RULES_TABLE = 'tiktok_extraction_rules';

async function loadRulesFromDB(environment) {
  const [rows] = await query(
    `SELECT rules_json, version, created_at 
     FROM ${RULES_TABLE} 
     WHERE environment = ? AND is_active = 1 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [environment]
  );
  
  return rows[0] ? JSON.parse(rows[0].rules_json) : getDefaultRules();
}

async function saveRulesToDB(rules, environment, userId = null) {
  // 1. 验证规则
  if (!validateRules(rules)) {
    throw new Error('规则验证失败');
  }
  
  // 2. 插入新规则（不删除旧规则，用于回滚）
  await query(
    `INSERT INTO ${RULES_TABLE} 
     (environment, rules_json, version, created_by, created_at, is_active) 
     VALUES (?, ?, ?, ?, NOW(), 0)`,
    [environment, JSON.stringify(rules), generateVersion(), userId]
  );
  
  // 3. 标记为待审核（生产环境需要人工审核）
  if (environment === 'production') {
    await query(
      `UPDATE ${RULES_TABLE} SET status = 'pending_review' WHERE id = LAST_INSERT_ID()`
    );
  } else {
    // 测试环境自动激活
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 1, status = 'active' WHERE id = LAST_INSERT_ID()`
    );
    // 停用旧规则
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 0 WHERE environment = ? AND id != LAST_INSERT_ID()`,
      [environment]
    );
  }
}
```

**数据库表结构：**

```sql
CREATE TABLE tiktok_extraction_rules (
  id INT PRIMARY KEY AUTO_INCREMENT,
  environment ENUM('development', 'staging', 'production') NOT NULL,
  rules_json TEXT NOT NULL,
  version VARCHAR(50) NOT NULL,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 0,
  status ENUM('pending_review', 'active', 'rejected', 'deprecated') DEFAULT 'pending_review',
  review_notes TEXT,
  INDEX idx_env_active (environment, is_active),
  INDEX idx_env_status (environment, status)
);
```

---

## 🌍 环境隔离策略

### 1. 规则文件隔离

```
.cache/rules/
├── development/
│   ├── tiktok-rules-v1.0.json
│   ├── tiktok-rules-v1.1.json
│   └── current -> tiktok-rules-v1.1.json  (符号链接)
├── staging/
│   └── tiktok-rules-v1.0.json
└── production/
    └── tiktok-rules-v1.0.json  (只读，需手动更新)
```

### 2. 环境检测与隔离

```javascript
function getRulesPath() {
  const env = process.env.NODE_ENV || 'development';
  const rulesDir = path.join(
    RULES_CONFIG.rulesDir,
    env  // 按环境隔离
  );
  
  // 确保目录存在
  fs.mkdirSync(rulesDir, { recursive: true });
  
  return path.join(rulesDir, 'tiktok-rules-current.json');
}

function loadRules() {
  const rulesPath = getRulesPath();
  
  // 生产环境：如果文件不存在，使用默认规则（不允许自动创建）
  if (RULES_CONFIG.environment === 'production' && !fs.existsSync(rulesPath)) {
    console.warn('[规则] 生产环境未找到规则文件，使用默认规则');
    return getDefaultRules();
  }
  
  // 其他环境：如果文件不存在，创建默认规则
  if (!fs.existsSync(rulesPath)) {
    const defaultRules = getDefaultRules();
    saveRules(defaultRules);  // 自动创建
    return defaultRules;
  }
  
  return JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
}
```

---

## 📝 审计与日志

### 1. 规则变更审计日志

```javascript
// lib/html-extraction/rules-audit.js

const AUDIT_LOG_PATH = path.join(projectRoot, 'logs/rules-audit.log');

function auditRuleChange(action, details) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    environment: RULES_CONFIG.environment,
    action,  // 'create', 'update', 'delete', 'rollback'
    details,
    user: process.env.USER || 'system',
    hostname: require('os').hostname(),
  };
  
  // 写入日志文件
  fs.appendFileSync(
    AUDIT_LOG_PATH,
    JSON.stringify(logEntry) + '\n',
    'utf-8'
  );
  
  // 生产环境：同时写入数据库（如果可用）
  if (RULES_CONFIG.environment === 'production') {
    saveAuditToDB(logEntry).catch(err => {
      console.error('[审计] 写入数据库失败:', err);
    });
  }
}
```

### 2. 规则验证日志

```javascript
async function updateRulesIfNeeded(html, extractionResult) {
  if (!shouldTriggerRuleUpdate(extractionResult, 50)) return;
  
  console.log('[规则更新] 检测到提取成功率低，触发 LLM 学习...');
  
  const newRules = await generateRulesFromHTML(html);
  const validationResult = validateRules(html, newRules, extractionResult, 50);
  
  // 记录验证结果
  auditRuleChange('validate', {
    success: validationResult.ok,
    metrics: validationResult.metrics,
    ruleVersion: newRules.version,
  });
  
  if (!validationResult.ok) {
    console.warn('[规则更新] 新规则验证失败，保持使用当前规则');
    return;
  }
  
  // 保存规则（会触发权限检查）
  try {
    saveRules(newRules);
    auditRuleChange('update', {
      ruleVersion: newRules.version,
      metrics: validationResult.metrics,
    });
  } catch (e) {
    auditRuleChange('update_failed', {
      error: e.message,
      ruleVersion: newRules.version,
    });
    throw e;
  }
}
```

---

## 🔄 回滚机制

### 1. 版本化规则存储

```javascript
function saveRules(rules) {
  checkWritePermission();  // 权限检查
  
  const rulesPath = getRulesPath();
  const version = rules.version || generateVersion();
  
  // 1. 保存版本化文件
  const versionedPath = rulesPath.replace('current.json', `v${version}.json`);
  fs.writeFileSync(versionedPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 2. 更新 current.json（符号链接或直接复制）
  if (RULES_CONFIG.environment === 'production') {
    // 生产环境：创建备份后再更新
    const backupPath = `${rulesPath}.backup.${Date.now()}`;
    if (fs.existsSync(rulesPath)) {
      fs.copyFileSync(rulesPath, backupPath);
    }
  }
  
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 3. 记录变更
  auditRuleChange('update', { version });
}

function rollbackRules(targetVersion) {
  checkWritePermission();
  
  const rulesPath = getRulesPath();
  const versionedPath = rulesPath.replace('current.json', `v${targetVersion}.json`);
  
  if (!fs.existsSync(versionedPath)) {
    throw new Error(`版本 ${targetVersion} 不存在`);
  }
  
  const rules = JSON.parse(fs.readFileSync(versionedPath, 'utf-8'));
  saveRules(rules);
  
  auditRuleChange('rollback', { targetVersion });
}
```

### 2. 自动回滚机制

```javascript
async function updateRulesWithAutoRollback(html, extractionResult) {
  const currentRules = loadRules();
  const currentVersion = currentRules.version;
  
  try {
    await updateRulesIfNeeded(html, extractionResult);
    
    // 验证新规则（运行一次完整提取）
    const testResult = extractWithRules(html, loadRules());
    if (!validateRules(html, loadRules(), testResult, 50).ok) {
      throw new Error('新规则验证失败');
    }
  } catch (e) {
    console.error('[规则更新] 自动回滚到版本:', currentVersion);
    
    // 回滚到之前的版本
    rollbackRules(currentVersion);
    
    auditRuleChange('auto_rollback', {
      error: e.message,
      rolledBackTo: currentVersion,
    });
    
    throw e;
  }
}
```

---

## 🛡️ 安全验证

### 1. 规则内容安全验证

```javascript
function validateRuleSecurity(rules) {
  const issues = [];
  
  // 1. 检查 JSON 结构合法性
  if (!rules.video || !rules.user) {
    issues.push('规则结构不完整');
  }
  
  // 2. 检查正则表达式安全性（防止 ReDoS）
  function checkRegexSafety(pattern) {
    // 简单检查：避免嵌套量词
    if (/(\*|\+|\?|\{.*,.*\}).*\1/.test(pattern)) {
      issues.push(`潜在 ReDoS 风险的正则: ${pattern}`);
    }
  }
  
  // 3. 检查路径遍历攻击
  function checkPathTraversal(value) {
    if (typeof value === 'string' && value.includes('../')) {
      issues.push(`潜在路径遍历攻击: ${value}`);
    }
  }
  
  // 递归检查所有字符串值
  function traverse(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        checkPathTraversal(value);
        if (key === 'pattern' || key.includes('regex')) {
          checkRegexSafety(value);
        }
      } else if (typeof value === 'object' && value !== null) {
        traverse(value);
      }
    }
  }
  
  traverse(rules);
  
  if (issues.length > 0) {
    throw new Error(`规则安全验证失败:\n${issues.join('\n')}`);
  }
  
  return true;
}
```

### 2. LLM 输出内容验证

```javascript
async function generateRulesFromHTML(html) {
  const response = await callDeepSeekLLM([...], systemPrompt);
  
  // 1. 提取 JSON（移除 markdown 代码块）
  let jsonStr = extractJSON(response);
  
  // 2. 解析 JSON
  let rules;
  try {
    rules = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`LLM 返回的不是有效 JSON: ${e.message}`);
  }
  
  // 3. 安全验证
  validateRuleSecurity(rules);
  
  // 4. 结构验证
  if (!rules.video || !rules.user) {
    throw new Error('规则缺少必要字段');
  }
  
  // 5. 添加元数据
  rules.version = generateVersion();
  rules.generatedAt = new Date().toISOString();
  rules.environment = RULES_CONFIG.environment;
  
  return rules;
}
```

---

## ✅ 实施建议

### 环境自动更新策略对比

| 环境 | 自动更新 | 验证要求 | 回滚机制 | 推荐场景 |
|------|---------|---------|---------|---------|
| **开发环境** | ✅ **强烈推荐** | 基础验证 | 自动回滚 | 快速迭代，频繁测试 |
| **测试环境** | ⚠️ **条件推荐** | 严格验证 + 人工确认 | 自动回滚 + 告警 | 验证新规则稳定性 |
| **生产环境** | ❌ **不推荐** | 人工审核 + 灰度发布 | 快速回滚 + 监控 | 稳定性优先 |

---

### 阶段 1：开发环境（立即实施）

**策略：完全自动更新**

1. ✅ 实现文件系统规则存储
2. ✅ 添加权限检查（基于环境变量）
3. ✅ 实现审计日志
4. ✅ 实现版本化存储

**配置：**
```bash
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发更新
```

**优点：**
- 快速适应 TikTok 改版
- 减少人工维护成本
- 适合频繁测试

---

### 阶段 2：测试环境（1-2周后）

**策略：条件自动更新（推荐）**

**方案 A：保守策略（推荐用于关键业务）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.3  # 成功率 < 30% 才触发
RULES_REQUIRE_MANUAL_CONFIRM=true  # 需要人工确认
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**方案 B：积极策略（推荐用于快速迭代）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发
RULES_REQUIRE_MANUAL_CONFIRM=false  # 自动应用
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**实现要点：**
1. ✅ 更严格的验证（成功率 > 80% 才应用）
2. ✅ 自动回滚（验证失败立即回滚）
3. ✅ 通知机制（Slack/邮件通知规则变更）
4. ✅ 可选人工确认（关键业务建议开启）

**建议：**
- **如果你的测试环境用于验证生产前准备**：使用方案 A（保守）
- **如果你的测试环境用于快速迭代**：使用方案 B（积极）

---

### 阶段 3：生产环境（1个月后）

**策略：禁止自动更新（强烈推荐）**

**配置：**
```bash
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false  # 🔒 禁止自动更新
ALLOW_RULES_WRITE=false        # 🔒 禁止写入
RULES_REQUIRE_MANUAL_DEPLOY=true  # 必须手动部署
```

**更新流程（所有环境统一）：**
```
1. 检测到去重后的用户名数量 < 10 → 触发规则更新
2. 第 1 次尝试：LLM 生成规则 → 验证（至少 10 个红人用户名）
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒后重试
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒后重试
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️（记录日志，发送告警）
```

**关键点：**
- ✅ **触发条件**：去重后的用户名数量 < 10
- ✅ 所有环境都允许自动更新
- ✅ 必须达到验证阈值（至少 10 个红人用户名）才应用
- ✅ 未达到阈值时重试最多 3 次
- ✅ 3 次都失败则继续使用旧规则，不中断任务

**例外情况：紧急自动更新（不推荐，但可配置）**

如果 TikTok 突然大规模改版，导致提取完全失败，可以配置紧急模式：

```bash
# 紧急模式（仅在极端情况下启用）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_EMERGENCY_UPDATE=true  # 紧急更新开关
RULES_EMERGENCY_THRESHOLD=0.1      # 成功率 < 10% 才触发
RULES_EMERGENCY_REQUIRE_ADMIN=true # 需要管理员确认
```

**紧急更新流程：**
```
1. 检测到成功率 < 10%（严重失败）
2. 发送紧急告警（电话/短信）
3. 等待管理员确认（5分钟内）
4. 如果确认 → LLM 生成新规则 → 严格验证 → 应用
5. 如果未确认 → 保持旧规则，继续告警
```

---

## 🤔 是否建议测试和生产环境自动更新？

### 测试环境：条件推荐 ✅

**推荐自动更新的理由：**
1. ✅ **快速验证**：TikTok 改版后，测试环境可以快速适应
2. ✅ **降低维护成本**：减少人工干预
3. ✅ **风险可控**：测试环境失败不影响生产

**但需要：**
- ⚠️ **严格验证**：成功率必须 > 80% 才应用
- ⚠️ **自动回滚**：验证失败立即回滚
- ⚠️ **通知机制**：规则变更必须通知团队
- ⚠️ **可选人工确认**：关键业务建议开启

**建议配置：**
```bash
# 测试环境：积极策略
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5
RULES_MIN_SUCCESS_RATE=0.8  # 新规则成功率必须 > 80%
RULES_AUTO_ROLLBACK=true     # 自动回滚
RULES_NOTIFICATION_ENABLED=true
```

---

### 生产环境：不推荐自动更新 ❌

**不推荐的理由：**
1. ❌ **稳定性优先**：生产环境失败直接影响业务
2. ❌ **数据质量风险**：错误的规则可能导致数据错误
3. ❌ **难以追溯**：自动更新难以追溯问题原因
4. ❌ **合规风险**：某些行业需要人工审核

**但可以配置紧急模式：**
- 仅在极端情况下（成功率 < 10%）启用
- 需要管理员确认
- 严格验证和监控

**建议配置：**
```bash
# 生产环境：禁止自动更新
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_WRITE=false
RULES_REQUIRE_MANUAL_DEPLOY=true

# 可选：紧急模式（仅在极端情况下启用）
ALLOW_RULES_EMERGENCY_UPDATE=false  # 默认关闭
RULES_EMERGENCY_THRESHOLD=0.1
RULES_EMERGENCY_REQUIRE_ADMIN=true
```

---

## 📊 最终建议

### 推荐配置

**开发环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 完全自动
```

**测试环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 条件自动（成功率 < 50% 触发）
RULES_MIN_SUCCESS_RATE=0.8    # ⚠️ 新规则必须 > 80% 成功率
RULES_AUTO_ROLLBACK=true      # ✅ 自动回滚
RULES_NOTIFICATION_ENABLED=true  # ✅ 通知团队
```

**生产环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=false  # ❌ 禁止自动更新
ALLOW_RULES_EMERGENCY_UPDATE=false  # ❌ 紧急模式默认关闭
RULES_REQUIRE_MANUAL_DEPLOY=true   # ✅ 必须手动部署
```

### 总结

| 环境 | 自动更新 | 原因 |
|------|---------|------|
| **开发** | ✅ **强烈推荐** | 快速迭代，风险低 |
| **测试** | ✅ **条件推荐** | 快速验证，风险可控 |
| **生产** | ❌ **不推荐** | 稳定性优先，风险高 |

**测试环境可以自动更新，但需要：**
- 严格验证（成功率 > 80%）
- 自动回滚机制
- 通知机制
- 可选人工确认

**生产环境不建议自动更新，但可以配置紧急模式作为最后手段。**

---

## 📊 总结

### 安全等级对比

| 方案 | 文件权限 | 自动更新 | 审计日志 | 回滚 | 推荐场景 |
|------|---------|---------|---------|------|---------|
| **方案A：文件系统+权限控制** | ✅ | ✅/❌ | ✅ | ✅ | 中小型项目 |
| **方案B：数据库存储** | ✅ | ✅/❌ | ✅ | ✅ | 大型项目，多环境 |

### 关键安全措施

1. ✅ **环境隔离**：测试和生产规则完全分离
2. ✅ **权限控制**：生产环境禁止自动更新
3. ✅ **审计日志**：所有规则变更可追溯
4. ✅ **安全验证**：防止注入攻击和 ReDoS
5. ✅ **回滚机制**：快速恢复错误规则

### 推荐配置

**开发/测试环境：**
- 允许自动更新
- 文件系统存储
- 完整审计日志

**生产环境：**
- **禁止自动更新**（必须人工审核）
- 数据库存储（可选，更安全）
- 规则变更需通过 CI/CD 流程
## 📋 目录

1. [安全风险分析](#安全风险分析)
2. [权限控制方案](#权限控制方案)
3. [环境隔离策略](#环境隔离策略)
4. [审计与日志](#审计与日志)
5. [回滚机制](#回滚机制)
6. [实施建议](#实施建议)

---

## 🔒 安全风险分析

### 1. 文件系统权限风险

**问题：**
- 生产环境可能运行在受限用户下（如 `www-data`, `nobody`）
- 可能没有写入 `.cache/` 目录的权限
- Docker 容器可能挂载只读文件系统

**风险等级：** ⚠️ **高**

### 2. LLM 生成内容安全风险

**问题：**
- LLM 可能生成恶意代码（如果走路径B：生成 JavaScript）
- JSON 规则可能包含路径遍历攻击（`../../etc/passwd`）
- 规则可能被注入恶意正则表达式（ReDoS 攻击）

**风险等级：** ⚠️ **高**

### 3. 规则覆盖风险

**问题：**
- 新规则可能覆盖已验证的旧规则
- 规则文件可能被外部修改
- 没有版本控制，无法追溯变更

**风险等级：** ⚠️ **中**

### 4. 环境混淆风险

**问题：**
- 测试环境的规则可能被应用到生产环境
- 生产环境的规则可能被测试环境覆盖

**风险等级：** ⚠️ **高**

---

## 🔐 权限控制方案

### 方案 A：基于环境变量的权限控制（推荐）

```javascript
// lib/html-extraction/rules-manager.js

const RULES_CONFIG = {
  // 规则存储路径（按环境区分）
  rulesDir: process.env.RULES_CACHE_DIR || path.join(projectRoot, '.cache/rules'),
  
  // 是否允许自动更新规则（所有环境都允许）
  allowAutoUpdate: process.env.ALLOW_RULES_AUTO_UPDATE !== 'false',  // 默认允许
  
  // 是否允许写入规则文件（所有环境都允许）
  allowWriteRules: process.env.ALLOW_RULES_WRITE !== 'false',  // 默认允许
  
  // 当前环境
  environment: process.env.NODE_ENV || 'development',
  
  // 规则文件权限
  rulesFileMode: 0o644,
  
  // 重试配置
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
};

// 权限检查函数
function checkWritePermission() {
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  // 检查目录权限
  try {
    fs.accessSync(RULES_CONFIG.rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${RULES_CONFIG.rulesDir}`);
  }
}
```

**环境变量配置（所有环境统一）：**

```bash
# .env.development（开发环境）
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.staging（测试环境）
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.production（生产环境）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新（用户要求）
ALLOW_RULES_WRITE=true       # ✅ 允许写入（用户要求）
RULES_CACHE_DIR=/app/data/rules  # 使用持久化存储
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名（所有环境统一）
```

### 方案 B：基于数据库的规则存储（更安全）

如果文件系统不可写，可以将规则存储在数据库中：

```javascript
// lib/html-extraction/rules-db.js

const RULES_TABLE = 'tiktok_extraction_rules';

async function loadRulesFromDB(environment) {
  const [rows] = await query(
    `SELECT rules_json, version, created_at 
     FROM ${RULES_TABLE} 
     WHERE environment = ? AND is_active = 1 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [environment]
  );
  
  return rows[0] ? JSON.parse(rows[0].rules_json) : getDefaultRules();
}

async function saveRulesToDB(rules, environment, userId = null) {
  // 1. 验证规则
  if (!validateRules(rules)) {
    throw new Error('规则验证失败');
  }
  
  // 2. 插入新规则（不删除旧规则，用于回滚）
  await query(
    `INSERT INTO ${RULES_TABLE} 
     (environment, rules_json, version, created_by, created_at, is_active) 
     VALUES (?, ?, ?, ?, NOW(), 0)`,
    [environment, JSON.stringify(rules), generateVersion(), userId]
  );
  
  // 3. 标记为待审核（生产环境需要人工审核）
  if (environment === 'production') {
    await query(
      `UPDATE ${RULES_TABLE} SET status = 'pending_review' WHERE id = LAST_INSERT_ID()`
    );
  } else {
    // 测试环境自动激活
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 1, status = 'active' WHERE id = LAST_INSERT_ID()`
    );
    // 停用旧规则
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 0 WHERE environment = ? AND id != LAST_INSERT_ID()`,
      [environment]
    );
  }
}
```

**数据库表结构：**

```sql
CREATE TABLE tiktok_extraction_rules (
  id INT PRIMARY KEY AUTO_INCREMENT,
  environment ENUM('development', 'staging', 'production') NOT NULL,
  rules_json TEXT NOT NULL,
  version VARCHAR(50) NOT NULL,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 0,
  status ENUM('pending_review', 'active', 'rejected', 'deprecated') DEFAULT 'pending_review',
  review_notes TEXT,
  INDEX idx_env_active (environment, is_active),
  INDEX idx_env_status (environment, status)
);
```

---

## 🌍 环境隔离策略

### 1. 规则文件隔离

```
.cache/rules/
├── development/
│   ├── tiktok-rules-v1.0.json
│   ├── tiktok-rules-v1.1.json
│   └── current -> tiktok-rules-v1.1.json  (符号链接)
├── staging/
│   └── tiktok-rules-v1.0.json
└── production/
    └── tiktok-rules-v1.0.json  (只读，需手动更新)
```

### 2. 环境检测与隔离

```javascript
function getRulesPath() {
  const env = process.env.NODE_ENV || 'development';
  const rulesDir = path.join(
    RULES_CONFIG.rulesDir,
    env  // 按环境隔离
  );
  
  // 确保目录存在
  fs.mkdirSync(rulesDir, { recursive: true });
  
  return path.join(rulesDir, 'tiktok-rules-current.json');
}

function loadRules() {
  const rulesPath = getRulesPath();
  
  // 生产环境：如果文件不存在，使用默认规则（不允许自动创建）
  if (RULES_CONFIG.environment === 'production' && !fs.existsSync(rulesPath)) {
    console.warn('[规则] 生产环境未找到规则文件，使用默认规则');
    return getDefaultRules();
  }
  
  // 其他环境：如果文件不存在，创建默认规则
  if (!fs.existsSync(rulesPath)) {
    const defaultRules = getDefaultRules();
    saveRules(defaultRules);  // 自动创建
    return defaultRules;
  }
  
  return JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
}
```

---

## 📝 审计与日志

### 1. 规则变更审计日志

```javascript
// lib/html-extraction/rules-audit.js

const AUDIT_LOG_PATH = path.join(projectRoot, 'logs/rules-audit.log');

function auditRuleChange(action, details) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    environment: RULES_CONFIG.environment,
    action,  // 'create', 'update', 'delete', 'rollback'
    details,
    user: process.env.USER || 'system',
    hostname: require('os').hostname(),
  };
  
  // 写入日志文件
  fs.appendFileSync(
    AUDIT_LOG_PATH,
    JSON.stringify(logEntry) + '\n',
    'utf-8'
  );
  
  // 生产环境：同时写入数据库（如果可用）
  if (RULES_CONFIG.environment === 'production') {
    saveAuditToDB(logEntry).catch(err => {
      console.error('[审计] 写入数据库失败:', err);
    });
  }
}
```

### 2. 规则验证日志

```javascript
async function updateRulesIfNeeded(html, extractionResult) {
  if (!shouldTriggerRuleUpdate(extractionResult, 50)) return;
  
  console.log('[规则更新] 检测到提取成功率低，触发 LLM 学习...');
  
  const newRules = await generateRulesFromHTML(html);
  const validationResult = validateRules(html, newRules, extractionResult, 50);
  
  // 记录验证结果
  auditRuleChange('validate', {
    success: validationResult.ok,
    metrics: validationResult.metrics,
    ruleVersion: newRules.version,
  });
  
  if (!validationResult.ok) {
    console.warn('[规则更新] 新规则验证失败，保持使用当前规则');
    return;
  }
  
  // 保存规则（会触发权限检查）
  try {
    saveRules(newRules);
    auditRuleChange('update', {
      ruleVersion: newRules.version,
      metrics: validationResult.metrics,
    });
  } catch (e) {
    auditRuleChange('update_failed', {
      error: e.message,
      ruleVersion: newRules.version,
    });
    throw e;
  }
}
```

---

## 🔄 回滚机制

### 1. 版本化规则存储

```javascript
function saveRules(rules) {
  checkWritePermission();  // 权限检查
  
  const rulesPath = getRulesPath();
  const version = rules.version || generateVersion();
  
  // 1. 保存版本化文件
  const versionedPath = rulesPath.replace('current.json', `v${version}.json`);
  fs.writeFileSync(versionedPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 2. 更新 current.json（符号链接或直接复制）
  if (RULES_CONFIG.environment === 'production') {
    // 生产环境：创建备份后再更新
    const backupPath = `${rulesPath}.backup.${Date.now()}`;
    if (fs.existsSync(rulesPath)) {
      fs.copyFileSync(rulesPath, backupPath);
    }
  }
  
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 3. 记录变更
  auditRuleChange('update', { version });
}

function rollbackRules(targetVersion) {
  checkWritePermission();
  
  const rulesPath = getRulesPath();
  const versionedPath = rulesPath.replace('current.json', `v${targetVersion}.json`);
  
  if (!fs.existsSync(versionedPath)) {
    throw new Error(`版本 ${targetVersion} 不存在`);
  }
  
  const rules = JSON.parse(fs.readFileSync(versionedPath, 'utf-8'));
  saveRules(rules);
  
  auditRuleChange('rollback', { targetVersion });
}
```

### 2. 自动回滚机制

```javascript
async function updateRulesWithAutoRollback(html, extractionResult) {
  const currentRules = loadRules();
  const currentVersion = currentRules.version;
  
  try {
    await updateRulesIfNeeded(html, extractionResult);
    
    // 验证新规则（运行一次完整提取）
    const testResult = extractWithRules(html, loadRules());
    if (!validateRules(html, loadRules(), testResult, 50).ok) {
      throw new Error('新规则验证失败');
    }
  } catch (e) {
    console.error('[规则更新] 自动回滚到版本:', currentVersion);
    
    // 回滚到之前的版本
    rollbackRules(currentVersion);
    
    auditRuleChange('auto_rollback', {
      error: e.message,
      rolledBackTo: currentVersion,
    });
    
    throw e;
  }
}
```

---

## 🛡️ 安全验证

### 1. 规则内容安全验证

```javascript
function validateRuleSecurity(rules) {
  const issues = [];
  
  // 1. 检查 JSON 结构合法性
  if (!rules.video || !rules.user) {
    issues.push('规则结构不完整');
  }
  
  // 2. 检查正则表达式安全性（防止 ReDoS）
  function checkRegexSafety(pattern) {
    // 简单检查：避免嵌套量词
    if (/(\*|\+|\?|\{.*,.*\}).*\1/.test(pattern)) {
      issues.push(`潜在 ReDoS 风险的正则: ${pattern}`);
    }
  }
  
  // 3. 检查路径遍历攻击
  function checkPathTraversal(value) {
    if (typeof value === 'string' && value.includes('../')) {
      issues.push(`潜在路径遍历攻击: ${value}`);
    }
  }
  
  // 递归检查所有字符串值
  function traverse(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        checkPathTraversal(value);
        if (key === 'pattern' || key.includes('regex')) {
          checkRegexSafety(value);
        }
      } else if (typeof value === 'object' && value !== null) {
        traverse(value);
      }
    }
  }
  
  traverse(rules);
  
  if (issues.length > 0) {
    throw new Error(`规则安全验证失败:\n${issues.join('\n')}`);
  }
  
  return true;
}
```

### 2. LLM 输出内容验证

```javascript
async function generateRulesFromHTML(html) {
  const response = await callDeepSeekLLM([...], systemPrompt);
  
  // 1. 提取 JSON（移除 markdown 代码块）
  let jsonStr = extractJSON(response);
  
  // 2. 解析 JSON
  let rules;
  try {
    rules = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`LLM 返回的不是有效 JSON: ${e.message}`);
  }
  
  // 3. 安全验证
  validateRuleSecurity(rules);
  
  // 4. 结构验证
  if (!rules.video || !rules.user) {
    throw new Error('规则缺少必要字段');
  }
  
  // 5. 添加元数据
  rules.version = generateVersion();
  rules.generatedAt = new Date().toISOString();
  rules.environment = RULES_CONFIG.environment;
  
  return rules;
}
```

---

## ✅ 实施建议

### 环境自动更新策略对比

| 环境 | 自动更新 | 验证要求 | 回滚机制 | 推荐场景 |
|------|---------|---------|---------|---------|
| **开发环境** | ✅ **强烈推荐** | 基础验证 | 自动回滚 | 快速迭代，频繁测试 |
| **测试环境** | ⚠️ **条件推荐** | 严格验证 + 人工确认 | 自动回滚 + 告警 | 验证新规则稳定性 |
| **生产环境** | ❌ **不推荐** | 人工审核 + 灰度发布 | 快速回滚 + 监控 | 稳定性优先 |

---

### 阶段 1：开发环境（立即实施）

**策略：完全自动更新**

1. ✅ 实现文件系统规则存储
2. ✅ 添加权限检查（基于环境变量）
3. ✅ 实现审计日志
4. ✅ 实现版本化存储

**配置：**
```bash
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发更新
```

**优点：**
- 快速适应 TikTok 改版
- 减少人工维护成本
- 适合频繁测试

---

### 阶段 2：测试环境（1-2周后）

**策略：条件自动更新（推荐）**

**方案 A：保守策略（推荐用于关键业务）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.3  # 成功率 < 30% 才触发
RULES_REQUIRE_MANUAL_CONFIRM=true  # 需要人工确认
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**方案 B：积极策略（推荐用于快速迭代）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发
RULES_REQUIRE_MANUAL_CONFIRM=false  # 自动应用
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**实现要点：**
1. ✅ 更严格的验证（成功率 > 80% 才应用）
2. ✅ 自动回滚（验证失败立即回滚）
3. ✅ 通知机制（Slack/邮件通知规则变更）
4. ✅ 可选人工确认（关键业务建议开启）

**建议：**
- **如果你的测试环境用于验证生产前准备**：使用方案 A（保守）
- **如果你的测试环境用于快速迭代**：使用方案 B（积极）

---

### 阶段 3：生产环境（1个月后）

**策略：禁止自动更新（强烈推荐）**

**配置：**
```bash
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false  # 🔒 禁止自动更新
ALLOW_RULES_WRITE=false        # 🔒 禁止写入
RULES_REQUIRE_MANUAL_DEPLOY=true  # 必须手动部署
```

**更新流程（所有环境统一）：**
```
1. 检测到去重后的用户名数量 < 10 → 触发规则更新
2. 第 1 次尝试：LLM 生成规则 → 验证（至少 10 个红人用户名）
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒后重试
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒后重试
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️（记录日志，发送告警）
```

**关键点：**
- ✅ **触发条件**：去重后的用户名数量 < 10
- ✅ 所有环境都允许自动更新
- ✅ 必须达到验证阈值（至少 10 个红人用户名）才应用
- ✅ 未达到阈值时重试最多 3 次
- ✅ 3 次都失败则继续使用旧规则，不中断任务

**例外情况：紧急自动更新（不推荐，但可配置）**

如果 TikTok 突然大规模改版，导致提取完全失败，可以配置紧急模式：

```bash
# 紧急模式（仅在极端情况下启用）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_EMERGENCY_UPDATE=true  # 紧急更新开关
RULES_EMERGENCY_THRESHOLD=0.1      # 成功率 < 10% 才触发
RULES_EMERGENCY_REQUIRE_ADMIN=true # 需要管理员确认
```

**紧急更新流程：**
```
1. 检测到成功率 < 10%（严重失败）
2. 发送紧急告警（电话/短信）
3. 等待管理员确认（5分钟内）
4. 如果确认 → LLM 生成新规则 → 严格验证 → 应用
5. 如果未确认 → 保持旧规则，继续告警
```

---

## 🤔 是否建议测试和生产环境自动更新？

### 测试环境：条件推荐 ✅

**推荐自动更新的理由：**
1. ✅ **快速验证**：TikTok 改版后，测试环境可以快速适应
2. ✅ **降低维护成本**：减少人工干预
3. ✅ **风险可控**：测试环境失败不影响生产

**但需要：**
- ⚠️ **严格验证**：成功率必须 > 80% 才应用
- ⚠️ **自动回滚**：验证失败立即回滚
- ⚠️ **通知机制**：规则变更必须通知团队
- ⚠️ **可选人工确认**：关键业务建议开启

**建议配置：**
```bash
# 测试环境：积极策略
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5
RULES_MIN_SUCCESS_RATE=0.8  # 新规则成功率必须 > 80%
RULES_AUTO_ROLLBACK=true     # 自动回滚
RULES_NOTIFICATION_ENABLED=true
```

---

### 生产环境：不推荐自动更新 ❌

**不推荐的理由：**
1. ❌ **稳定性优先**：生产环境失败直接影响业务
2. ❌ **数据质量风险**：错误的规则可能导致数据错误
3. ❌ **难以追溯**：自动更新难以追溯问题原因
4. ❌ **合规风险**：某些行业需要人工审核

**但可以配置紧急模式：**
- 仅在极端情况下（成功率 < 10%）启用
- 需要管理员确认
- 严格验证和监控

**建议配置：**
```bash
# 生产环境：禁止自动更新
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_WRITE=false
RULES_REQUIRE_MANUAL_DEPLOY=true

# 可选：紧急模式（仅在极端情况下启用）
ALLOW_RULES_EMERGENCY_UPDATE=false  # 默认关闭
RULES_EMERGENCY_THRESHOLD=0.1
RULES_EMERGENCY_REQUIRE_ADMIN=true
```

---

## 📊 最终建议

### 推荐配置

**开发环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 完全自动
```

**测试环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 条件自动（成功率 < 50% 触发）
RULES_MIN_SUCCESS_RATE=0.8    # ⚠️ 新规则必须 > 80% 成功率
RULES_AUTO_ROLLBACK=true      # ✅ 自动回滚
RULES_NOTIFICATION_ENABLED=true  # ✅ 通知团队
```

**生产环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=false  # ❌ 禁止自动更新
ALLOW_RULES_EMERGENCY_UPDATE=false  # ❌ 紧急模式默认关闭
RULES_REQUIRE_MANUAL_DEPLOY=true   # ✅ 必须手动部署
```

### 总结

| 环境 | 自动更新 | 原因 |
|------|---------|------|
| **开发** | ✅ **强烈推荐** | 快速迭代，风险低 |
| **测试** | ✅ **条件推荐** | 快速验证，风险可控 |
| **生产** | ❌ **不推荐** | 稳定性优先，风险高 |

**测试环境可以自动更新，但需要：**
- 严格验证（成功率 > 80%）
- 自动回滚机制
- 通知机制
- 可选人工确认

**生产环境不建议自动更新，但可以配置紧急模式作为最后手段。**

---

## 📊 总结

### 安全等级对比

| 方案 | 文件权限 | 自动更新 | 审计日志 | 回滚 | 推荐场景 |
|------|---------|---------|---------|------|---------|
| **方案A：文件系统+权限控制** | ✅ | ✅/❌ | ✅ | ✅ | 中小型项目 |
| **方案B：数据库存储** | ✅ | ✅/❌ | ✅ | ✅ | 大型项目，多环境 |

### 关键安全措施

1. ✅ **环境隔离**：测试和生产规则完全分离
2. ✅ **权限控制**：生产环境禁止自动更新
3. ✅ **审计日志**：所有规则变更可追溯
4. ✅ **安全验证**：防止注入攻击和 ReDoS
5. ✅ **回滚机制**：快速恢复错误规则

### 推荐配置

**开发/测试环境：**
- 允许自动更新
- 文件系统存储
- 完整审计日志

**生产环境：**
- **禁止自动更新**（必须人工审核）
- 数据库存储（可选，更安全）
- 规则变更需通过 CI/CD 流程
## 📋 目录

1. [安全风险分析](#安全风险分析)
2. [权限控制方案](#权限控制方案)
3. [环境隔离策略](#环境隔离策略)
4. [审计与日志](#审计与日志)
5. [回滚机制](#回滚机制)
6. [实施建议](#实施建议)

---

## 🔒 安全风险分析

### 1. 文件系统权限风险

**问题：**
- 生产环境可能运行在受限用户下（如 `www-data`, `nobody`）
- 可能没有写入 `.cache/` 目录的权限
- Docker 容器可能挂载只读文件系统

**风险等级：** ⚠️ **高**

### 2. LLM 生成内容安全风险

**问题：**
- LLM 可能生成恶意代码（如果走路径B：生成 JavaScript）
- JSON 规则可能包含路径遍历攻击（`../../etc/passwd`）
- 规则可能被注入恶意正则表达式（ReDoS 攻击）

**风险等级：** ⚠️ **高**

### 3. 规则覆盖风险

**问题：**
- 新规则可能覆盖已验证的旧规则
- 规则文件可能被外部修改
- 没有版本控制，无法追溯变更

**风险等级：** ⚠️ **中**

### 4. 环境混淆风险

**问题：**
- 测试环境的规则可能被应用到生产环境
- 生产环境的规则可能被测试环境覆盖

**风险等级：** ⚠️ **高**

---

## 🔐 权限控制方案

### 方案 A：基于环境变量的权限控制（推荐）

```javascript
// lib/html-extraction/rules-manager.js

const RULES_CONFIG = {
  // 规则存储路径（按环境区分）
  rulesDir: process.env.RULES_CACHE_DIR || path.join(projectRoot, '.cache/rules'),
  
  // 是否允许自动更新规则（所有环境都允许）
  allowAutoUpdate: process.env.ALLOW_RULES_AUTO_UPDATE !== 'false',  // 默认允许
  
  // 是否允许写入规则文件（所有环境都允许）
  allowWriteRules: process.env.ALLOW_RULES_WRITE !== 'false',  // 默认允许
  
  // 当前环境
  environment: process.env.NODE_ENV || 'development',
  
  // 规则文件权限
  rulesFileMode: 0o644,
  
  // 重试配置
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
};

// 权限检查函数
function checkWritePermission() {
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  // 检查目录权限
  try {
    fs.accessSync(RULES_CONFIG.rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${RULES_CONFIG.rulesDir}`);
  }
}
```

**环境变量配置（所有环境统一）：**

```bash
# .env.development（开发环境）
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.staging（测试环境）
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.production（生产环境）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新（用户要求）
ALLOW_RULES_WRITE=true       # ✅ 允许写入（用户要求）
RULES_CACHE_DIR=/app/data/rules  # 使用持久化存储
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名（所有环境统一）
```

### 方案 B：基于数据库的规则存储（更安全）

如果文件系统不可写，可以将规则存储在数据库中：

```javascript
// lib/html-extraction/rules-db.js

const RULES_TABLE = 'tiktok_extraction_rules';

async function loadRulesFromDB(environment) {
  const [rows] = await query(
    `SELECT rules_json, version, created_at 
     FROM ${RULES_TABLE} 
     WHERE environment = ? AND is_active = 1 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [environment]
  );
  
  return rows[0] ? JSON.parse(rows[0].rules_json) : getDefaultRules();
}

async function saveRulesToDB(rules, environment, userId = null) {
  // 1. 验证规则
  if (!validateRules(rules)) {
    throw new Error('规则验证失败');
  }
  
  // 2. 插入新规则（不删除旧规则，用于回滚）
  await query(
    `INSERT INTO ${RULES_TABLE} 
     (environment, rules_json, version, created_by, created_at, is_active) 
     VALUES (?, ?, ?, ?, NOW(), 0)`,
    [environment, JSON.stringify(rules), generateVersion(), userId]
  );
  
  // 3. 标记为待审核（生产环境需要人工审核）
  if (environment === 'production') {
    await query(
      `UPDATE ${RULES_TABLE} SET status = 'pending_review' WHERE id = LAST_INSERT_ID()`
    );
  } else {
    // 测试环境自动激活
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 1, status = 'active' WHERE id = LAST_INSERT_ID()`
    );
    // 停用旧规则
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 0 WHERE environment = ? AND id != LAST_INSERT_ID()`,
      [environment]
    );
  }
}
```

**数据库表结构：**

```sql
CREATE TABLE tiktok_extraction_rules (
  id INT PRIMARY KEY AUTO_INCREMENT,
  environment ENUM('development', 'staging', 'production') NOT NULL,
  rules_json TEXT NOT NULL,
  version VARCHAR(50) NOT NULL,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 0,
  status ENUM('pending_review', 'active', 'rejected', 'deprecated') DEFAULT 'pending_review',
  review_notes TEXT,
  INDEX idx_env_active (environment, is_active),
  INDEX idx_env_status (environment, status)
);
```

---

## 🌍 环境隔离策略

### 1. 规则文件隔离

```
.cache/rules/
├── development/
│   ├── tiktok-rules-v1.0.json
│   ├── tiktok-rules-v1.1.json
│   └── current -> tiktok-rules-v1.1.json  (符号链接)
├── staging/
│   └── tiktok-rules-v1.0.json
└── production/
    └── tiktok-rules-v1.0.json  (只读，需手动更新)
```

### 2. 环境检测与隔离

```javascript
function getRulesPath() {
  const env = process.env.NODE_ENV || 'development';
  const rulesDir = path.join(
    RULES_CONFIG.rulesDir,
    env  // 按环境隔离
  );
  
  // 确保目录存在
  fs.mkdirSync(rulesDir, { recursive: true });
  
  return path.join(rulesDir, 'tiktok-rules-current.json');
}

function loadRules() {
  const rulesPath = getRulesPath();
  
  // 生产环境：如果文件不存在，使用默认规则（不允许自动创建）
  if (RULES_CONFIG.environment === 'production' && !fs.existsSync(rulesPath)) {
    console.warn('[规则] 生产环境未找到规则文件，使用默认规则');
    return getDefaultRules();
  }
  
  // 其他环境：如果文件不存在，创建默认规则
  if (!fs.existsSync(rulesPath)) {
    const defaultRules = getDefaultRules();
    saveRules(defaultRules);  // 自动创建
    return defaultRules;
  }
  
  return JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
}
```

---

## 📝 审计与日志

### 1. 规则变更审计日志

```javascript
// lib/html-extraction/rules-audit.js

const AUDIT_LOG_PATH = path.join(projectRoot, 'logs/rules-audit.log');

function auditRuleChange(action, details) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    environment: RULES_CONFIG.environment,
    action,  // 'create', 'update', 'delete', 'rollback'
    details,
    user: process.env.USER || 'system',
    hostname: require('os').hostname(),
  };
  
  // 写入日志文件
  fs.appendFileSync(
    AUDIT_LOG_PATH,
    JSON.stringify(logEntry) + '\n',
    'utf-8'
  );
  
  // 生产环境：同时写入数据库（如果可用）
  if (RULES_CONFIG.environment === 'production') {
    saveAuditToDB(logEntry).catch(err => {
      console.error('[审计] 写入数据库失败:', err);
    });
  }
}
```

### 2. 规则验证日志

```javascript
async function updateRulesIfNeeded(html, extractionResult) {
  if (!shouldTriggerRuleUpdate(extractionResult, 50)) return;
  
  console.log('[规则更新] 检测到提取成功率低，触发 LLM 学习...');
  
  const newRules = await generateRulesFromHTML(html);
  const validationResult = validateRules(html, newRules, extractionResult, 50);
  
  // 记录验证结果
  auditRuleChange('validate', {
    success: validationResult.ok,
    metrics: validationResult.metrics,
    ruleVersion: newRules.version,
  });
  
  if (!validationResult.ok) {
    console.warn('[规则更新] 新规则验证失败，保持使用当前规则');
    return;
  }
  
  // 保存规则（会触发权限检查）
  try {
    saveRules(newRules);
    auditRuleChange('update', {
      ruleVersion: newRules.version,
      metrics: validationResult.metrics,
    });
  } catch (e) {
    auditRuleChange('update_failed', {
      error: e.message,
      ruleVersion: newRules.version,
    });
    throw e;
  }
}
```

---

## 🔄 回滚机制

### 1. 版本化规则存储

```javascript
function saveRules(rules) {
  checkWritePermission();  // 权限检查
  
  const rulesPath = getRulesPath();
  const version = rules.version || generateVersion();
  
  // 1. 保存版本化文件
  const versionedPath = rulesPath.replace('current.json', `v${version}.json`);
  fs.writeFileSync(versionedPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 2. 更新 current.json（符号链接或直接复制）
  if (RULES_CONFIG.environment === 'production') {
    // 生产环境：创建备份后再更新
    const backupPath = `${rulesPath}.backup.${Date.now()}`;
    if (fs.existsSync(rulesPath)) {
      fs.copyFileSync(rulesPath, backupPath);
    }
  }
  
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 3. 记录变更
  auditRuleChange('update', { version });
}

function rollbackRules(targetVersion) {
  checkWritePermission();
  
  const rulesPath = getRulesPath();
  const versionedPath = rulesPath.replace('current.json', `v${targetVersion}.json`);
  
  if (!fs.existsSync(versionedPath)) {
    throw new Error(`版本 ${targetVersion} 不存在`);
  }
  
  const rules = JSON.parse(fs.readFileSync(versionedPath, 'utf-8'));
  saveRules(rules);
  
  auditRuleChange('rollback', { targetVersion });
}
```

### 2. 自动回滚机制

```javascript
async function updateRulesWithAutoRollback(html, extractionResult) {
  const currentRules = loadRules();
  const currentVersion = currentRules.version;
  
  try {
    await updateRulesIfNeeded(html, extractionResult);
    
    // 验证新规则（运行一次完整提取）
    const testResult = extractWithRules(html, loadRules());
    if (!validateRules(html, loadRules(), testResult, 50).ok) {
      throw new Error('新规则验证失败');
    }
  } catch (e) {
    console.error('[规则更新] 自动回滚到版本:', currentVersion);
    
    // 回滚到之前的版本
    rollbackRules(currentVersion);
    
    auditRuleChange('auto_rollback', {
      error: e.message,
      rolledBackTo: currentVersion,
    });
    
    throw e;
  }
}
```

---

## 🛡️ 安全验证

### 1. 规则内容安全验证

```javascript
function validateRuleSecurity(rules) {
  const issues = [];
  
  // 1. 检查 JSON 结构合法性
  if (!rules.video || !rules.user) {
    issues.push('规则结构不完整');
  }
  
  // 2. 检查正则表达式安全性（防止 ReDoS）
  function checkRegexSafety(pattern) {
    // 简单检查：避免嵌套量词
    if (/(\*|\+|\?|\{.*,.*\}).*\1/.test(pattern)) {
      issues.push(`潜在 ReDoS 风险的正则: ${pattern}`);
    }
  }
  
  // 3. 检查路径遍历攻击
  function checkPathTraversal(value) {
    if (typeof value === 'string' && value.includes('../')) {
      issues.push(`潜在路径遍历攻击: ${value}`);
    }
  }
  
  // 递归检查所有字符串值
  function traverse(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        checkPathTraversal(value);
        if (key === 'pattern' || key.includes('regex')) {
          checkRegexSafety(value);
        }
      } else if (typeof value === 'object' && value !== null) {
        traverse(value);
      }
    }
  }
  
  traverse(rules);
  
  if (issues.length > 0) {
    throw new Error(`规则安全验证失败:\n${issues.join('\n')}`);
  }
  
  return true;
}
```

### 2. LLM 输出内容验证

```javascript
async function generateRulesFromHTML(html) {
  const response = await callDeepSeekLLM([...], systemPrompt);
  
  // 1. 提取 JSON（移除 markdown 代码块）
  let jsonStr = extractJSON(response);
  
  // 2. 解析 JSON
  let rules;
  try {
    rules = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`LLM 返回的不是有效 JSON: ${e.message}`);
  }
  
  // 3. 安全验证
  validateRuleSecurity(rules);
  
  // 4. 结构验证
  if (!rules.video || !rules.user) {
    throw new Error('规则缺少必要字段');
  }
  
  // 5. 添加元数据
  rules.version = generateVersion();
  rules.generatedAt = new Date().toISOString();
  rules.environment = RULES_CONFIG.environment;
  
  return rules;
}
```

---

## ✅ 实施建议

### 环境自动更新策略对比

| 环境 | 自动更新 | 验证要求 | 回滚机制 | 推荐场景 |
|------|---------|---------|---------|---------|
| **开发环境** | ✅ **强烈推荐** | 基础验证 | 自动回滚 | 快速迭代，频繁测试 |
| **测试环境** | ⚠️ **条件推荐** | 严格验证 + 人工确认 | 自动回滚 + 告警 | 验证新规则稳定性 |
| **生产环境** | ❌ **不推荐** | 人工审核 + 灰度发布 | 快速回滚 + 监控 | 稳定性优先 |

---

### 阶段 1：开发环境（立即实施）

**策略：完全自动更新**

1. ✅ 实现文件系统规则存储
2. ✅ 添加权限检查（基于环境变量）
3. ✅ 实现审计日志
4. ✅ 实现版本化存储

**配置：**
```bash
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发更新
```

**优点：**
- 快速适应 TikTok 改版
- 减少人工维护成本
- 适合频繁测试

---

### 阶段 2：测试环境（1-2周后）

**策略：条件自动更新（推荐）**

**方案 A：保守策略（推荐用于关键业务）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.3  # 成功率 < 30% 才触发
RULES_REQUIRE_MANUAL_CONFIRM=true  # 需要人工确认
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**方案 B：积极策略（推荐用于快速迭代）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发
RULES_REQUIRE_MANUAL_CONFIRM=false  # 自动应用
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**实现要点：**
1. ✅ 更严格的验证（成功率 > 80% 才应用）
2. ✅ 自动回滚（验证失败立即回滚）
3. ✅ 通知机制（Slack/邮件通知规则变更）
4. ✅ 可选人工确认（关键业务建议开启）

**建议：**
- **如果你的测试环境用于验证生产前准备**：使用方案 A（保守）
- **如果你的测试环境用于快速迭代**：使用方案 B（积极）

---

### 阶段 3：生产环境（1个月后）

**策略：禁止自动更新（强烈推荐）**

**配置：**
```bash
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false  # 🔒 禁止自动更新
ALLOW_RULES_WRITE=false        # 🔒 禁止写入
RULES_REQUIRE_MANUAL_DEPLOY=true  # 必须手动部署
```

**更新流程（所有环境统一）：**
```
1. 检测到去重后的用户名数量 < 10 → 触发规则更新
2. 第 1 次尝试：LLM 生成规则 → 验证（至少 10 个红人用户名）
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒后重试
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒后重试
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️（记录日志，发送告警）
```

**关键点：**
- ✅ **触发条件**：去重后的用户名数量 < 10
- ✅ 所有环境都允许自动更新
- ✅ 必须达到验证阈值（至少 10 个红人用户名）才应用
- ✅ 未达到阈值时重试最多 3 次
- ✅ 3 次都失败则继续使用旧规则，不中断任务

**例外情况：紧急自动更新（不推荐，但可配置）**

如果 TikTok 突然大规模改版，导致提取完全失败，可以配置紧急模式：

```bash
# 紧急模式（仅在极端情况下启用）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_EMERGENCY_UPDATE=true  # 紧急更新开关
RULES_EMERGENCY_THRESHOLD=0.1      # 成功率 < 10% 才触发
RULES_EMERGENCY_REQUIRE_ADMIN=true # 需要管理员确认
```

**紧急更新流程：**
```
1. 检测到成功率 < 10%（严重失败）
2. 发送紧急告警（电话/短信）
3. 等待管理员确认（5分钟内）
4. 如果确认 → LLM 生成新规则 → 严格验证 → 应用
5. 如果未确认 → 保持旧规则，继续告警
```

---

## 🤔 是否建议测试和生产环境自动更新？

### 测试环境：条件推荐 ✅

**推荐自动更新的理由：**
1. ✅ **快速验证**：TikTok 改版后，测试环境可以快速适应
2. ✅ **降低维护成本**：减少人工干预
3. ✅ **风险可控**：测试环境失败不影响生产

**但需要：**
- ⚠️ **严格验证**：成功率必须 > 80% 才应用
- ⚠️ **自动回滚**：验证失败立即回滚
- ⚠️ **通知机制**：规则变更必须通知团队
- ⚠️ **可选人工确认**：关键业务建议开启

**建议配置：**
```bash
# 测试环境：积极策略
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5
RULES_MIN_SUCCESS_RATE=0.8  # 新规则成功率必须 > 80%
RULES_AUTO_ROLLBACK=true     # 自动回滚
RULES_NOTIFICATION_ENABLED=true
```

---

### 生产环境：不推荐自动更新 ❌

**不推荐的理由：**
1. ❌ **稳定性优先**：生产环境失败直接影响业务
2. ❌ **数据质量风险**：错误的规则可能导致数据错误
3. ❌ **难以追溯**：自动更新难以追溯问题原因
4. ❌ **合规风险**：某些行业需要人工审核

**但可以配置紧急模式：**
- 仅在极端情况下（成功率 < 10%）启用
- 需要管理员确认
- 严格验证和监控

**建议配置：**
```bash
# 生产环境：禁止自动更新
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_WRITE=false
RULES_REQUIRE_MANUAL_DEPLOY=true

# 可选：紧急模式（仅在极端情况下启用）
ALLOW_RULES_EMERGENCY_UPDATE=false  # 默认关闭
RULES_EMERGENCY_THRESHOLD=0.1
RULES_EMERGENCY_REQUIRE_ADMIN=true
```

---

## 📊 最终建议

### 推荐配置

**开发环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 完全自动
```

**测试环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 条件自动（成功率 < 50% 触发）
RULES_MIN_SUCCESS_RATE=0.8    # ⚠️ 新规则必须 > 80% 成功率
RULES_AUTO_ROLLBACK=true      # ✅ 自动回滚
RULES_NOTIFICATION_ENABLED=true  # ✅ 通知团队
```

**生产环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=false  # ❌ 禁止自动更新
ALLOW_RULES_EMERGENCY_UPDATE=false  # ❌ 紧急模式默认关闭
RULES_REQUIRE_MANUAL_DEPLOY=true   # ✅ 必须手动部署
```

### 总结

| 环境 | 自动更新 | 原因 |
|------|---------|------|
| **开发** | ✅ **强烈推荐** | 快速迭代，风险低 |
| **测试** | ✅ **条件推荐** | 快速验证，风险可控 |
| **生产** | ❌ **不推荐** | 稳定性优先，风险高 |

**测试环境可以自动更新，但需要：**
- 严格验证（成功率 > 80%）
- 自动回滚机制
- 通知机制
- 可选人工确认

**生产环境不建议自动更新，但可以配置紧急模式作为最后手段。**

---

## 📊 总结

### 安全等级对比

| 方案 | 文件权限 | 自动更新 | 审计日志 | 回滚 | 推荐场景 |
|------|---------|---------|---------|------|---------|
| **方案A：文件系统+权限控制** | ✅ | ✅/❌ | ✅ | ✅ | 中小型项目 |
| **方案B：数据库存储** | ✅ | ✅/❌ | ✅ | ✅ | 大型项目，多环境 |

### 关键安全措施

1. ✅ **环境隔离**：测试和生产规则完全分离
2. ✅ **权限控制**：生产环境禁止自动更新
3. ✅ **审计日志**：所有规则变更可追溯
4. ✅ **安全验证**：防止注入攻击和 ReDoS
5. ✅ **回滚机制**：快速恢复错误规则

### 推荐配置

**开发/测试环境：**
- 允许自动更新
- 文件系统存储
- 完整审计日志

**生产环境：**
- **禁止自动更新**（必须人工审核）
- 数据库存储（可选，更安全）
- 规则变更需通过 CI/CD 流程
## 📋 目录

1. [安全风险分析](#安全风险分析)
2. [权限控制方案](#权限控制方案)
3. [环境隔离策略](#环境隔离策略)
4. [审计与日志](#审计与日志)
5. [回滚机制](#回滚机制)
6. [实施建议](#实施建议)

---

## 🔒 安全风险分析

### 1. 文件系统权限风险

**问题：**
- 生产环境可能运行在受限用户下（如 `www-data`, `nobody`）
- 可能没有写入 `.cache/` 目录的权限
- Docker 容器可能挂载只读文件系统

**风险等级：** ⚠️ **高**

### 2. LLM 生成内容安全风险

**问题：**
- LLM 可能生成恶意代码（如果走路径B：生成 JavaScript）
- JSON 规则可能包含路径遍历攻击（`../../etc/passwd`）
- 规则可能被注入恶意正则表达式（ReDoS 攻击）

**风险等级：** ⚠️ **高**

### 3. 规则覆盖风险

**问题：**
- 新规则可能覆盖已验证的旧规则
- 规则文件可能被外部修改
- 没有版本控制，无法追溯变更

**风险等级：** ⚠️ **中**

### 4. 环境混淆风险

**问题：**
- 测试环境的规则可能被应用到生产环境
- 生产环境的规则可能被测试环境覆盖

**风险等级：** ⚠️ **高**

---

## 🔐 权限控制方案

### 方案 A：基于环境变量的权限控制（推荐）

```javascript
// lib/html-extraction/rules-manager.js

const RULES_CONFIG = {
  // 规则存储路径（按环境区分）
  rulesDir: process.env.RULES_CACHE_DIR || path.join(projectRoot, '.cache/rules'),
  
  // 是否允许自动更新规则（所有环境都允许）
  allowAutoUpdate: process.env.ALLOW_RULES_AUTO_UPDATE !== 'false',  // 默认允许
  
  // 是否允许写入规则文件（所有环境都允许）
  allowWriteRules: process.env.ALLOW_RULES_WRITE !== 'false',  // 默认允许
  
  // 当前环境
  environment: process.env.NODE_ENV || 'development',
  
  // 规则文件权限
  rulesFileMode: 0o644,
  
  // 重试配置
  maxRetries: parseInt(process.env.RULES_MAX_RETRIES || '3'),  // 最多重试 3 次
  retryDelay: parseInt(process.env.RULES_RETRY_DELAY || '2000'),  // 基础延迟 2 秒
};

// 权限检查函数
function checkWritePermission() {
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  // 检查目录权限
  try {
    fs.accessSync(RULES_CONFIG.rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${RULES_CONFIG.rulesDir}`);
  }
}
```

**环境变量配置（所有环境统一）：**

```bash
# .env.development（开发环境）
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.staging（测试环境）
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新
ALLOW_RULES_WRITE=true       # ✅ 允许写入
RULES_CACHE_DIR=.cache/rules
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名

# .env.production（生产环境）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 允许自动更新（用户要求）
ALLOW_RULES_WRITE=true       # ✅ 允许写入（用户要求）
RULES_CACHE_DIR=/app/data/rules  # 使用持久化存储
RULES_MAX_RETRIES=3          # 最多重试 3 次
RULES_MIN_USERNAME_COUNT=10  # 至少 10 个红人用户名（所有环境统一）
```

### 方案 B：基于数据库的规则存储（更安全）

如果文件系统不可写，可以将规则存储在数据库中：

```javascript
// lib/html-extraction/rules-db.js

const RULES_TABLE = 'tiktok_extraction_rules';

async function loadRulesFromDB(environment) {
  const [rows] = await query(
    `SELECT rules_json, version, created_at 
     FROM ${RULES_TABLE} 
     WHERE environment = ? AND is_active = 1 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [environment]
  );
  
  return rows[0] ? JSON.parse(rows[0].rules_json) : getDefaultRules();
}

async function saveRulesToDB(rules, environment, userId = null) {
  // 1. 验证规则
  if (!validateRules(rules)) {
    throw new Error('规则验证失败');
  }
  
  // 2. 插入新规则（不删除旧规则，用于回滚）
  await query(
    `INSERT INTO ${RULES_TABLE} 
     (environment, rules_json, version, created_by, created_at, is_active) 
     VALUES (?, ?, ?, ?, NOW(), 0)`,
    [environment, JSON.stringify(rules), generateVersion(), userId]
  );
  
  // 3. 标记为待审核（生产环境需要人工审核）
  if (environment === 'production') {
    await query(
      `UPDATE ${RULES_TABLE} SET status = 'pending_review' WHERE id = LAST_INSERT_ID()`
    );
  } else {
    // 测试环境自动激活
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 1, status = 'active' WHERE id = LAST_INSERT_ID()`
    );
    // 停用旧规则
    await query(
      `UPDATE ${RULES_TABLE} SET is_active = 0 WHERE environment = ? AND id != LAST_INSERT_ID()`,
      [environment]
    );
  }
}
```

**数据库表结构：**

```sql
CREATE TABLE tiktok_extraction_rules (
  id INT PRIMARY KEY AUTO_INCREMENT,
  environment ENUM('development', 'staging', 'production') NOT NULL,
  rules_json TEXT NOT NULL,
  version VARCHAR(50) NOT NULL,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 0,
  status ENUM('pending_review', 'active', 'rejected', 'deprecated') DEFAULT 'pending_review',
  review_notes TEXT,
  INDEX idx_env_active (environment, is_active),
  INDEX idx_env_status (environment, status)
);
```

---

## 🌍 环境隔离策略

### 1. 规则文件隔离

```
.cache/rules/
├── development/
│   ├── tiktok-rules-v1.0.json
│   ├── tiktok-rules-v1.1.json
│   └── current -> tiktok-rules-v1.1.json  (符号链接)
├── staging/
│   └── tiktok-rules-v1.0.json
└── production/
    └── tiktok-rules-v1.0.json  (只读，需手动更新)
```

### 2. 环境检测与隔离

```javascript
function getRulesPath() {
  const env = process.env.NODE_ENV || 'development';
  const rulesDir = path.join(
    RULES_CONFIG.rulesDir,
    env  // 按环境隔离
  );
  
  // 确保目录存在
  fs.mkdirSync(rulesDir, { recursive: true });
  
  return path.join(rulesDir, 'tiktok-rules-current.json');
}

function loadRules() {
  const rulesPath = getRulesPath();
  
  // 生产环境：如果文件不存在，使用默认规则（不允许自动创建）
  if (RULES_CONFIG.environment === 'production' && !fs.existsSync(rulesPath)) {
    console.warn('[规则] 生产环境未找到规则文件，使用默认规则');
    return getDefaultRules();
  }
  
  // 其他环境：如果文件不存在，创建默认规则
  if (!fs.existsSync(rulesPath)) {
    const defaultRules = getDefaultRules();
    saveRules(defaultRules);  // 自动创建
    return defaultRules;
  }
  
  return JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
}
```

---

## 📝 审计与日志

### 1. 规则变更审计日志

```javascript
// lib/html-extraction/rules-audit.js

const AUDIT_LOG_PATH = path.join(projectRoot, 'logs/rules-audit.log');

function auditRuleChange(action, details) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    environment: RULES_CONFIG.environment,
    action,  // 'create', 'update', 'delete', 'rollback'
    details,
    user: process.env.USER || 'system',
    hostname: require('os').hostname(),
  };
  
  // 写入日志文件
  fs.appendFileSync(
    AUDIT_LOG_PATH,
    JSON.stringify(logEntry) + '\n',
    'utf-8'
  );
  
  // 生产环境：同时写入数据库（如果可用）
  if (RULES_CONFIG.environment === 'production') {
    saveAuditToDB(logEntry).catch(err => {
      console.error('[审计] 写入数据库失败:', err);
    });
  }
}
```

### 2. 规则验证日志

```javascript
async function updateRulesIfNeeded(html, extractionResult) {
  if (!shouldTriggerRuleUpdate(extractionResult, 50)) return;
  
  console.log('[规则更新] 检测到提取成功率低，触发 LLM 学习...');
  
  const newRules = await generateRulesFromHTML(html);
  const validationResult = validateRules(html, newRules, extractionResult, 50);
  
  // 记录验证结果
  auditRuleChange('validate', {
    success: validationResult.ok,
    metrics: validationResult.metrics,
    ruleVersion: newRules.version,
  });
  
  if (!validationResult.ok) {
    console.warn('[规则更新] 新规则验证失败，保持使用当前规则');
    return;
  }
  
  // 保存规则（会触发权限检查）
  try {
    saveRules(newRules);
    auditRuleChange('update', {
      ruleVersion: newRules.version,
      metrics: validationResult.metrics,
    });
  } catch (e) {
    auditRuleChange('update_failed', {
      error: e.message,
      ruleVersion: newRules.version,
    });
    throw e;
  }
}
```

---

## 🔄 回滚机制

### 1. 版本化规则存储

```javascript
function saveRules(rules) {
  checkWritePermission();  // 权限检查
  
  const rulesPath = getRulesPath();
  const version = rules.version || generateVersion();
  
  // 1. 保存版本化文件
  const versionedPath = rulesPath.replace('current.json', `v${version}.json`);
  fs.writeFileSync(versionedPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 2. 更新 current.json（符号链接或直接复制）
  if (RULES_CONFIG.environment === 'production') {
    // 生产环境：创建备份后再更新
    const backupPath = `${rulesPath}.backup.${Date.now()}`;
    if (fs.existsSync(rulesPath)) {
      fs.copyFileSync(rulesPath, backupPath);
    }
  }
  
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
  
  // 3. 记录变更
  auditRuleChange('update', { version });
}

function rollbackRules(targetVersion) {
  checkWritePermission();
  
  const rulesPath = getRulesPath();
  const versionedPath = rulesPath.replace('current.json', `v${targetVersion}.json`);
  
  if (!fs.existsSync(versionedPath)) {
    throw new Error(`版本 ${targetVersion} 不存在`);
  }
  
  const rules = JSON.parse(fs.readFileSync(versionedPath, 'utf-8'));
  saveRules(rules);
  
  auditRuleChange('rollback', { targetVersion });
}
```

### 2. 自动回滚机制

```javascript
async function updateRulesWithAutoRollback(html, extractionResult) {
  const currentRules = loadRules();
  const currentVersion = currentRules.version;
  
  try {
    await updateRulesIfNeeded(html, extractionResult);
    
    // 验证新规则（运行一次完整提取）
    const testResult = extractWithRules(html, loadRules());
    if (!validateRules(html, loadRules(), testResult, 50).ok) {
      throw new Error('新规则验证失败');
    }
  } catch (e) {
    console.error('[规则更新] 自动回滚到版本:', currentVersion);
    
    // 回滚到之前的版本
    rollbackRules(currentVersion);
    
    auditRuleChange('auto_rollback', {
      error: e.message,
      rolledBackTo: currentVersion,
    });
    
    throw e;
  }
}
```

---

## 🛡️ 安全验证

### 1. 规则内容安全验证

```javascript
function validateRuleSecurity(rules) {
  const issues = [];
  
  // 1. 检查 JSON 结构合法性
  if (!rules.video || !rules.user) {
    issues.push('规则结构不完整');
  }
  
  // 2. 检查正则表达式安全性（防止 ReDoS）
  function checkRegexSafety(pattern) {
    // 简单检查：避免嵌套量词
    if (/(\*|\+|\?|\{.*,.*\}).*\1/.test(pattern)) {
      issues.push(`潜在 ReDoS 风险的正则: ${pattern}`);
    }
  }
  
  // 3. 检查路径遍历攻击
  function checkPathTraversal(value) {
    if (typeof value === 'string' && value.includes('../')) {
      issues.push(`潜在路径遍历攻击: ${value}`);
    }
  }
  
  // 递归检查所有字符串值
  function traverse(obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        checkPathTraversal(value);
        if (key === 'pattern' || key.includes('regex')) {
          checkRegexSafety(value);
        }
      } else if (typeof value === 'object' && value !== null) {
        traverse(value);
      }
    }
  }
  
  traverse(rules);
  
  if (issues.length > 0) {
    throw new Error(`规则安全验证失败:\n${issues.join('\n')}`);
  }
  
  return true;
}
```

### 2. LLM 输出内容验证

```javascript
async function generateRulesFromHTML(html) {
  const response = await callDeepSeekLLM([...], systemPrompt);
  
  // 1. 提取 JSON（移除 markdown 代码块）
  let jsonStr = extractJSON(response);
  
  // 2. 解析 JSON
  let rules;
  try {
    rules = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`LLM 返回的不是有效 JSON: ${e.message}`);
  }
  
  // 3. 安全验证
  validateRuleSecurity(rules);
  
  // 4. 结构验证
  if (!rules.video || !rules.user) {
    throw new Error('规则缺少必要字段');
  }
  
  // 5. 添加元数据
  rules.version = generateVersion();
  rules.generatedAt = new Date().toISOString();
  rules.environment = RULES_CONFIG.environment;
  
  return rules;
}
```

---

## ✅ 实施建议

### 环境自动更新策略对比

| 环境 | 自动更新 | 验证要求 | 回滚机制 | 推荐场景 |
|------|---------|---------|---------|---------|
| **开发环境** | ✅ **强烈推荐** | 基础验证 | 自动回滚 | 快速迭代，频繁测试 |
| **测试环境** | ⚠️ **条件推荐** | 严格验证 + 人工确认 | 自动回滚 + 告警 | 验证新规则稳定性 |
| **生产环境** | ❌ **不推荐** | 人工审核 + 灰度发布 | 快速回滚 + 监控 | 稳定性优先 |

---

### 阶段 1：开发环境（立即实施）

**策略：完全自动更新**

1. ✅ 实现文件系统规则存储
2. ✅ 添加权限检查（基于环境变量）
3. ✅ 实现审计日志
4. ✅ 实现版本化存储

**配置：**
```bash
NODE_ENV=development
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发更新
```

**优点：**
- 快速适应 TikTok 改版
- 减少人工维护成本
- 适合频繁测试

---

### 阶段 2：测试环境（1-2周后）

**策略：条件自动更新（推荐）**

**方案 A：保守策略（推荐用于关键业务）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.3  # 成功率 < 30% 才触发
RULES_REQUIRE_MANUAL_CONFIRM=true  # 需要人工确认
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**方案 B：积极策略（推荐用于快速迭代）**
```bash
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
ALLOW_RULES_WRITE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5  # 成功率 < 50% 触发
RULES_REQUIRE_MANUAL_CONFIRM=false  # 自动应用
RULES_NOTIFICATION_ENABLED=true     # 发送通知
```

**实现要点：**
1. ✅ 更严格的验证（成功率 > 80% 才应用）
2. ✅ 自动回滚（验证失败立即回滚）
3. ✅ 通知机制（Slack/邮件通知规则变更）
4. ✅ 可选人工确认（关键业务建议开启）

**建议：**
- **如果你的测试环境用于验证生产前准备**：使用方案 A（保守）
- **如果你的测试环境用于快速迭代**：使用方案 B（积极）

---

### 阶段 3：生产环境（1个月后）

**策略：禁止自动更新（强烈推荐）**

**配置：**
```bash
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false  # 🔒 禁止自动更新
ALLOW_RULES_WRITE=false        # 🔒 禁止写入
RULES_REQUIRE_MANUAL_DEPLOY=true  # 必须手动部署
```

**更新流程（所有环境统一）：**
```
1. 检测到去重后的用户名数量 < 10 → 触发规则更新
2. 第 1 次尝试：LLM 生成规则 → 验证（至少 10 个红人用户名）
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 2 秒后重试
3. 第 2 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 等待 4 秒后重试
4. 第 3 次尝试：LLM 生成规则 → 验证
   ├─ 成功 → 应用新规则 ✅
   └─ 失败 → 继续使用旧规则 ⚠️（记录日志，发送告警）
```

**关键点：**
- ✅ **触发条件**：去重后的用户名数量 < 10
- ✅ 所有环境都允许自动更新
- ✅ 必须达到验证阈值（至少 10 个红人用户名）才应用
- ✅ 未达到阈值时重试最多 3 次
- ✅ 3 次都失败则继续使用旧规则，不中断任务

**例外情况：紧急自动更新（不推荐，但可配置）**

如果 TikTok 突然大规模改版，导致提取完全失败，可以配置紧急模式：

```bash
# 紧急模式（仅在极端情况下启用）
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_EMERGENCY_UPDATE=true  # 紧急更新开关
RULES_EMERGENCY_THRESHOLD=0.1      # 成功率 < 10% 才触发
RULES_EMERGENCY_REQUIRE_ADMIN=true # 需要管理员确认
```

**紧急更新流程：**
```
1. 检测到成功率 < 10%（严重失败）
2. 发送紧急告警（电话/短信）
3. 等待管理员确认（5分钟内）
4. 如果确认 → LLM 生成新规则 → 严格验证 → 应用
5. 如果未确认 → 保持旧规则，继续告警
```

---

## 🤔 是否建议测试和生产环境自动更新？

### 测试环境：条件推荐 ✅

**推荐自动更新的理由：**
1. ✅ **快速验证**：TikTok 改版后，测试环境可以快速适应
2. ✅ **降低维护成本**：减少人工干预
3. ✅ **风险可控**：测试环境失败不影响生产

**但需要：**
- ⚠️ **严格验证**：成功率必须 > 80% 才应用
- ⚠️ **自动回滚**：验证失败立即回滚
- ⚠️ **通知机制**：规则变更必须通知团队
- ⚠️ **可选人工确认**：关键业务建议开启

**建议配置：**
```bash
# 测试环境：积极策略
NODE_ENV=staging
ALLOW_RULES_AUTO_UPDATE=true
RULES_AUTO_UPDATE_THRESHOLD=0.5
RULES_MIN_SUCCESS_RATE=0.8  # 新规则成功率必须 > 80%
RULES_AUTO_ROLLBACK=true     # 自动回滚
RULES_NOTIFICATION_ENABLED=true
```

---

### 生产环境：不推荐自动更新 ❌

**不推荐的理由：**
1. ❌ **稳定性优先**：生产环境失败直接影响业务
2. ❌ **数据质量风险**：错误的规则可能导致数据错误
3. ❌ **难以追溯**：自动更新难以追溯问题原因
4. ❌ **合规风险**：某些行业需要人工审核

**但可以配置紧急模式：**
- 仅在极端情况下（成功率 < 10%）启用
- 需要管理员确认
- 严格验证和监控

**建议配置：**
```bash
# 生产环境：禁止自动更新
NODE_ENV=production
ALLOW_RULES_AUTO_UPDATE=false
ALLOW_RULES_WRITE=false
RULES_REQUIRE_MANUAL_DEPLOY=true

# 可选：紧急模式（仅在极端情况下启用）
ALLOW_RULES_EMERGENCY_UPDATE=false  # 默认关闭
RULES_EMERGENCY_THRESHOLD=0.1
RULES_EMERGENCY_REQUIRE_ADMIN=true
```

---

## 📊 最终建议

### 推荐配置

**开发环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 完全自动
```

**测试环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=true  # ✅ 条件自动（成功率 < 50% 触发）
RULES_MIN_SUCCESS_RATE=0.8    # ⚠️ 新规则必须 > 80% 成功率
RULES_AUTO_ROLLBACK=true      # ✅ 自动回滚
RULES_NOTIFICATION_ENABLED=true  # ✅ 通知团队
```

**生产环境：**
```bash
ALLOW_RULES_AUTO_UPDATE=false  # ❌ 禁止自动更新
ALLOW_RULES_EMERGENCY_UPDATE=false  # ❌ 紧急模式默认关闭
RULES_REQUIRE_MANUAL_DEPLOY=true   # ✅ 必须手动部署
```

### 总结

| 环境 | 自动更新 | 原因 |
|------|---------|------|
| **开发** | ✅ **强烈推荐** | 快速迭代，风险低 |
| **测试** | ✅ **条件推荐** | 快速验证，风险可控 |
| **生产** | ❌ **不推荐** | 稳定性优先，风险高 |

**测试环境可以自动更新，但需要：**
- 严格验证（成功率 > 80%）
- 自动回滚机制
- 通知机制
- 可选人工确认

**生产环境不建议自动更新，但可以配置紧急模式作为最后手段。**

---

## 📊 总结

### 安全等级对比

| 方案 | 文件权限 | 自动更新 | 审计日志 | 回滚 | 推荐场景 |
|------|---------|---------|---------|------|---------|
| **方案A：文件系统+权限控制** | ✅ | ✅/❌ | ✅ | ✅ | 中小型项目 |
| **方案B：数据库存储** | ✅ | ✅/❌ | ✅ | ✅ | 大型项目，多环境 |

### 关键安全措施

1. ✅ **环境隔离**：测试和生产规则完全分离
2. ✅ **权限控制**：生产环境禁止自动更新
3. ✅ **审计日志**：所有规则变更可追溯
4. ✅ **安全验证**：防止注入攻击和 ReDoS
5. ✅ **回滚机制**：快速恢复错误规则

### 推荐配置

**开发/测试环境：**
- 允许自动更新
- 文件系统存储
- 完整审计日志

**生产环境：**
- **禁止自动更新**（必须人工审核）
- 数据库存储（可选，更安全）
- 规则变更需通过 CI/CD 流程