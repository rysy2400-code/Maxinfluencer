# 连接模式（--connect）使用指南

## 为什么需要连接模式？

当 Playwright **启动** Chrome 时，Chrome 会：
- 显示「Chrome 正受到自动测试软件的控制」提示
- 设置 `navigator.webdriver = true`
- 被 TikTok 等网站识别为自动化，导致视频无法加载

**连接模式**的原理：你先**手动**启动 Chrome（不带自动化标志），Playwright 再通过 CDP 连接上去。这样：
- ✅ 无「受自动测试软件控制」提示
- ✅ `navigator.webdriver` 为 false
- ✅ TikTok 视频可正常加载

---

## 🚀 快速开始（推荐：一键测试）

**最简单的方式**：使用一键测试脚本，**一个终端完成所有操作**：

```bash
# 方式 1：使用 Chromium（默认）
bash scripts/test-with-connect.sh

# 方式 2：使用系统 Chrome
bash scripts/test-with-connect.sh --chrome
```

脚本会自动：
1. ✅ 检查 Chrome 是否已运行（CDP 端口是否开启）
2. ✅ 如果没有，自动启动 Chrome（后台运行）
3. ✅ 运行测试脚本（连接模式）
4. ✅ 测试完成后询问是否关闭 Chrome

**无需手动操作，一键完成！**

---

## 📋 手动步骤（了解原理）

如果你想了解详细步骤，可以手动操作：

### 第一步：关闭所有 Chrome 窗口

**重要**：必须先关闭所有 Chrome 窗口，否则会因用户数据目录冲突而无法启动。

### 第二步：启动 Chrome（远程调试模式）

```bash
# 方式 1：使用脚本
bash scripts/launch-chrome-remote-debug.sh

# 方式 2：手动执行（macOS）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/Users/duanzijun/Desktop/Maxinfluencer/.tiktok-user-data
```

脚本会启动一个 Chrome 窗口，使用项目的 `.tiktok-user-data` 目录（包含 TikTok 登录状态）。

### 第三步：在 Chrome 中登录 TikTok（如未登录）

在刚启动的 Chrome 中访问 https://www.tiktok.com 并登录。

### 第四步：运行测试脚本（连接模式）

在**另一个终端**中执行：

```bash
node scripts/test-tiktok-video-fingerprint.js --connect
```

脚本会连接到已启动的 Chrome，打开红人主页并执行自动化操作。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CDP_ENDPOINT` | CDP 连接地址 | `http://localhost:9222` |
| `CDP_PORT` | 端口号（仅 launch 脚本使用） | `9222` |
| `TIKTOK_USER_DATA_DIR` | 用户数据目录 | `.tiktok-user-data` |

---

## 常见问题

### 1. 连接失败：connect ECONNREFUSED

**原因**：Chrome 未以远程调试模式启动，或端口不对。

**解决**：先运行 `bash scripts/launch-chrome-remote-debug.sh`，确保 Chrome 已启动后再运行测试脚本。

### 2. Chrome 无法启动：用户数据目录被占用

**原因**：已有 Chrome 实例在使用同一用户数据目录。

**解决**：关闭所有 Chrome 窗口后重试。

### 3. 退出时 Chrome 被关闭了

**说明**：连接模式下，输入 `exit` 只会断开 Playwright 的连接，**不会**关闭 Chrome。Chrome 会继续运行，你可以手动关闭。

### 4. 使用不同的用户数据目录

如需使用已登录 TikTok 的 Chrome 配置：

```bash
# 启动时指定
TIKTOK_USER_DATA_DIR=/path/to/your/chrome/profile bash scripts/launch-chrome-remote-debug.sh

# 测试脚本会连接到 localhost:9222，无需额外配置
node scripts/test-tiktok-video-fingerprint.js --connect
```

---

## 对比：连接模式 vs 启动模式

| 特性 | 启动模式（默认） | 连接模式（--connect） |
|------|------------------|------------------------|
| 自动化提示 | ❌ 显示 | ✅ 不显示 |
| 视频加载 | ❌ 可能被拦截 | ✅ 正常 |
| 使用方式 | 一键运行 | 需先启动 Chrome |
| 适用场景 | 快速测试 | 生产/稳定使用 |

---

## 生产环境建议

如需在生产流程中使用连接模式：

1. **方案 A**：在服务器上预先启动 Chrome（远程调试模式），测试脚本通过 `--connect` 连接
2. **方案 B**：使用进程管理工具（如 systemd、supervisor）保持 Chrome 常驻，按需连接
3. **方案 C**：在 CI/CD 中，先启动 Chrome 再运行测试

注意：连接模式需要 Chrome 已运行，无法做到「一键启动」。如需完全自动化，可考虑将启动 Chrome 的步骤也写入脚本，通过子进程启动。


