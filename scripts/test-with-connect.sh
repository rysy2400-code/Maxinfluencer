#!/bin/bash
#
# 一键测试脚本：自动启动 Chrome（远程调试）并运行测试
# 使用方法：
#   bash scripts/test-with-connect.sh
#   或
#   bash scripts/test-with-connect.sh --chrome  # 使用系统 Chrome
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 加载 .env 文件（如果存在）
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  echo "[env] 正在加载 .env 文件..."
  # 使用 export 导出 .env 中的变量（忽略注释和空行）
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.env" | grep -v '^$' | sed 's/^/export /')
  set +a
  echo "[env] ✅ .env 文件已加载"
fi

CDP_PORT="${CDP_PORT:-9222}"
CDP_ENDPOINT="http://localhost:$CDP_PORT"

# 检测参数
USE_CHROME=""
if [[ "$*" == *"--chrome"* ]]; then
  USE_CHROME="--chrome"
fi

echo "=========================================="
echo "一键测试：自动启动 Chrome 并连接测试"
echo "=========================================="
echo "CDP 端口: $CDP_PORT"
echo ""

# 函数：检查端口是否被占用
check_port() {
  if lsof -Pi :$CDP_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    return 0  # 端口已被占用
  else
    return 1  # 端口未被占用
  fi
}

# 函数：启动 Chrome（后台运行）
start_chrome() {
  echo "[1/3] 正在启动 Chrome（远程调试模式）..."
  
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

  # 使用环境变量中的用户数据目录（如果已设置），否则使用默认目录
  # 重要：如果环境变量中指定了已登录的用户数据目录，Chrome 会自动使用该目录中的登录状态
  USER_DATA_DIR="${TIKTOK_USER_DATA_DIR:-$PROJECT_ROOT/.tiktok-user-data}"

  echo "   用户数据目录: $USER_DATA_DIR"
  if [[ -n "$TIKTOK_USER_DATA_DIR" ]]; then
    echo "   ✅ 使用环境变量指定的用户数据目录（应包含 TikTok 登录状态）"
    echo "   环境变量值: $TIKTOK_USER_DATA_DIR"
    
    # 检查目录是否存在
    if [[ -d "$USER_DATA_DIR" ]]; then
      echo "   ✅ 目录存在"
      
      # 检查是否包含 Chrome 配置文件
      if [[ -d "$USER_DATA_DIR/Default" ]] || [[ -f "$USER_DATA_DIR/Local State" ]]; then
        echo "   ✅ 目录包含 Chrome 配置文件"
      else
        echo "   ⚠️  警告：目录可能不是有效的 Chrome 用户数据目录"
        echo "   提示：Chrome 用户数据目录应包含 'Default' 子目录或 'Local State' 文件"
      fi
    else
      echo "   ❌ 错误：目录不存在: $USER_DATA_DIR"
      echo "   请检查环境变量 TIKTOK_USER_DATA_DIR 的值是否正确"
      exit 1
    fi
  else
    echo "   ⚠️  使用默认目录，如需使用已登录的目录，请设置 TIKTOK_USER_DATA_DIR 环境变量"
    echo "   提示：可以在 .env 文件中设置，或使用 export TIKTOK_USER_DATA_DIR=/path/to/profile"
  fi

  # 启动 Chrome（后台运行）
  "$CHROME_PATH" \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$USER_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    >/dev/null 2>&1 &

  CHROME_PID=$!
  echo "✅ Chrome 已启动（PID: $CHROME_PID）"

  # 等待 Chrome 启动并开启 CDP 端口
  echo "   等待 Chrome 就绪..."
  for i in {1..30}; do
    if check_port; then
      echo "✅ Chrome 已就绪（CDP 端口已开启）"
      return 0
    fi
    sleep 1
  done

  echo "❌ Chrome 启动超时（30秒内 CDP 端口未开启）"
  kill $CHROME_PID 2>/dev/null || true
  exit 1
}

# 函数：清理 Chrome 进程
cleanup_chrome() {
  if [[ -n "$CHROME_PID" ]]; then
    echo ""
    echo "=========================================="
    read -p "是否关闭 Chrome？(y/N): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      echo "正在关闭 Chrome（PID: $CHROME_PID）..."
      kill $CHROME_PID 2>/dev/null || true
      echo "✅ Chrome 已关闭"
    else
      echo "Chrome 将继续运行，你可以手动关闭"
      echo "CDP 地址: $CDP_ENDPOINT"
    fi
  fi
}

# 设置退出时清理
trap cleanup_chrome EXIT

# 检查 CDP 端口是否已开启
if check_port; then
  echo "[1/3] ✅ Chrome 已在运行（CDP 端口已开启）"
  CHROME_PID=""  # 不管理已存在的 Chrome
else
  start_chrome
fi

# 等待一下，确保连接稳定
sleep 2

# 运行测试脚本
echo ""
echo "[2/3] 正在运行测试脚本..."
echo "=========================================="
echo ""

cd "$PROJECT_ROOT"
node scripts/test-tiktok-video-fingerprint.js --connect $USE_CHROME

