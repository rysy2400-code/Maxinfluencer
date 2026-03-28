#!/bin/bash
#
# 启动 Chrome 并开启远程调试端口
# 用于 --connect 模式：Playwright 连接到此 Chrome 实例，可规避"受自动测试软件控制"的检测
#
# 使用方法：
#   1. 先关闭所有 Chrome 窗口（重要！否则会冲突）
#   2. 运行: ./scripts/launch-chrome-remote-debug.sh
#   3. 在另一个终端运行: node scripts/test-tiktok-video-fingerprint.js --connect
#
# 可选环境变量：
#   TIKTOK_USER_DATA_DIR - 用户数据目录（默认使用 .tiktok-user-data）
#   CDP_PORT - 端口号（默认 9222）
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

USER_DATA_DIR="${TIKTOK_USER_DATA_DIR:-$PROJECT_ROOT/.tiktok-user-data}"

# 解析命令行参数
CDP_PORT="${CDP_PORT:-9222}"
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
if [[ -n "$TIKTOK_USER_DATA_DIR" ]]; then
  echo "[env] ✅ 使用环境变量指定的用户数据目录: $USER_DATA_DIR"
else
  echo "[env] ⚠️  使用默认目录，如需使用已登录的目录，请设置 TIKTOK_USER_DATA_DIR"
fi

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
echo "启动 Chrome（远程调试模式）"
echo "=========================================="
echo "Chrome 路径: $CHROME_PATH"
echo "用户数据目录: $USER_DATA_DIR"
echo "CDP 端口: $CDP_PORT"
echo ""
echo "提示: 请确保已关闭所有 Chrome 窗口后再运行此脚本"
echo "连接后运行: node scripts/test-tiktok-video-fingerprint.js --connect"
echo "=========================================="

exec "$CHROME_PATH" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$@"


# 启动 Chrome 并开启远程调试端口
# 用于 --connect 模式：Playwright 连接到此 Chrome 实例，可规避"受自动测试软件控制"的检测
#
# 使用方法：
#   1. 先关闭所有 Chrome 窗口（重要！否则会冲突）
#   2. 运行: ./scripts/launch-chrome-remote-debug.sh
#   3. 在另一个终端运行: node scripts/test-tiktok-video-fingerprint.js --connect
#
# 可选环境变量：
#   TIKTOK_USER_DATA_DIR - 用户数据目录（默认使用 .tiktok-user-data）
#   CDP_PORT - 端口号（默认 9222）
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

USER_DATA_DIR="${TIKTOK_USER_DATA_DIR:-$PROJECT_ROOT/.tiktok-user-data}"

# 解析命令行参数
CDP_PORT="${CDP_PORT:-9222}"
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
if [[ -n "$TIKTOK_USER_DATA_DIR" ]]; then
  echo "[env] ✅ 使用环境变量指定的用户数据目录: $USER_DATA_DIR"
else
  echo "[env] ⚠️  使用默认目录，如需使用已登录的目录，请设置 TIKTOK_USER_DATA_DIR"
fi

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
echo "启动 Chrome（远程调试模式）"
echo "=========================================="
echo "Chrome 路径: $CHROME_PATH"
echo "用户数据目录: $USER_DATA_DIR"
echo "CDP 端口: $CDP_PORT"
echo ""
echo "提示: 请确保已关闭所有 Chrome 窗口后再运行此脚本"
echo "连接后运行: node scripts/test-tiktok-video-fingerprint.js --connect"
echo "=========================================="

exec "$CHROME_PATH" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$@"


# 启动 Chrome 并开启远程调试端口
# 用于 --connect 模式：Playwright 连接到此 Chrome 实例，可规避"受自动测试软件控制"的检测
#
# 使用方法：
#   1. 先关闭所有 Chrome 窗口（重要！否则会冲突）
#   2. 运行: ./scripts/launch-chrome-remote-debug.sh
#   3. 在另一个终端运行: node scripts/test-tiktok-video-fingerprint.js --connect
#
# 可选环境变量：
#   TIKTOK_USER_DATA_DIR - 用户数据目录（默认使用 .tiktok-user-data）
#   CDP_PORT - 端口号（默认 9222）
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

USER_DATA_DIR="${TIKTOK_USER_DATA_DIR:-$PROJECT_ROOT/.tiktok-user-data}"

# 解析命令行参数
CDP_PORT="${CDP_PORT:-9222}"
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
if [[ -n "$TIKTOK_USER_DATA_DIR" ]]; then
  echo "[env] ✅ 使用环境变量指定的用户数据目录: $USER_DATA_DIR"
else
  echo "[env] ⚠️  使用默认目录，如需使用已登录的目录，请设置 TIKTOK_USER_DATA_DIR"
fi

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
echo "启动 Chrome（远程调试模式）"
echo "=========================================="
echo "Chrome 路径: $CHROME_PATH"
echo "用户数据目录: $USER_DATA_DIR"
echo "CDP 端口: $CDP_PORT"
echo ""
echo "提示: 请确保已关闭所有 Chrome 窗口后再运行此脚本"
echo "连接后运行: node scripts/test-tiktok-video-fingerprint.js --connect"
echo "=========================================="

exec "$CHROME_PATH" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$@"

