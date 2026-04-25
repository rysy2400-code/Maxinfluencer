#!/usr/bin/env bash
# 在「能访问云服务器」的本机执行：配置 SSH 公钥免密，并部署 worker（PM2 maxin-worker）。
#
# 用法：
#   export SSH_PASSWORD='首次连接用的密码'   # 仅当尚未配置免密时需要
#   ./scripts/setup-ssh-and-deploy-worker-vm.sh
#
# 可选环境变量：
#   SSH_HOST   默认 152.32.216.107
#   SSH_USER   默认 administrator
#   SSH_KEY    默认 ~/.ssh/maxin_web_vm（私钥；公钥为同路径 .pub）
#
# 建议在 ~/.ssh/config 中加入（免密后即可 ssh maxin-worker-vm）：
#   Host maxin-worker-vm
#     HostName 152.32.216.107
#     User administrator
#     IdentityFile ~/.ssh/maxin_web_vm

set -euo pipefail

SSH_HOST="${SSH_HOST:-152.32.216.107}"
SSH_USER="${SSH_USER:-administrator}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/maxin_web_vm}"
SSH_PUB="${SSH_KEY}.pub"
REMOTE_PS1='C:\maxinfluencer\deploy-worker.ps1'

if [[ ! -f "$SSH_KEY" ]] || [[ ! -f "$SSH_PUB" ]]; then
  echo "缺少密钥: $SSH_KEY 与 $SSH_PUB，请先生成或设置 SSH_KEY" >&2
  exit 1
fi

chmod 600 "$SSH_KEY" 2>/dev/null || true

can_key_login() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
    -i "$SSH_KEY" "${SSH_USER}@${SSH_HOST}" "exit" 2>/dev/null
}

if can_key_login; then
  echo "[ssh] 已可用密钥登录，跳过 ssh-copy-id。"
else
  if [[ -z "${SSH_PASSWORD:-}" ]]; then
    echo "无法用密钥登录。请设置环境变量 SSH_PASSWORD 后重试以完成首次 ssh-copy-id。" >&2
    exit 1
  fi
  if ! command -v expect >/dev/null 2>&1; then
    echo "需要 expect（macOS 自带 /usr/bin/expect）。" >&2
    exit 1
  fi
  echo "[ssh] 正在安装公钥到 ${SSH_USER}@${SSH_HOST} …"
  PASS="$SSH_PASSWORD"
  expect <<EOF
set timeout 120
spawn ssh-copy-id -i "$SSH_PUB" -o StrictHostKeyChecking=accept-new ${SSH_USER}@${SSH_HOST}
expect {
  "yes/no" { send "yes\r"; exp_continue }
  "password:" { send "${PASS}\r" }
  eof
}
EOF
  if ! can_key_login; then
    echo "ssh-copy-id 后仍无法密钥登录，请检查服务端 OpenSSH 与 authorized_keys 权限。" >&2
    exit 1
  fi
  echo "[ssh] 免密登录已就绪。"
fi

echo "[deploy] 在远端执行 deploy-worker.ps1 …"
ssh -o ConnectTimeout=60 -i "$SSH_KEY" "${SSH_USER}@${SSH_HOST}" \
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$REMOTE_PS1"

echo "[deploy] 完成。"
