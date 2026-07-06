#!/bin/bash
#
# 启动 Chrome 并开启远程调试端口（用于主页提取）
# 用于 --connect 模式：Playwright 连接到此 Chrome 实例，可规避"受自动测试软件控制"的检测
#
# 使用方法：
#   1. 先关闭所有 Chrome 窗口（重要！否则会冲突）
#   2. 运行: ./scripts/launch-chrome-remote-debug-enrich.sh
#   3. 在另一个终端运行: node scripts/test-tiktok-video-fingerprint.js --connect
#
# 可选环境变量：
#   TIKTOK_USER_DATA_DIR_ENRICH - 用户数据目录（默认使用 .tiktok-user-data-enrich）
#   CDP_ENDPOINT_ENRICH - CDP 端口（默认 9223）
#
# 命令行参数：
#   --port <端口号> - 指定 CDP 端口（覆盖环境变量）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 加载 .env 文件（如果存在）
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  echo "[env] 正在加载 .env 文件..."
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.env" | grep -v '^$' | sed 's/^/export /')
  set +a
  echo "[env] ✅ .env 文件已加载"
fi

# 加载 .env.local 文件（如果存在）
if [[ -f "$PROJECT_ROOT/.env.local" ]]; then
  echo "[env] 正在加载 .env.local 文件..."
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.env.local" | grep -v '^$' | sed 's/^/export /')
  set +a
  echo "[env] ✅ .env.local 文件已加载"
fi

# 使用独立的用户数据目录（不需要登录状态）
USER_DATA_DIR="${TIKTOK_USER_DATA_DIR_ENRICH:-$PROJECT_ROOT/.tiktok-user-data-enrich}"

# 解析命令行参数
CDP_PORT="${CDP_ENDPOINT_ENRICH:-9223}"
# 如果 CDP_ENDPOINT_ENRICH 是完整 URL，提取端口号
if [[ "$CDP_PORT" == http* ]]; then
  CDP_PORT=$(echo "$CDP_PORT" | sed 's/.*:\([0-9]*\).*/\1/')
fi
CDP_PORT="${CDP_PORT:-9223}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --port)
      CDP_PORT="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# 显示使用的用户数据目录
echo "[env] ✅ 使用独立的用户数据目录（不需要登录状态）: $USER_DATA_DIR"

# macOS Chrome 路径
CHROME_PATH=""
if [[ "$OSTYPE" == "darwin"* ]]; then
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  elif [[ -d "/Applications/Chromium.app" ]]; then
    CHROME_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium"
  fi
fi

if [[ -z "$CHROME_PATH" || ! -f "$CHROME_PATH" ]]; then
  echo "错误: 未找到 Chrome 浏览器"
  echo "请确保已安装 Google Chrome: https://www.google.com/chrome/"
  exit 1
fi

echo "=========================================="
echo "启动 Chrome（远程调试模式 - 主页提取）"
echo "=========================================="
echo "Chrome 路径: $CHROME_PATH"
echo "用户数据目录: $USER_DATA_DIR"
echo "CDP 端口: $CDP_PORT"
echo ""
echo "提示: 请确保已关闭所有 Chrome 窗口后再运行此脚本"
echo "此实例用于主页提取，不需要登录 TikTok"
echo "=========================================="

exec "$CHROME_PATH" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$@"

#
# 启动 Chrome 并开启远程调试端口（用于主页提取）
# 用于 --connect 模式：Playwright 连接到此 Chrome 实例，可规避"受自动测试软件控制"的检测
#
# 使用方法：
#   1. 先关闭所有 Chrome 窗口（重要！否则会冲突）
#   2. 运行: ./scripts/launch-chrome-remote-debug-enrich.sh
#   3. 在另一个终端运行: node scripts/test-tiktok-video-fingerprint.js --connect
#
# 可选环境变量：
#   TIKTOK_USER_DATA_DIR_ENRICH - 用户数据目录（默认使用 .tiktok-user-data-enrich）
#   CDP_ENDPOINT_ENRICH - CDP 端口（默认 9223）
#
# 命令行参数：
#   --port <端口号> - 指定 CDP 端口（覆盖环境变量）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 加载 .env 文件（如果存在）
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  echo "[env] 正在加载 .env 文件..."
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.env" | grep -v '^$' | sed 's/^/export /')
  set +a
  echo "[env] ✅ .env 文件已加载"
fi

# 加载 .env.local 文件（如果存在）
if [[ -f "$PROJECT_ROOT/.env.local" ]]; then
  echo "[env] 正在加载 .env.local 文件..."
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.env.local" | grep -v '^$' | sed 's/^/export /')
  set +a
  echo "[env] ✅ .env.local 文件已加载"
fi

# 使用独立的用户数据目录（不需要登录状态）
USER_DATA_DIR="${TIKTOK_USER_DATA_DIR_ENRICH:-$PROJECT_ROOT/.tiktok-user-data-enrich}"

