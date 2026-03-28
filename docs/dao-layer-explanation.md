# DAO 层的作用和原理

## 什么是 DAO？

**DAO（Data Access Object，数据访问对象）** 是一种设计模式，用于封装对数据库的访问操作。它提供了一个抽象层，将业务逻辑与数据库操作分离。

## DAO 层的核心作用

### 1. **数据访问抽象**
DAO 层将数据库操作（SQL 查询、插入、更新、删除）封装成简单的函数调用，业务代码不需要直接写 SQL。

**示例：**
```javascript
// ❌ 没有 DAO 层：业务代码直接写 SQL
const sql = `INSERT INTO campaign_sessions (id, title, messages, context) VALUES (?, ?, ?, ?)`;
await queryTikTok(sql, [id, title, messagesJson, contextJson]);

// ✅ 有 DAO 层：业务代码调用函数
await createCampaignSession({ title, messages, context });
```

### 2. **统一错误处理**
所有数据库操作都经过 DAO 层，可以统一处理错误、日志记录、事务管理等。

**示例：**
```javascript
// lib/db/campaign-session-dao.js
export async function createCampaignSession(sessionData) {
  try {
    // ... 数据库操作
    return { success: true, session, message: '会话创建成功' };
  } catch (error) {
    console.error('[CampaignSessionDAO] 创建会话失败:', error);
    return { success: false, session: null, message: error.message };
  }
}
```

### 3. **数据转换和验证**
DAO 层负责将 JavaScript 对象转换为数据库格式（如 JSON 序列化），以及将数据库结果转换回业务对象。

**示例：**
```javascript
// 写入时：将对象转为 JSON 字符串
const messagesJson = JSON.stringify(messages);
const contextJson = JSON.stringify(context);

// 读取时：将 JSON 字符串解析为对象
messages: typeof row.messages === 'string' 
  ? JSON.parse(row.messages) 
  : row.messages
```

### 4. **代码复用和维护性**
多个地方需要访问同一张表时，只需调用同一个 DAO 函数，避免重复代码。

## 本项目中的 DAO 层结构

### 文件组织
```
lib/db/
├── mysql-tiktok.js          # 数据库连接池和基础查询函数
├── campaign-session-dao.js  # Campaign Session 的 DAO
└── tiktok-influencer-dao.js # TikTok 红人的 DAO
```

### 层次关系

```
┌─────────────────┐
│   API Routes    │  ← 处理 HTTP 请求
│  (app/api/...)  │
└────────┬────────┘
         │ 调用
         ▼
┌─────────────────┐
│   DAO Layer     │  ← 封装数据库操作
│  (lib/db/...-dao.js) │
└────────┬────────┘
         │ 使用
         ▼
┌─────────────────┐
│  Database Pool  │  ← 数据库连接
│ (mysql-tiktok.js)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   MySQL (tiktok)│  ← 实际数据库
└─────────────────┘
```

## Campaign Session DAO 详解

### 核心函数

#### 1. `createCampaignSession(sessionData)`
**作用：** 创建新的 Campaign Session

**流程：**
1. 生成 UUID 作为会话 ID
2. 验证必填字段（messages 必须是数组）
3. 将 messages 和 context 序列化为 JSON
4. 执行 INSERT SQL
5. 返回创建结果

**代码示例：**
```javascript
const result = await createCampaignSession({
  title: '新 Campaign',
  messages: [...],
  context: {...},
  status: 'draft'
});
// result: { success: true, session: {...}, message: '会话创建成功' }
```

#### 2. `getAllCampaignSessions(options)`
**作用：** 获取所有会话列表（支持筛选和分页）

**参数：**
- `options.status`: 筛选状态（'draft' | 'published' | null）
- `options.limit`: 限制返回数量

**流程：**
1. 构建动态 SQL（根据 status 添加 WHERE 条件）
2. 按 `updated_at DESC` 排序（最新的在前）
3. 限制返回数量
4. 解析 JSON 字段
5. 返回会话数组

#### 3. `getCampaignSessionById(sessionId)`
**作用：** 根据 ID 获取单个会话

**流程：**
1. 验证 sessionId 是否存在
2. 执行 SELECT 查询
3. 解析 JSON 字段
4. 返回会话对象或 null

#### 4. `updateCampaignSession(sessionId, updates)`
**作用：** 更新会话（支持部分更新）

**特点：**
- 只更新提供的字段（title、status、messages、context）
- 自动更新 `updated_at` 时间戳
- 返回更新后的完整会话对象

**代码示例：**
```javascript
// 只更新标题
await updateCampaignSession(sessionId, { title: '新标题' });

// 更新消息和上下文
await updateCampaignSession(sessionId, {
  messages: [...],
  context: {...}
});
```

#### 5. `deleteCampaignSession(sessionId)`
**作用：** 删除会话

**流程：**
1. 验证 sessionId
2. 执行 DELETE SQL
3. 返回删除结果

## DAO 层的优势

### 1. **业务代码更简洁**
```javascript
// API Route 中只需要调用 DAO 函数
export async function POST(req) {
  const body = await req.json();
  const result = await createCampaignSession(body);
  return NextResponse.json(result);
}
```

### 2. **易于测试**
可以单独测试 DAO 函数，不需要启动整个应用。

### 3. **易于维护**
如果数据库表结构变化，只需修改 DAO 层，业务代码不受影响。

### 4. **类型安全（如果使用 TypeScript）**
可以为 DAO 函数定义明确的输入输出类型。

## 最佳实践

1. **一个表对应一个 DAO 文件**
   - `campaign-session-dao.js` → `campaign_sessions` 表
   - `tiktok-influencer-dao.js` → `TikTok_influencer` 表

2. **统一的返回格式**
   ```javascript
   // 成功
   { success: true, session: {...}, message: '...' }
   
   // 失败
   { success: false, session: null, message: '错误信息' }
   ```

3. **统一的错误处理**
   - 所有 DAO 函数都使用 try-catch
   - 记录错误日志
   - 返回友好的错误信息

4. **数据验证**
   - 在 DAO 层验证必填字段
   - 验证数据类型（如 messages 必须是数组）

5. **JSON 字段处理**
   - 写入时：`JSON.stringify()`
   - 读取时：检查类型并解析（MySQL 可能返回字符串或对象）

## 总结

DAO 层是连接业务逻辑和数据库的桥梁，它：
- **简化**了业务代码（不需要写 SQL）
- **统一**了数据访问方式
- **提高**了代码的可维护性和可测试性
- **封装**了数据库细节，使业务代码更专注于业务逻辑

在我们的项目中，DAO 层让 API Routes 可以专注于处理 HTTP 请求，而将复杂的数据库操作交给专门的 DAO 函数处理。

