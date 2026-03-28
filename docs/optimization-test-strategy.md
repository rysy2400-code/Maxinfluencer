# Chrome 自动化检测优化测试策略

## 黑屏问题排查（已修复）

### 原因
之前添加的激进启动参数导致黑屏：
- **`--disable-features=BlinkGenPropertyTrees`**：Blink 渲染核心，禁用会导致页面无法渲染（黑屏）
- **`--disable-renderer-backgrounding`**：影响渲染器行为
- **`--metrics-recording-only`**：使 Chrome 进入特殊模式
- **覆盖 `window.navigator`**：反检测脚本中覆盖整个 navigator 对象会导致页面功能异常

### 解决方案（已实施）
- 移除所有可能影响渲染的启动参数
- 仅保留安全的反检测参数
- 移除 `window.navigator` 覆盖，只隐藏 `webdriver` 属性
- 将 `waitUntil` 从 `domcontentloaded` 改为 `load`，确保页面完全渲染

---

## 问题现状

1. **Chrome 界面仍显示"正在受到自动测试软件控制"**
2. **TikTok 红人视频无法加载**

## 根本原因分析

### 1. Chrome 自动化提示无法完全消除的原因

即使添加了 `--disable-infobars` 和 `--exclude-switches=enable-automation`，Chrome 仍可能显示自动化提示，因为：

- **Playwright 的 CDP (Chrome DevTools Protocol) 连接**：Playwright 通过 CDP 控制浏览器，Chrome 可以检测到这个连接
- **进程检测**：Chrome 可以检测到进程是由自动化工具启动的
- **用户数据目录状态**：Chrome 可能在用户数据目录中记录了自动化访问痕迹

### 2. TikTok 视频无法加载的原因

这是**结果而非原因**：
- TikTok 检测到自动化操作
- TikTok 的反爬系统主动拒绝加载视频内容
- 这是 TikTok 的防御措施

---

## 优化测试策略（按优先级排序）

### 🔴 策略 1：使用更激进的启动参数（已实施）

**已添加的参数**：
```javascript
args: [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--disable-infobars',
  '--disable-sync', // ✅ 新增：禁用同步，避免 Google 账户检测
  '--disable-extensions', // ✅ 新增：禁用扩展
  '--disable-background-networking', // ✅ 新增：禁用后台网络
  // ... 更多参数
]
```

**测试方法**：
```bash
node scripts/test-tiktok-video-fingerprint.js --chrome
```

**预期效果**：
- 减少自动化提示出现的概率
- 降低被 TikTok 检测的风险

---

### 🟡 策略 2：验证反检测脚本是否生效

**在浏览器控制台检查**：

```javascript
// 1. 检查 webdriver 是否被隐藏
console.log(navigator.webdriver); // 应该返回 undefined 或 false

// 2. 检查 chrome 对象是否存在
console.log(window.chrome); // 应该返回对象（不是 undefined）

// 3. 检查 plugins 是否被伪装
console.log(navigator.plugins.length); // 应该返回 > 0

// 4. 检查是否有 Playwright 全局变量
console.log(window.__playwright); // 应该返回 undefined
```

**如果检查失败**：
- 说明反检测脚本没有正确注入
- 需要检查 `addInitScript` 是否正常工作

---

### 🟢 策略 3：使用 playwright-stealth 插件（推荐）

**安装**：
```bash
npm install playwright-extra playwright-extra-plugin-stealth
```

**使用**：
```javascript
import { chromium } from 'playwright-extra';
import StealthPlugin from 'playwright-extra-plugin-stealth';

chromium.use(StealthPlugin());

// 然后正常使用
const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
```

**优势**：
- 自动处理所有常见的自动化指纹
- 更彻底地隐藏 `navigator.webdriver`
- 伪装更多自动化特征

**测试方法**：
1. 安装插件
2. 修改脚本使用 `playwright-extra`
3. 重新测试

---

### 🔵 策略 4：使用代理 + IP 轮换

**问题**：
- 如果所有请求来自同一 IP，TikTok 可能标记为机器人行为
- 需要模拟不同地理位置的用户