echo ""
echo "[3/3] ✅ 测试完成"


# 一键测试脚本：自动启动 Chrome（远程调试）并运行测试
# 使用方法：
#   bash scripts/test-with-connect.sh
#   或
#   bash scripts/test-with-connect.sh --chrome  # 使用系统 Chrome
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 加载 .env 文件（如果存在）
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  echo "[env] 正在加载 .env 文件..."
  # 使用 export 导出 .env 中的变量（忽略注释和空行）
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.env" | grep -v '^$' | sed 's/^/export /')
  set +a
  echo "[env] ✅ .env 文件已加载"
fi

CDP_PORT="${CDP_PORT:-9222}"
CDP_ENDPOINT="http://localhost:$CDP_PORT"

# 检测参数
USE_CHROME=""
if [[ "$*" == *"--chrome"* ]]; then
  USE_CHROME="--chrome"
fi

echo "=========================================="
echo "一键测试：自动启动 Chrome 并连接测试"
echo "=========================================="
echo "CDP 端口: $CDP_PORT"
echo ""

# 函数：检查端口是否被占用
check_port() {
  if lsof -Pi :$CDP_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    return 0  # 端口已被占用
  else
    return 1  # 端口未被占用
  fi
}

# 函数：启动 Chrome（后台运行）
start_chrome() {
  echo "[1/3] 正在启动 Chrome（远程调试模式）..."
  
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

  # 使用环境变量中的用户数据目录（如果已设置），否则使用默认目录
  # 重要：如果环境变量中指定了已登录的用户数据目录，Chrome 会自动使用该目录中的登录状态
  USER_DATA_DIR="${TIKTOK_USER_DATA_DIR:-$PROJECT_ROOT/.tiktok-user-data}"

  echo "   用户数据目录: $USER_DATA_DIR"
  if [[ -n "$TIKTOK_USER_DATA_DIR" ]]; then
    echo "   ✅ 使用环境变量指定的用户数据目录（应包含 TikTok 登录状态）"
    echo "   环境变量值: $TIKTOK_USER_DATA_DIR"
    
    # 检查目录是否存在
    if [[ -d "$USER_DATA_DIR" ]]; then
      echo "   ✅ 目录存在"
      
      # 检查是否包含 Chrome 配置文件
      if [[ -d "$USER_DATA_DIR/Default" ]] || [[ -f "$USER_DATA_DIR/Local State" ]]; then
        echo "   ✅ 目录包含 Chrome 配置文件"
      else
        echo "   ⚠️  警告：目录可能不是有效的 Chrome 用户数据目录"
        echo "   提示：Chrome 用户数据目录应包含 'Default' 子目录或 'Local State' 文件"
      fi
    else
      echo "   ❌ 错误：目录不存在: $USER_DATA_DIR"
      echo "   请检查环境变量 TIKTOK_USER_DATA_DIR 的值是否正确"
      exit 1
    fi
  else
    echo "   ⚠️  使用默认目录，如需使用已登录的目录，请设置 TIKTOK_USER_DATA_DIR 环境变量"
    echo "   提示：可以在 .env 文件中设置，或使用 export TIKTOK_USER_DATA_DIR=/path/to/profile"
  fi

  # 启动 Chrome（后台运行）
  "$CHROME_PATH" \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$USER_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    >/dev/null 2>&1 &

  CHROME_PID=$!
  echo "✅ Chrome 已启动（PID: $CHROME_PID）"

  # 等待 Chrome 启动并开启 CDP 端口
  echo "   等待 Chrome 就绪..."
  for i in {1..30}; do
    if check_port; then
      echo "✅ Chrome 已就绪（CDP 端口已开启）"
      return 0
    fi
    sleep 1
  done

  echo "❌ Chrome 启动超时（30秒内 CDP 端口未开启）"
  kill $CHROME_PID 2>/dev/null || true
  exit 1
}

# 函数：清理 Chrome 进程
cleanup_chrome() {
  if [[ -n "$CHROME_PID" ]]; then
    echo ""
    echo "=========================================="
    read -p "是否关闭 Chrome？(y/N): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      echo "正在关闭 Chrome（PID: $CHROME_PID）..."
      kill $CHROME_PID 2>/dev/null || true
      echo "✅ Chrome 已关闭"
    else
      echo "Chrome 将继续运行，你可以手动关闭"
      echo "CDP 地址: $CDP_ENDPOINT"
    fi
  fi
}

# 设置退出时清理
trap cleanup_chrome EXIT

# 检查 CDP 端口是否已开启
if check_port; then
  echo "[1/3] ✅ Chrome 已在运行（CDP 端口已开启）"
  CHROME_PID=""  # 不管理已存在的 Chrome
else
  start_chrome
fi

# 等待一下，确保连接稳定
sleep 2

# 运行测试脚本
echo ""
echo "[2/3] 正在运行测试脚本..."
echo "=========================================="
echo ""

cd "$PROJECT_ROOT"
node scripts/test-tiktok-video-fingerprint.js --connect $USE_CHROME

echo ""
echo "[3/3] ✅ 测试完成"