## 为什么需要连接模式？

当 Playwright **启动** Chrome 时，Chrome 会：
- 显示「Chrome 正受到自动测试软件的控制」提示
- 设置 `navigator.webdriver = true`
- 被 TikTok 等网站识别为自动化，导致视频无法加载

**连接模式**的原理：你先**手动**启动 Chrome（不带自动化标志），Playwright 再通过 CDP 连接上去。这样：
- ✅ 无「受自动测试软件控制」提示
- ✅ `navigator.webdriver` 为 false
- ✅ TikTok 视频可正常加载

---

## 🚀 快速开始（推荐：一键测试）

**最简单的方式**：使用一键测试脚本，**一个终端完成所有操作**：

```bash
# 方式 1：使用 Chromium（默认）
bash scripts/test-with-connect.sh

# 方式 2：使用系统 Chrome
bash scripts/test-with-connect.sh --chrome
```

脚本会自动：
1. ✅ 检查 Chrome 是否已运行（CDP 端口是否开启）
2. ✅ 如果没有，自动启动 Chrome（后台运行）
3. ✅ 运行测试脚本（连接模式）
4. ✅ 测试完成后询问是否关闭 Chrome

**无需手动操作，一键完成！**

---

## 📋 手动步骤（了解原理）

如果你想了解详细步骤，可以手动操作：

### 第一步：关闭所有 Chrome 窗口

**重要**：必须先关闭所有 Chrome 窗口，否则会因用户数据目录冲突而无法启动。

### 第二步：启动 Chrome（远程调试模式）

```bash
# 方式 1：使用脚本
bash scripts/launch-chrome-remote-debug.sh

# 方式 2：手动执行（macOS）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/Users/duanzijun/Desktop/Maxinfluencer/.tiktok-user-data
```

脚本会启动一个 Chrome 窗口，使用项目的 `.tiktok-user-data` 目录（包含 TikTok 登录状态）。

### 第三步：在 Chrome 中登录 TikTok（如未登录）

在刚启动的 Chrome 中访问 https://www.tiktok.com 并登录。

### 第四步：运行测试脚本（连接模式）

在**另一个终端**中执行：

```bash
node scripts/test-tiktok-video-fingerprint.js --connect
```

脚本会连接到已启动的 Chrome，打开红人主页并执行自动化操作。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CDP_ENDPOINT` | CDP 连接地址 | `http://localhost:9222` |
| `CDP_PORT` | 端口号（仅 launch 脚本使用） | `9222` |
| `TIKTOK_USER_DATA_DIR` | 用户数据目录 | `.tiktok-user-data` |

---

## 常见问题

### 1. 连接失败：connect ECONNREFUSED

**原因**：Chrome 未以远程调试模式启动，或端口不对。

**解决**：先运行 `bash scripts/launch-chrome-remote-debug.sh`，确保 Chrome 已启动后再运行测试脚本。

### 2. Chrome 无法启动：用户数据目录被占用

**原因**：已有 Chrome 实例在使用同一用户数据目录。

**解决**：关闭所有 Chrome 窗口后重试。

### 3. 退出时 Chrome 被关闭了

**说明**：连接模式下，输入 `exit` 只会断开 Playwright 的连接，**不会**关闭 Chrome。Chrome 会继续运行，你可以手动关闭。

### 4. 使用不同的用户数据目录

如需使用已登录 TikTok 的 Chrome 配置：

```bash
# 启动时指定
TIKTOK_USER_DATA_DIR=/path/to/your/chrome/profile bash scripts/launch-chrome-remote-debug.sh

# 测试脚本会连接到 localhost:9222，无需额外配置
node scripts/test-tiktok-video-fingerprint.js --connect
```

---

## 对比：连接模式 vs 启动模式

| 特性 | 启动模式（默认） | 连接模式（--connect） |
|------|------------------|------------------------|
| 自动化提示 | ❌ 显示 | ✅ 不显示 |
| 视频加载 | ❌ 可能被拦截 | ✅ 正常 |
| 使用方式 | 一键运行 | 需先启动 Chrome |
| 适用场景 | 快速测试 | 生产/稳定使用 |

---

## 生产环境建议

如需在生产流程中使用连接模式：

1. **方案 A**：在服务器上预先启动 Chrome（远程调试模式），测试脚本通过 `--connect` 连接
2. **方案 B**：使用进程管理工具（如 systemd、supervisor）保持 Chrome 常驻，按需连接
3. **方案 C**：在 CI/CD 中，先启动 Chrome 再运行测试

注意：连接模式需要 Chrome 已运行，无法做到「一键启动」。如需完全自动化，可考虑将启动 Chrome 的步骤也写入脚本，通过子进程启动。