**解决方案**：
```javascript
const launchOptions = {
  // ... 其他配置
  proxy: {
    server: 'http://proxy-ip:port',
    username: 'user',
    password: 'pass'
  }
};
```

**建议**：
- 使用**住宅代理**而非数据中心代理
- 轮换不同的 IP 地址
- 确保 IP 地理位置与 User-Agent 一致

---

### 🟣 策略 5：模拟更真实的人类行为

**已实施**：
- ✅ 随机延迟（2-8 秒）
- ✅ 模拟鼠标移动
- ✅ 模拟"阅读时间"

**可以添加**：
- ✅ 随机滚动页面
- ✅ 模拟点击非关键元素（如"点赞"按钮，但不实际点赞）
- ✅ 随机停留时间（5-30 秒）
- ✅ 模拟键盘输入（如搜索框）

**测试方法**：
```javascript
// 在页面加载后添加
await page.waitForTimeout(3000 + Math.random() * 5000); // 3-8秒随机等待

// 随机滚动
await page.evaluate(() => {
  window.scrollTo(0, Math.random() * 500);
});

// 模拟鼠标移动
await page.mouse.move(Math.random() * 1280, Math.random() * 720);
```

---

### 🟠 策略 6：检查 TikTok 账户状态

**可能的原因**：
- TikTok 账户本身被标记为可疑
- 账户访问频率过高
- 账户行为异常

**测试方法**：
1. **手动打开 Chrome**，访问相同的 TikTok 链接
2. **检查视频是否能正常加载**
3. **如果手动打开也无法加载**：
   - 说明问题不在自动化检测
   - 可能是账户/IP 被 TikTok 限制
   - 需要更换账户或 IP

---

### ⚪ 策略 7：使用不同的浏览器配置

**测试不同的配置组合**：

1. **最小化配置**（只保留必要的反检测参数）：
```javascript
args: [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--disable-infobars',
]
```

2. **完整配置**（当前实施）：
```javascript
args: [
  // ... 所有参数
]
```

3. **对比测试**：
- 哪种配置下视频能加载？
- 哪种配置下自动化提示消失？

---

## 测试步骤建议

### 第一步：验证基础配置

```bash
# 1. 使用 Chrome 测试
node scripts/test-tiktok-video-fingerprint.js --chrome

# 2. 在浏览器控制台检查反检测脚本是否生效
# （见策略 2）

# 3. 检查视频是否能加载
# 输入命令: check
```

### 第二步：如果仍然失败，尝试 playwright-stealth

```bash
# 1. 安装插件
npm install playwright-extra playwright-extra-plugin-stealth

# 2. 修改脚本使用 playwright-extra
# （需要修改代码）

# 3. 重新测试
```

### 第三步：如果仍然失败，检查账户/IP

```bash
# 1. 手动打开 Chrome，访问相同链接
# 2. 检查视频是否能正常加载
# 3. 如果手动也无法加载，说明问题不在自动化检测
```

### 第四步：如果手动可以加载，但自动化不行

```bash
# 1. 尝试使用代理
# 2. 添加更多人类化行为
# 3. 降低访问频率
```

---

## 预期结果

### 最佳情况
- ✅ Chrome 不显示自动化提示
- ✅ TikTok 视频正常加载
- ✅ 反检测脚本完全生效

### 次优情况
- ⚠️ Chrome 仍显示自动化提示（但可以忽略）
- ✅ TikTok 视频能加载
- ✅ 反检测脚本部分生效

### 需要进一步优化
- ❌ Chrome 显示自动化提示
- ❌ TikTok 视频无法加载
- ❌ 反检测脚本未生效

---

## 关键指标

### 1. Chrome 自动化提示
- **目标**：完全不显示
- **检查方法**：观察浏览器界面顶部是否有提示栏

### 2. navigator.webdriver
- **目标**：`undefined` 或 `false`
- **检查方法**：浏览器控制台执行 `console.log(navigator.webdriver)`