# 解析命令行参数
CDP_PORT="${CDP_ENDPOINT_ENRICH:-9223}"
# 如果 CDP_ENDPOINT_ENRICH 是完整 URL，提取端口号
if [[ "$CDP_PORT" == http* ]]; then
  CDP_PORT=$(echo "$CDP_PORT" | sed 's/.*:\([0-9]*\).*/\1/')
fi
CDP_PORT="${CDP_PORT:-9223}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --port)
      CDP_PORT="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# 显示使用的用户数据目录
echo "[env] ✅ 使用独立的用户数据目录（不需要登录状态）: $USER_DATA_DIR"

# macOS Chrome 路径
CHROME_PATH=""
if [[ "$OSTYPE" == "darwin"* ]]; then
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  elif [[ -d "/Applications/Chromium.app" ]]; then
    CHROME_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium"
  fi
fi

if [[ -z "$CHROME_PATH" || ! -f "$CHROME_PATH" ]]; then
  echo "错误: 未找到 Chrome 浏览器"
  echo "请确保已安装 Google Chrome: https://www.google.com/chrome/"
  exit 1
fi

echo "=========================================="
echo "启动 Chrome（远程调试模式 - 主页提取）"
echo "=========================================="
echo "Chrome 路径: $CHROME_PATH"
echo "用户数据目录: $USER_DATA_DIR"
echo "CDP 端口: $CDP_PORT"
echo ""
echo "提示: 请确保已关闭所有 Chrome 窗口后再运行此脚本"
echo "此实例用于主页提取，不需要登录 TikTok"
echo "=========================================="

exec "$CHROME_PATH" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$@"

#
# 启动 Chrome 并开启远程调试端口（用于主页提取）
# 用于 --connect 模式：Playwright 连接到此 Chrome 实例，可规避"受自动测试软件控制"的检测
#
# 使用方法：
#   1. 先关闭所有 Chrome 窗口（重要！否则会冲突）
#   2. 运行: ./scripts/launch-chrome-remote-debug-enrich.sh
#   3. 在另一个终端运行: node scripts/test-tiktok-video-fingerprint.js --connect
#
# 可选环境变量：
#   TIKTOK_USER_DATA_DIR_ENRICH - 用户数据目录（默认使用 .tiktok-user-data-enrich）
#   CDP_ENDPOINT_ENRICH - CDP 端口（默认 9223）
#
# 命令行参数：
#   --port <端口号> - 指定 CDP 端口（覆盖环境变量）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 加载 .env 文件（如果存在）
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  echo "[env] 正在加载 .env 文件..."
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.env" | grep -v '^$' | sed 's/^/export /')
  set +a
  echo "[env] ✅ .env 文件已加载"
fi

# 加载 .env.local 文件（如果存在）
if [[ -f "$PROJECT_ROOT/.env.local" ]]; then
  echo "[env] 正在加载 .env.local 文件..."
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.env.local" | grep -v '^$' | sed 's/^/export /')
  set +a
  echo "[env] ✅ .env.local 文件已加载"
fi

# 使用独立的用户数据目录（不需要登录状态）
USER_DATA_DIR="${TIKTOK_USER_DATA_DIR_ENRICH:-$PROJECT_ROOT/.tiktok-user-data-enrich}"

# 解析命令行参数
CDP_PORT="${CDP_ENDPOINT_ENRICH:-9223}"
# 如果 CDP_ENDPOINT_ENRICH 是完整 URL，提取端口号
if [[ "$CDP_PORT" == http* ]]; then
  CDP_PORT=$(echo "$CDP_PORT" | sed 's/.*:\([0-9]*\).*/\1/')
fi
CDP_PORT="${CDP_PORT:-9223}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --port)
      CDP_PORT="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# 显示使用的用户数据目录
echo "[env] ✅ 使用独立的用户数据目录（不需要登录状态）: $USER_DATA_DIR"

# macOS Chrome 路径
CHROME_PATH=""
if [[ "$OSTYPE" == "darwin"* ]]; then
  if [[ -d "/Applications/Google Chrome.app" ]]; then
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  elif [[ -d "/Applications/Chromium.app" ]]; then
    CHROME_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium"
  fi
fi

if [[ -z "$CHROME_PATH" || ! -f "$CHROME_PATH" ]]; then
  echo "错误: 未找到 Chrome 浏览器"
  echo "请确保已安装 Google Chrome: https://www.google.com/chrome/"
  exit 1
fi

echo "=========================================="
echo "启动 Chrome（远程调试模式 - 主页提取）"
echo "=========================================="
echo "Chrome 路径: $CHROME_PATH"
echo "用户数据目录: $USER_DATA_DIR"
echo "CDP 端口: $CDP_PORT"
echo ""
echo "提示: 请确保已关闭所有 Chrome 窗口后再运行此脚本"
echo "此实例用于主页提取，不需要登录 TikTok"
echo "=========================================="

exec "$CHROME_PATH" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$@"