## 为什么需要连接模式？

当 Playwright **启动** Chrome 时，Chrome 会：
- 显示「Chrome 正受到自动测试软件的控制」提示
- 设置 `navigator.webdriver = true`
- 被 TikTok 等网站识别为自动化，导致视频无法加载

**连接模式**的原理：你先**手动**启动 Chrome（不带自动化标志），Playwright 再通过 CDP 连接上去。这样：
- ✅ 无「受自动测试软件控制」提示
- ✅ `navigator.webdriver` 为 false
- ✅ TikTok 视频可正常加载

---

## 🚀 快速开始（推荐：一键测试）

**最简单的方式**：使用一键测试脚本，**一个终端完成所有操作**：

```bash
# 方式 1：使用 Chromium（默认）
bash scripts/test-with-connect.sh

# 方式 2：使用系统 Chrome
bash scripts/test-with-connect.sh --chrome
```

脚本会自动：
1. ✅ 检查 Chrome 是否已运行（CDP 端口是否开启）
2. ✅ 如果没有，自动启动 Chrome（后台运行）
3. ✅ 运行测试脚本（连接模式）
4. ✅ 测试完成后询问是否关闭 Chrome

**无需手动操作，一键完成！**

---

## 📋 手动步骤（了解原理）

如果你想了解详细步骤，可以手动操作：

### 第一步：关闭所有 Chrome 窗口

**重要**：必须先关闭所有 Chrome 窗口，否则会因用户数据目录冲突而无法启动。

### 第二步：启动 Chrome（远程调试模式）

```bash
# 方式 1：使用脚本
bash scripts/launch-chrome-remote-debug.sh

# 方式 2：手动执行（macOS）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/Users/duanzijun/Desktop/Maxinfluencer/.tiktok-user-data
```

脚本会启动一个 Chrome 窗口，使用项目的 `.tiktok-user-data` 目录（包含 TikTok 登录状态）。

### 第三步：在 Chrome 中登录 TikTok（如未登录）

在刚启动的 Chrome 中访问 https://www.tiktok.com 并登录。

### 第四步：运行测试脚本（连接模式）

在**另一个终端**中执行：

```bash
node scripts/test-tiktok-video-fingerprint.js --connect
```

脚本会连接到已启动的 Chrome，打开红人主页并执行自动化操作。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CDP_ENDPOINT` | CDP 连接地址 | `http://localhost:9222` |
| `CDP_PORT` | 端口号（仅 launch 脚本使用） | `9222` |
| `TIKTOK_USER_DATA_DIR` | 用户数据目录 | `.tiktok-user-data` |

---

## 常见问题

### 1. 连接失败：connect ECONNREFUSED

**原因**：Chrome 未以远程调试模式启动，或端口不对。

**解决**：先运行 `bash scripts/launch-chrome-remote-debug.sh`，确保 Chrome 已启动后再运行测试脚本。

### 2. Chrome 无法启动：用户数据目录被占用

**原因**：已有 Chrome 实例在使用同一用户数据目录。

**解决**：关闭所有 Chrome 窗口后重试。

### 3. 退出时 Chrome 被关闭了

**说明**：连接模式下，输入 `exit` 只会断开 Playwright 的连接，**不会**关闭 Chrome。Chrome 会继续运行，你可以手动关闭。

### 4. 使用不同的用户数据目录

如需使用已登录 TikTok 的 Chrome 配置：

```bash
# 启动时指定
TIKTOK_USER_DATA_DIR=/path/to/your/chrome/profile bash scripts/launch-chrome-remote-debug.sh

# 测试脚本会连接到 localhost:9222，无需额外配置
node scripts/test-tiktok-video-fingerprint.js --connect
```

---

## 对比：连接模式 vs 启动模式

| 特性 | 启动模式（默认） | 连接模式（--connect） |
|------|------------------|------------------------|
| 自动化提示 | ❌ 显示 | ✅ 不显示 |
| 视频加载 | ❌ 可能被拦截 | ✅ 正常 |
| 使用方式 | 一键运行 | 需先启动 Chrome |
| 适用场景 | 快速测试 | 生产/稳定使用 |

---

## 生产环境建议

如需在生产流程中使用连接模式：

1. **方案 A**：在服务器上预先启动 Chrome（远程调试模式），测试脚本通过 `--connect` 连接
2. **方案 B**：使用进程管理工具（如 systemd、supervisor）保持 Chrome 常驻，按需连接
3. **方案 C**：在 CI/CD 中，先启动 Chrome 再运行测试

注意：连接模式需要 Chrome 已运行，无法做到「一键启动」。如需完全自动化，可考虑将启动 Chrome 的步骤也写入脚本，通过子进程启动。