### 3. TikTok 视频加载
- **目标**：视频能正常播放
- **检查方法**：观察页面是否有 `<video>` 元素，且 `readyState >= 2`

### 4. 网络请求
- **目标**：视频资源请求成功（状态码 200）
- **检查方法**：浏览器开发者工具 → Network 标签页

---

## 如果所有策略都失败

### 考虑替代方案

1. **使用 undetected-chromedriver**
   - 专门为反检测设计的 Chrome 驱动
   - 可能比 Playwright 更难被检测

2. **使用 TikTok API（如果可用）**
   - 官方 API 或第三方 API
   - 避免浏览器自动化

3. **手动操作 + 半自动化**
   - 关键步骤手动操作
   - 数据提取部分自动化

4. **评估业务需求**
   - 是否真的需要完全自动化？
   - 是否可以接受部分手动操作？

---

## 总结

**当前已实施的优化**：
- ✅ 更激进的启动参数
- ✅ 页面加载前注入反检测脚本
- ✅ 独立的用户数据目录
- ✅ 人类化行为模拟

**下一步建议**：
1. 🔴 **立即测试**：验证当前配置是否有效
2. 🟡 **如果失败**：尝试 playwright-stealth 插件
3. 🟢 **如果仍失败**：检查账户/IP 状态
4. 🔵 **最后手段**：考虑替代方案

**关键**：自动化检测是一个持续对抗的过程，TikTok 的反爬系统会不断更新，需要持续优化和调整策略。


## 黑屏问题排查（已修复）

### 原因
之前添加的激进启动参数导致黑屏：
- **`--disable-features=BlinkGenPropertyTrees`**：Blink 渲染核心，禁用会导致页面无法渲染（黑屏）
- **`--disable-renderer-backgrounding`**：影响渲染器行为
- **`--metrics-recording-only`**：使 Chrome 进入特殊模式
- **覆盖 `window.navigator`**：反检测脚本中覆盖整个 navigator 对象会导致页面功能异常

### 解决方案（已实施）
- 移除所有可能影响渲染的启动参数
- 仅保留安全的反检测参数
- 移除 `window.navigator` 覆盖，只隐藏 `webdriver` 属性
- 将 `waitUntil` 从 `domcontentloaded` 改为 `load`，确保页面完全渲染

---

## 问题现状

1. **Chrome 界面仍显示"正在受到自动测试软件控制"**
2. **TikTok 红人视频无法加载**

## 根本原因分析

### 1. Chrome 自动化提示无法完全消除的原因

即使添加了 `--disable-infobars` 和 `--exclude-switches=enable-automation`，Chrome 仍可能显示自动化提示，因为：

- **Playwright 的 CDP (Chrome DevTools Protocol) 连接**：Playwright 通过 CDP 控制浏览器，Chrome 可以检测到这个连接
- **进程检测**：Chrome 可以检测到进程是由自动化工具启动的
- **用户数据目录状态**：Chrome 可能在用户数据目录中记录了自动化访问痕迹

### 2. TikTok 视频无法加载的原因

这是**结果而非原因**：
- TikTok 检测到自动化操作
- TikTok 的反爬系统主动拒绝加载视频内容
- 这是 TikTok 的防御措施

---

## 优化测试策略（按优先级排序）

### 🔴 策略 1：使用更激进的启动参数（已实施）

**已添加的参数**：
```javascript
args: [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--disable-infobars',
  '--disable-sync', // ✅ 新增：禁用同步，避免 Google 账户检测
  '--disable-extensions', // ✅ 新增：禁用扩展
  '--disable-background-networking', // ✅ 新增：禁用后台网络
  // ... 更多参数
]
```

**测试方法**：
```bash
node scripts/test-tiktok-video-fingerprint.js --chrome
```

**预期效果**：
- 减少自动化提示出现的概率
- 降低被 TikTok 检测的风险

---

### 🟡 策略 2：验证反检测脚本是否生效

**在浏览器控制台检查**：

