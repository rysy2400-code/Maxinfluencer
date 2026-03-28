# 测试指南：浏览器操作步骤和截图显示

## 测试方式

### 方式1：前端界面测试（推荐用于调试）

1. **启动 Chrome 浏览器（搜索功能）**
   ```bash
   # 终端1：启动搜索用的 Chrome（需要登录 TikTok）
   bash scripts/launch-chrome-remote-debug.sh
   # 或指定端口
   bash scripts/launch-chrome-remote-debug.sh --port 9222
   ```

2. **启动 Chrome 浏览器（主页提取功能）**
   ```bash
   # 终端2：启动主页提取用的 Chrome（不需要登录）
   bash scripts/launch-chrome-remote-debug-enrich.sh
   ```

3. **启动 Next.js 开发服务器**
   ```bash
   # 终端3：启动前端
   npm run dev
   ```

4. **在前端界面测试**
   - 打开浏览器访问 `http://localhost:3000`
   - 输入消息："帮我推荐白人健身年轻女孩"
   - 观察前端界面是否显示：
     - ✅ 浏览器操作步骤时间线（左侧）
     - ✅ 浏览器截图（右侧）
     - ✅ 实时更新

5. **查看控制台日志**
   - 打开浏览器开发者工具（F12）
   - 查看 Console 标签页，应该看到：
     - `[AgentRouter] 发送浏览器步骤/截图更新:`
     - `[前端] 收到浏览器步骤/截图更新:`

### 方式2：Headless 模式（推荐用于生产环境）

Headless 模式的优点：
- ✅ 不需要手动启动 Chrome
- ✅ 适合服务器环境（无 GUI）
- ✅ 资源占用更少
- ✅ 可以自动化运行

Headless 模式的缺点：
- ❌ 无法看到浏览器实际行为（调试困难）
- ❌ 截图仍然可以工作，但看不到实时画面

**启用 Headless 模式：**

1. 在 `.env.local` 文件中设置：
   ```bash
   # 启用 headless 模式
   PLAYWRIGHT_HEADLESS=true
   ```

2. 代码会自动检测环境变量，如果设置为 `true`，会使用 Playwright 自动启动 headless Chrome，而不是连接手动启动的 Chrome。

3. 如果设置为 `false` 或不设置，则使用非 headless 模式（需要手动启动 Chrome）。

## 调试步骤

### 1. 检查后端日志

在运行测试时，查看终端输出，应该看到：

```
[extractSearchResultsFromPageCDP] 🔍 开始提取，onStepUpdate=true
[extractSearchResultsFromPageCDP] 📝 报告步骤: search_videos - running - 正在搜索: xxx
[extractSearchResultsFromPageCDP] 📸 开始截图: 搜索页面加载完成
[extractSearchResultsFromPageCDP] ✅ 截图完成，发送更新: 搜索页面加载完成
[AgentRouter] 发送浏览器步骤/截图更新: { browserSteps: 1, screenshots: 1 }
```

### 2. 检查前端日志

在浏览器控制台（F12），应该看到：

```
[前端] 收到浏览器步骤/截图更新: { browserSteps: 1, screenshots: 1 }
```

### 3. 检查前端显示

前端界面应该显示：
- **浏览器操作步骤**面板（左侧）：
  - 🔍 生成搜索关键词
  - 🌐 连接 Chrome
  - 📹 搜索视频
  - 👤 提取红人主页
  - 💾 保存到数据库

- **浏览器截图**面板（右侧）：
  - 显示当前步骤的截图
  - 截图会随着步骤更新而更新

## 常见问题

### Q1: 前端没有显示步骤和截图

**检查清单：**
1. ✅ 确认 Chrome 已启动（检查终端是否有连接成功日志）
2. ✅ 确认 `onStepUpdate` 被传递（查看后端日志）
3. ✅ 确认前端控制台没有错误
4. ✅ 确认 SSE 连接正常（Network 标签页查看 `/api/chat` 请求）

### Q2: 截图显示为空白或加载失败

**可能原因：**
- 浏览器窗口被最小化
- 页面加载时间过长
- 网络问题导致截图数据未传输

**解决方案：**
- 确保 Chrome 窗口可见（非 headless 模式）
- 检查网络连接
- 查看后端日志确认截图是否成功生成

### Q3: 步骤状态不更新

**可能原因：**
- `onStepUpdate` 回调未正确传递
- 步骤 ID 不匹配

**解决方案：**
- 查看后端日志确认 `reportStep` 是否被调用
- 检查 `browser-steps.js` 中的步骤 ID 定义

## 性能优化建议

1. **截图数量限制**：每个步骤最多保留 2 张截图，避免内存过大
2. **截图质量**：使用 JPEG 格式，质量 75%，只截取可视区域
3. **Headless 模式**：生产环境建议使用 headless 模式，减少资源占用

## 下一步

如果测试成功，可以考虑：
1. ✅ 添加更多步骤的截图（如滚动过程）
2. ✅ 优化截图显示（如缩略图、全屏查看）
3. ✅ 添加步骤进度条
4. ✅ 添加错误状态显示


