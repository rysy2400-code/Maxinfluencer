#!/usr/bin/env bash
# 部署 web/worker 到指定 SHA；crawler 按平台注册表中的 active release 部署。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEY="${CRAWLER_SSH_KEY_PATH:-$HOME/.ssh/maxin_web_vm}"
USER="${CRAWLER_SSH_USER:-administrator}"
PORT="${CRAWLER_SSH_PORT:-22}"

TARGET_SHA="${1:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"

WEB_HOST="152.32.185.48"
WORKER_HOST="152.32.216.107"

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY" >&2
  exit 1
fi

ssh_cmd() {
  ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=25 -o BatchMode=yes "$@"
}

git_sync_ps1="\$ErrorActionPreference='Stop'; \$root='C:\\maxinfluencer'; \$git='C:\\Program Files\\Git\\cmd\\git.exe'; if (-not (Test-Path \$git)) { \$git='git' }; & \$git -C \$root fetch origin --prune; & \$git -C \$root checkout main; & \$git -C \$root reset --hard ${TARGET_SHA}; & \$git -C \$root clean -fd -e .chrome-cdp-9222 -e .chrome-cdp-9223"

deploy_web() {
  local host="$1"
  local log="/tmp/deploy-web-${host}.log"
  echo "[deploy-web] $host sha=$TARGET_SHA"
  if ssh_cmd "${USER}@${host}" \
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"${git_sync_ps1}; powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path \$root 'deploy-web.ps1')\"" \
    >"$log" 2>&1; then
    echo "[deploy-web] OK $host"
    return 0
  fi
  echo "[deploy-web] FAIL $host" >&2
  tail -20 "$log" >&2 || true
  return 1
}

deploy_worker() {
  local host="$1"
  local log="/tmp/deploy-worker-${host}.log"
  echo "[deploy-worker] $host sha=$TARGET_SHA"
  if ssh_cmd "${USER}@${host}" \
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"${git_sync_ps1}; powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path \$root 'deploy-worker.ps1'); powershell -NoProfile -ExecutionPolicy Bypass -Command \\\"Set-Location C:\\\\maxinfluencer; node --experimental-default-type=module scripts/create-campaign-keyword-signals-table.js\\\"\"" \
    >"$log" 2>&1; then
    echo "[deploy-worker] OK $host"
    return 0
  fi
  echo "[deploy-worker] FAIL $host" >&2
  tail -20 "$log" >&2 || true
  return 1
}

fail=0
pids=()
names=()

deploy_web "$WEB_HOST" & pids+=($!); names+=("web:$WEB_HOST")
deploy_worker "$WORKER_HOST" & pids+=($!); names+=("worker:$WORKER_HOST")

for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    echo "[deploy] failed: ${names[$i]}" >&2
    fail=1
  fi
done

if [[ "$fail" -eq 0 ]]; then
  for role in youtube tiktok instagram; do
    (unset TARGET_SHA; "$SCRIPT_DIR/deploy-platform-crawlers.sh" "$role") &
    pids+=($!)
    names+=("crawler-role:$role")
  done
  for i in 0 1 2; do
    idx=$((${#pids[@]} - 3 + i))
    if ! wait "${pids[$idx]}"; then
      echo "[deploy] failed: ${names[$idx]}" >&2
      fail=1
    fi
  done
fi

if [[ "$fail" -ne 0 ]]; then
  echo "[deploy] completed with failures at sha=$TARGET_SHA" >&2
  exit 1
fi

echo "[deploy] web/worker OK at sha=$TARGET_SHA; crawler roles OK at registry releases"