```javascript
// 1. 检查 webdriver 是否被隐藏
console.log(navigator.webdriver); // 应该返回 undefined 或 false

// 2. 检查 chrome 对象是否存在
console.log(window.chrome); // 应该返回对象（不是 undefined）

// 3. 检查 plugins 是否被伪装
console.log(navigator.plugins.length); // 应该返回 > 0

// 4. 检查是否有 Playwright 全局变量
console.log(window.__playwright); // 应该返回 undefined
```

**如果检查失败**：
- 说明反检测脚本没有正确注入
- 需要检查 `addInitScript` 是否正常工作

---

### 🟢 策略 3：使用 playwright-stealth 插件（推荐）

**安装**：
```bash
npm install playwright-extra playwright-extra-plugin-stealth
```

**使用**：
```javascript
import { chromium } from 'playwright-extra';
import StealthPlugin from 'playwright-extra-plugin-stealth';

chromium.use(StealthPlugin());

// 然后正常使用
const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
```

**优势**：
- 自动处理所有常见的自动化指纹
- 更彻底地隐藏 `navigator.webdriver`
- 伪装更多自动化特征

**测试方法**：
1. 安装插件
2. 修改脚本使用 `playwright-extra`
3. 重新测试

---

### 🔵 策略 4：使用代理 + IP 轮换

**问题**：
- 如果所有请求来自同一 IP，TikTok 可能标记为机器人行为
- 需要模拟不同地理位置的用户

**解决方案**：
```javascript
const launchOptions = {
  // ... 其他配置
  proxy: {
    server: 'http://proxy-ip:port',
    username: 'user',
    password: 'pass'
  }
};
```

**建议**：
- 使用**住宅代理**而非数据中心代理
- 轮换不同的 IP 地址
- 确保 IP 地理位置与 User-Agent 一致

---

### 🟣 策略 5：模拟更真实的人类行为

**已实施**：
- ✅ 随机延迟（2-8 秒）
- ✅ 模拟鼠标移动
- ✅ 模拟"阅读时间"

**可以添加**：
- ✅ 随机滚动页面
- ✅ 模拟点击非关键元素（如"点赞"按钮，但不实际点赞）
- ✅ 随机停留时间（5-30 秒）
- ✅ 模拟键盘输入（如搜索框）

**测试方法**：
```javascript
// 在页面加载后添加
await page.waitForTimeout(3000 + Math.random() * 5000); // 3-8秒随机等待

// 随机滚动
await page.evaluate(() => {
  window.scrollTo(0, Math.random() * 500);
});

// 模拟鼠标移动
await page.mouse.move(Math.random() * 1280, Math.random() * 720);
```

---

### 🟠 策略 6：检查 TikTok 账户状态

**可能的原因**：
- TikTok 账户本身被标记为可疑
- 账户访问频率过高
- 账户行为异常

**测试方法**：
1. **手动打开 Chrome**，访问相同的 TikTok 链接
2. **检查视频是否能正常加载**
3. **如果手动打开也无法加载**：
   - 说明问题不在自动化检测
   - 可能是账户/IP 被 TikTok 限制
   - 需要更换账户或 IP

---

### ⚪ 策略 7：使用不同的浏览器配置

**测试不同的配置组合**：

1. **最小化配置**（只保留必要的反检测参数）：
```javascript
args: [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--disable-infobars',
]
```

2. **完整配置**（当前实施）：
```javascript
args: [
  // ... 所有参数
]
```

3. **对比测试**：
- 哪种配置下视频能加载？
- 哪种配置下自动化提示消失？

---

## 测试步骤建议

### 第一步：验证基础配置

```bash
# 1. 使用 Chrome 测试
node scripts/test-tiktok-video-fingerprint.js --chrome

# 2. 在浏览器控制台检查反检测脚本是否生效
# （见策略 2）

# 3. 检查视频是否能加载
# 输入命令: check
```

### 第二步：如果仍然失败，尝试 playwright-stealth

```bash
# 1. 安装插件
npm install playwright-extra playwright-extra-plugin-stealth

# 2. 修改脚本使用 playwright-extra
# （需要修改代码）

# 3. 重新测试
```