## 测试方式

### 方式1：前端界面测试（推荐用于调试）

1. **启动 Chrome 浏览器（搜索功能）**
   ```bash
   # 终端1：启动搜索用的 Chrome（需要登录 TikTok）
   bash scripts/launch-chrome-remote-debug.sh
   # 或指定端口
   bash scripts/launch-chrome-remote-debug.sh --port 9222
   ```

2. **启动 Chrome 浏览器（主页提取功能）**
   ```bash
   # 终端2：启动主页提取用的 Chrome（不需要登录）
   bash scripts/launch-chrome-remote-debug-enrich.sh
   ```

3. **启动 Next.js 开发服务器**
   ```bash
   # 终端3：启动前端
   npm run dev
   ```

4. **在前端界面测试**
   - 打开浏览器访问 `http://localhost:3000`
   - 输入消息："帮我推荐白人健身年轻女孩"
   - 观察前端界面是否显示：
     - ✅ 浏览器操作步骤时间线（左侧）
     - ✅ 浏览器截图（右侧）
     - ✅ 实时更新

5. **查看控制台日志**
   - 打开浏览器开发者工具（F12）
   - 查看 Console 标签页，应该看到：
     - `[AgentRouter] 发送浏览器步骤/截图更新:`
     - `[前端] 收到浏览器步骤/截图更新:`

### 方式2：Headless 模式（推荐用于生产环境）

Headless 模式的优点：
- ✅ 不需要手动启动 Chrome
- ✅ 适合服务器环境（无 GUI）
- ✅ 资源占用更少
- ✅ 可以自动化运行

Headless 模式的缺点：
- ❌ 无法看到浏览器实际行为（调试困难）
- ❌ 截图仍然可以工作，但看不到实时画面

**启用 Headless 模式：**

1. 在 `.env.local` 文件中设置：
   ```bash
   # 启用 headless 模式
   PLAYWRIGHT_HEADLESS=true
   ```

2. 代码会自动检测环境变量，如果设置为 `true`，会使用 Playwright 自动启动 headless Chrome，而不是连接手动启动的 Chrome。

3. 如果设置为 `false` 或不设置，则使用非 headless 模式（需要手动启动 Chrome）。

## 调试步骤

### 1. 检查后端日志

在运行测试时，查看终端输出，应该看到：

```
[extractSearchResultsFromPageCDP] 🔍 开始提取，onStepUpdate=true
[extractSearchResultsFromPageCDP] 📝 报告步骤: search_videos - running - 正在搜索: xxx
[extractSearchResultsFromPageCDP] 📸 开始截图: 搜索页面加载完成
[extractSearchResultsFromPageCDP] ✅ 截图完成，发送更新: 搜索页面加载完成
[AgentRouter] 发送浏览器步骤/截图更新: { browserSteps: 1, screenshots: 1 }
```

### 2. 检查前端日志

在浏览器控制台（F12），应该看到：

```
[前端] 收到浏览器步骤/截图更新: { browserSteps: 1, screenshots: 1 }
```

### 3. 检查前端显示

前端界面应该显示：
- **浏览器操作步骤**面板（左侧）：
  - 🔍 生成搜索关键词
  - 🌐 连接 Chrome
  - 📹 搜索视频
  - 👤 提取红人主页
  - 💾 保存到数据库

- **浏览器截图**面板（右侧）：
  - 显示当前步骤的截图
  - 截图会随着步骤更新而更新

## 常见问题

### Q1: 前端没有显示步骤和截图

**检查清单：**
1. ✅ 确认 Chrome 已启动（检查终端是否有连接成功日志）
2. ✅ 确认 `onStepUpdate` 被传递（查看后端日志）
3. ✅ 确认前端控制台没有错误
4. ✅ 确认 SSE 连接正常（Network 标签页查看 `/api/chat` 请求）

### Q2: 截图显示为空白或加载失败

**可能原因：**
- 浏览器窗口被最小化
- 页面加载时间过长
- 网络问题导致截图数据未传输

**解决方案：**
- 确保 Chrome 窗口可见（非 headless 模式）
- 检查网络连接
- 查看后端日志确认截图是否成功生成

### Q3: 步骤状态不更新

**可能原因：**
- `onStepUpdate` 回调未正确传递
- 步骤 ID 不匹配

**解决方案：**
- 查看后端日志确认 `reportStep` 是否被调用
- 检查 `browser-steps.js` 中的步骤 ID 定义

## 性能优化建议

1. **截图数量限制**：每个步骤最多保留 2 张截图，避免内存过大
2. **截图质量**：使用 JPEG 格式，质量 75%，只截取可视区域
3. **Headless 模式**：生产环境建议使用 headless 模式，减少资源占用

## 下一步

如果测试成功，可以考虑：
1. ✅ 添加更多步骤的截图（如滚动过程）
2. ✅ 优化截图显示（如缩略图、全屏查看）
3. ✅ 添加步骤进度条
4. ✅ 添加错误状态显示