# 一键测试脚本：自动启动 Chrome（远程调试）并运行测试
# 使用方法：
#   bash scripts/test-with-connect.sh
#   或
#   bash scripts/test-with-connect.sh --chrome  # 使用系统 Chrome
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 加载 .env 文件（如果存在）
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  echo "[env] 正在加载 .env 文件..."
  # 使用 export 导出 .env 中的变量（忽略注释和空行）
  set -a
  source <(grep -v '^#' "$PROJECT_ROOT/.env" | grep -v '^$' | sed 's/^/export /')
  set +a
  echo "[env] ✅ .env 文件已加载"
fi

CDP_PORT="${CDP_PORT:-9222}"
CDP_ENDPOINT="http://localhost:$CDP_PORT"

# 检测参数
USE_CHROME=""
if [[ "$*" == *"--chrome"* ]]; then
  USE_CHROME="--chrome"
fi

echo "=========================================="
echo "一键测试：自动启动 Chrome 并连接测试"
echo "=========================================="
echo "CDP 端口: $CDP_PORT"
echo ""

# 函数：检查端口是否被占用
check_port() {
  if lsof -Pi :$CDP_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    return 0  # 端口已被占用
  else
    return 1  # 端口未被占用
  fi
}

# 函数：启动 Chrome（后台运行）
start_chrome() {
  echo "[1/3] 正在启动 Chrome（远程调试模式）..."
  
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

  # 使用环境变量中的用户数据目录（如果已设置），否则使用默认目录
  # 重要：如果环境变量中指定了已登录的用户数据目录，Chrome 会自动使用该目录中的登录状态
  USER_DATA_DIR="${TIKTOK_USER_DATA_DIR:-$PROJECT_ROOT/.tiktok-user-data}"

  echo "   用户数据目录: $USER_DATA_DIR"
  if [[ -n "$TIKTOK_USER_DATA_DIR" ]]; then
    echo "   ✅ 使用环境变量指定的用户数据目录（应包含 TikTok 登录状态）"
    echo "   环境变量值: $TIKTOK_USER_DATA_DIR"
    
    # 检查目录是否存在
    if [[ -d "$USER_DATA_DIR" ]]; then
      echo "   ✅ 目录存在"
      
      # 检查是否包含 Chrome 配置文件
      if [[ -d "$USER_DATA_DIR/Default" ]] || [[ -f "$USER_DATA_DIR/Local State" ]]; then
        echo "   ✅ 目录包含 Chrome 配置文件"
      else
        echo "   ⚠️  警告：目录可能不是有效的 Chrome 用户数据目录"
        echo "   提示：Chrome 用户数据目录应包含 'Default' 子目录或 'Local State' 文件"
      fi
    else
      echo "   ❌ 错误：目录不存在: $USER_DATA_DIR"
      echo "   请检查环境变量 TIKTOK_USER_DATA_DIR 的值是否正确"
      exit 1
    fi
  else
    echo "   ⚠️  使用默认目录，如需使用已登录的目录，请设置 TIKTOK_USER_DATA_DIR 环境变量"
    echo "   提示：可以在 .env 文件中设置，或使用 export TIKTOK_USER_DATA_DIR=/path/to/profile"
  fi

  # 启动 Chrome（后台运行）
  "$CHROME_PATH" \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$USER_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    >/dev/null 2>&1 &

  CHROME_PID=$!
  echo "✅ Chrome 已启动（PID: $CHROME_PID）"

  # 等待 Chrome 启动并开启 CDP 端口
  echo "   等待 Chrome 就绪..."
  for i in {1..30}; do
    if check_port; then
      echo "✅ Chrome 已就绪（CDP 端口已开启）"
      return 0
    fi
    sleep 1
  done

  echo "❌ Chrome 启动超时（30秒内 CDP 端口未开启）"
  kill $CHROME_PID 2>/dev/null || true
  exit 1
}

# 函数：清理 Chrome 进程
cleanup_chrome() {
  if [[ -n "$CHROME_PID" ]]; then
    echo ""
    echo "=========================================="
    read -p "是否关闭 Chrome？(y/N): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      echo "正在关闭 Chrome（PID: $CHROME_PID）..."
      kill $CHROME_PID 2>/dev/null || true
      echo "✅ Chrome 已关闭"
    else
      echo "Chrome 将继续运行，你可以手动关闭"
      echo "CDP 地址: $CDP_ENDPOINT"
    fi
  fi
}

# 设置退出时清理
trap cleanup_chrome EXIT

# 检查 CDP 端口是否已开启
if check_port; then
  echo "[1/3] ✅ Chrome 已在运行（CDP 端口已开启）"
  CHROME_PID=""  # 不管理已存在的 Chrome
else
  start_chrome
fi

# 等待一下，确保连接稳定
sleep 2

# 运行测试脚本
echo ""
echo "[2/3] 正在运行测试脚本..."
echo "=========================================="
echo ""

cd "$PROJECT_ROOT"
node scripts/test-tiktok-video-fingerprint.js --connect $USE_CHROME

echo ""
echo "[3/3] ✅ 测试完成"