### 第三步：如果仍然失败，检查账户/IP

```bash
# 1. 手动打开 Chrome，访问相同链接
# 2. 检查视频是否能正常加载
# 3. 如果手动也无法加载，说明问题不在自动化检测
```

### 第四步：如果手动可以加载，但自动化不行

```bash
# 1. 尝试使用代理
# 2. 添加更多人类化行为
# 3. 降低访问频率
```

---

## 预期结果

### 最佳情况
- ✅ Chrome 不显示自动化提示
- ✅ TikTok 视频正常加载
- ✅ 反检测脚本完全生效

### 次优情况
- ⚠️ Chrome 仍显示自动化提示（但可以忽略）
- ✅ TikTok 视频能加载
- ✅ 反检测脚本部分生效

### 需要进一步优化
- ❌ Chrome 显示自动化提示
- ❌ TikTok 视频无法加载
- ❌ 反检测脚本未生效

---

## 关键指标

### 1. Chrome 自动化提示
- **目标**：完全不显示
- **检查方法**：观察浏览器界面顶部是否有提示栏

### 2. navigator.webdriver
- **目标**：`undefined` 或 `false`
- **检查方法**：浏览器控制台执行 `console.log(navigator.webdriver)`

### 3. TikTok 视频加载
- **目标**：视频能正常播放
- **检查方法**：观察页面是否有 `<video>` 元素，且 `readyState >= 2`

### 4. 网络请求
- **目标**：视频资源请求成功（状态码 200）
- **检查方法**：浏览器开发者工具 → Network 标签页

---

## 如果所有策略都失败

### 考虑替代方案

1. **使用 undetected-chromedriver**
   - 专门为反检测设计的 Chrome 驱动
   - 可能比 Playwright 更难被检测

2. **使用 TikTok API（如果可用）**
   - 官方 API 或第三方 API
   - 避免浏览器自动化

3. **手动操作 + 半自动化**
   - 关键步骤手动操作
   - 数据提取部分自动化

4. **评估业务需求**
   - 是否真的需要完全自动化？
   - 是否可以接受部分手动操作？

---

## 总结

**当前已实施的优化**：
- ✅ 更激进的启动参数
- ✅ 页面加载前注入反检测脚本
- ✅ 独立的用户数据目录
- ✅ 人类化行为模拟

**下一步建议**：
1. 🔴 **立即测试**：验证当前配置是否有效
2. 🟡 **如果失败**：尝试 playwright-stealth 插件
3. 🟢 **如果仍失败**：检查账户/IP 状态
4. 🔵 **最后手段**：考虑替代方案

**关键**：自动化检测是一个持续对抗的过程，TikTok 的反爬系统会不断更新，需要持续优化和调整策略。


## 黑屏问题排查（已修复）

### 原因
之前添加的激进启动参数导致黑屏：
- **`--disable-features=BlinkGenPropertyTrees`**：Blink 渲染核心，禁用会导致页面无法渲染（黑屏）
- **`--disable-renderer-backgrounding`**：影响渲染器行为
- **`--metrics-recording-only`**：使 Chrome 进入特殊模式
- **覆盖 `window.navigator`**：反检测脚本中覆盖整个 navigator 对象会导致页面功能异常

### 解决方案（已实施）
- 移除所有可能影响渲染的启动参数
- 仅保留安全的反检测参数
- 移除 `window.navigator` 覆盖，只隐藏 `webdriver` 属性
- 将 `waitUntil` 从 `domcontentloaded` 改为 `load`，确保页面完全渲染

---

## 问题现状

1. **Chrome 界面仍显示"正在受到自动测试软件控制"**
2. **TikTok 红人视频无法加载**

## 根本原因分析

### 1. Chrome 自动化提示无法完全消除的原因

即使添加了 `--disable-infobars` 和 `--exclude-switches=enable-automation`，Chrome 仍可能显示自动化提示，因为：