## 测试方式

### 方式1：前端界面测试（推荐用于调试）

1. **启动 Chrome 浏览器（搜索功能）**
   ```bash
   # 终端1：启动搜索用的 Chrome（需要登录 TikTok）
   bash scripts/launch-chrome-remote-debug.sh
   # 或指定端口
   bash scripts/launch-chrome-remote-debug.sh --port 9222
   ```

2. **启动 Chrome 浏览器（主页提取功能）**
   ```bash
   # 终端2：启动主页提取用的 Chrome（不需要登录）
   bash scripts/launch-chrome-remote-debug-enrich.sh
   ```

3. **启动 Next.js 开发服务器**
   ```bash
   # 终端3：启动前端
   npm run dev
   ```

4. **在前端界面测试**
   - 打开浏览器访问 `http://localhost:3000`
   - 输入消息："帮我推荐白人健身年轻女孩"
   - 观察前端界面是否显示：
     - ✅ 浏览器操作步骤时间线（左侧）
     - ✅ 浏览器截图（右侧）
     - ✅ 实时更新

5. **查看控制台日志**
   - 打开浏览器开发者工具（F12）
   - 查看 Console 标签页，应该看到：
     - `[AgentRouter] 发送浏览器步骤/截图更新:`
     - `[前端] 收到浏览器步骤/截图更新:`

### 方式2：Headless 模式（推荐用于生产环境）

Headless 模式的优点：
- ✅ 不需要手动启动 Chrome
- ✅ 适合服务器环境（无 GUI）
- ✅ 资源占用更少
- ✅ 可以自动化运行

Headless 模式的缺点：
- ❌ 无法看到浏览器实际行为（调试困难）
- ❌ 截图仍然可以工作，但看不到实时画面

**启用 Headless 模式：**

1. 在 `.env.local` 文件中设置：
   ```bash
   # 启用 headless 模式
   PLAYWRIGHT_HEADLESS=true
   ```

2. 代码会自动检测环境变量，如果设置为 `true`，会使用 Playwright 自动启动 headless Chrome，而不是连接手动启动的 Chrome。

3. 如果设置为 `false` 或不设置，则使用非 headless 模式（需要手动启动 Chrome）。

## 调试步骤

### 1. 检查后端日志

在运行测试时，查看终端输出，应该看到：

```
[extractSearchResultsFromPageCDP] 🔍 开始提取，onStepUpdate=true
[extractSearchResultsFromPageCDP] 📝 报告步骤: search_videos - running - 正在搜索: xxx
[extractSearchResultsFromPageCDP] 📸 开始截图: 搜索页面加载完成
[extractSearchResultsFromPageCDP] ✅ 截图完成，发送更新: 搜索页面加载完成
[AgentRouter] 发送浏览器步骤/截图更新: { browserSteps: 1, screenshots: 1 }
```

### 2. 检查前端日志

在浏览器控制台（F12），应该看到：

```
[前端] 收到浏览器步骤/截图更新: { browserSteps: 1, screenshots: 1 }
```

### 3. 检查前端显示

前端界面应该显示：
- **浏览器操作步骤**面板（左侧）：
  - 🔍 生成搜索关键词
  - 🌐 连接 Chrome
  - 📹 搜索视频
  - 👤 提取红人主页
  - 💾 保存到数据库

- **浏览器截图**面板（右侧）：
  - 显示当前步骤的截图
  - 截图会随着步骤更新而更新

## 常见问题

### Q1: 前端没有显示步骤和截图

**检查清单：**
1. ✅ 确认 Chrome 已启动（检查终端是否有连接成功日志）
2. ✅ 确认 `onStepUpdate` 被传递（查看后端日志）
3. ✅ 确认前端控制台没有错误
4. ✅ 确认 SSE 连接正常（Network 标签页查看 `/api/chat` 请求）

### Q2: 截图显示为空白或加载失败

**可能原因：**
- 浏览器窗口被最小化
- 页面加载时间过长
- 网络问题导致截图数据未传输

**解决方案：**
- 确保 Chrome 窗口可见（非 headless 模式）
- 检查网络连接
- 查看后端日志确认截图是否成功生成

### Q3: 步骤状态不更新

**可能原因：**
- `onStepUpdate` 回调未正确传递
- 步骤 ID 不匹配

**解决方案：**
- 查看后端日志确认 `reportStep` 是否被调用
- 检查 `browser-steps.js` 中的步骤 ID 定义

## 性能优化建议

1. **截图数量限制**：每个步骤最多保留 2 张截图，避免内存过大
2. **截图质量**：使用 JPEG 格式，质量 75%，只截取可视区域
3. **Headless 模式**：生产环境建议使用 headless 模式，减少资源占用

## 下一步

如果测试成功，可以考虑：
1. ✅ 添加更多步骤的截图（如滚动过程）
2. ✅ 优化截图显示（如缩略图、全屏查看）
3. ✅ 添加步骤进度条
4. ✅ 添加错误状态显示