- **Playwright 的 CDP (Chrome DevTools Protocol) 连接**：Playwright 通过 CDP 控制浏览器，Chrome 可以检测到这个连接
- **进程检测**：Chrome 可以检测到进程是由自动化工具启动的
- **用户数据目录状态**：Chrome 可能在用户数据目录中记录了自动化访问痕迹

### 2. TikTok 视频无法加载的原因

这是**结果而非原因**：
- TikTok 检测到自动化操作
- TikTok 的反爬系统主动拒绝加载视频内容
- 这是 TikTok 的防御措施

---

## 优化测试策略（按优先级排序）

### 🔴 策略 1：使用更激进的启动参数（已实施）

**已添加的参数**：
```javascript
args: [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--disable-infobars',
  '--disable-sync', // ✅ 新增：禁用同步，避免 Google 账户检测
  '--disable-extensions', // ✅ 新增：禁用扩展
  '--disable-background-networking', // ✅ 新增：禁用后台网络
  // ... 更多参数
]
```

**测试方法**：
```bash
node scripts/test-tiktok-video-fingerprint.js --chrome
```

**预期效果**：
- 减少自动化提示出现的概率
- 降低被 TikTok 检测的风险

---

### 🟡 策略 2：验证反检测脚本是否生效

**在浏览器控制台检查**：

```javascript
// 1. 检查 webdriver 是否被隐藏
console.log(navigator.webdriver); // 应该返回 undefined 或 false

// 2. 检查 chrome 对象是否存在
console.log(window.chrome); // 应该返回对象（不是 undefined）

// 3. 检查 plugins 是否被伪装
console.log(navigator.plugins.length); // 应该返回 > 0

// 4. 检查是否有 Playwright 全局变量
console.log(window.__playwright); // 应该返回 undefined
```

**如果检查失败**：
- 说明反检测脚本没有正确注入
- 需要检查 `addInitScript` 是否正常工作

---

### 🟢 策略 3：使用 playwright-stealth 插件（推荐）

**安装**：
```bash
npm install playwright-extra playwright-extra-plugin-stealth
```

**使用**：
```javascript
import { chromium } from 'playwright-extra';
import StealthPlugin from 'playwright-extra-plugin-stealth';

chromium.use(StealthPlugin());

// 然后正常使用
const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
```

**优势**：
- 自动处理所有常见的自动化指纹
- 更彻底地隐藏 `navigator.webdriver`
- 伪装更多自动化特征

**测试方法**：
1. 安装插件
2. 修改脚本使用 `playwright-extra`
3. 重新测试

---

### 🔵 策略 4：使用代理 + IP 轮换

**问题**：
- 如果所有请求来自同一 IP，TikTok 可能标记为机器人行为
- 需要模拟不同地理位置的用户

**解决方案**：
```javascript
const launchOptions = {
  // ... 其他配置
  proxy: {
    server: 'http://proxy-ip:port',
    username: 'user',
    password: 'pass'
  }
};
```

**建议**：
- 使用**住宅代理**而非数据中心代理
- 轮换不同的 IP 地址
- 确保 IP 地理位置与 User-Agent 一致

---

### 🟣 策略 5：模拟更真实的人类行为

**已实施**：
- ✅ 随机延迟（2-8 秒）
- ✅ 模拟鼠标移动
- ✅ 模拟"阅读时间"

**可以添加**：
- ✅ 随机滚动页面
- ✅ 模拟点击非关键元素（如"点赞"按钮，但不实际点赞）
- ✅ 随机停留时间（5-30 秒）
- ✅ 模拟键盘输入（如搜索框）

**测试方法**：
```javascript
// 在页面加载后添加
await page.waitForTimeout(3000 + Math.random() * 5000); // 3-8秒随机等待

// 随机滚动
await page.evaluate(() => {
  window.scrollTo(0, Math.random() * 500);
});

// 模拟鼠标移动
await page.mouse.move(Math.random() * 1280, Math.random() * 720);
```

---

### 🟠 策略 6：检查 TikTok 账户状态

**可能的原因**：
- TikTok 账户本身被标记为可疑
- 账户访问频率过高
- 账户行为异常

**测试方法**：
1. **手动打开 Chrome**，访问相同的 TikTok 链接
2. **检查视频是否能正常加载**
3. **如果手动打开也无法加载**：
   - 说明问题不在自动化检测
   - 可能是账户/IP 被 TikTok 限制
   - 需要更换账户或 IP

---

### ⚪ 策略 7：使用不同的浏览器配置

**测试不同的配置组合**：

1. **最小化配置**（只保留必要的反检测参数）：
```javascript
args: [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--disable-infobars',
]
```

2. **完整配置**（当前实施）：
```javascript
args: [
  // ... 所有参数
]
```

3. **对比测试**：
- 哪种配置下视频能加载？
- 哪种配置下自动化提示消失？

---

## 测试步骤建议

### 第一步：验证基础配置

```bash
# 1. 使用 Chrome 测试
node scripts/test-tiktok-video-fingerprint.js --chrome

# 2. 在浏览器控制台检查反检测脚本是否生效
# （见策略 2）

# 3. 检查视频是否能加载
# 输入命令: check
```

### 第二步：如果仍然失败，尝试 playwright-stealth

```bash
# 1. 安装插件
npm install playwright-extra playwright-extra-plugin-stealth

# 2. 修改脚本使用 playwright-extra
# （需要修改代码）

# 3. 重新测试
```

### 第三步：如果仍然失败，检查账户/IP

```bash
# 1. 手动打开 Chrome，访问相同链接
# 2. 检查视频是否能正常加载
# 3. 如果手动也无法加载，说明问题不在自动化检测
```

### 第四步：如果手动可以加载，但自动化不行

```bash
# 1. 尝试使用代理
# 2. 添加更多人类化行为
# 3. 降低访问频率
```

---

## 预期结果

### 最佳情况
- ✅ Chrome 不显示自动化提示
- ✅ TikTok 视频正常加载
- ✅ 反检测脚本完全生效

### 次优情况
- ⚠️ Chrome 仍显示自动化提示（但可以忽略）
- ✅ TikTok 视频能加载
- ✅ 反检测脚本部分生效

### 需要进一步优化
- ❌ Chrome 显示自动化提示
- ❌ TikTok 视频无法加载
- ❌ 反检测脚本未生效

---

## 关键指标

### 1. Chrome 自动化提示
- **目标**：完全不显示
- **检查方法**：观察浏览器界面顶部是否有提示栏

### 2. navigator.webdriver
- **目标**：`undefined` 或 `false`
- **检查方法**：浏览器控制台执行 `console.log(navigator.webdriver)`

### 3. TikTok 视频加载
- **目标**：视频能正常播放
- **检查方法**：观察页面是否有 `<video>` 元素，且 `readyState >= 2`

### 4. 网络请求
- **目标**：视频资源请求成功（状态码 200）
- **检查方法**：浏览器开发者工具 → Network 标签页

---

## 如果所有策略都失败

### 考虑替代方案

1. **使用 undetected-chromedriver**
   - 专门为反检测设计的 Chrome 驱动
   - 可能比 Playwright 更难被检测

2. **使用 TikTok API（如果可用）**
   - 官方 API 或第三方 API
   - 避免浏览器自动化

3. **手动操作 + 半自动化**
   - 关键步骤手动操作
   - 数据提取部分自动化

4. **评估业务需求**
   - 是否真的需要完全自动化？
   - 是否可以接受部分手动操作？

---

## 总结

**当前已实施的优化**：
- ✅ 更激进的启动参数
- ✅ 页面加载前注入反检测脚本
- ✅ 独立的用户数据目录
- ✅ 人类化行为模拟

**下一步建议**：
1. 🔴 **立即测试**：验证当前配置是否有效
2. 🟡 **如果失败**：尝试 playwright-stealth 插件
3. 🟢 **如果仍失败**：检查账户/IP 状态
4. 🔵 **最后手段**：考虑替代方案

**关键**：自动化检测是一个持续对抗的过程，TikTok 的反爬系统会不断更新，需要持续优化和调整策略。

