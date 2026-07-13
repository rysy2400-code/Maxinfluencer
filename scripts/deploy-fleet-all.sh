#!/usr/bin/env bash
# 部署 web + worker + 全部 14 台爬虫机到指定 SHA
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEY="${CRAWLER_SSH_KEY_PATH:-$HOME/.ssh/maxin_web_vm}"
USER="${CRAWLER_SSH_USER:-administrator}"
PORT="${CRAWLER_SSH_PORT:-22}"

TARGET_SHA="${1:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"

WEB_HOST="152.32.185.48"
WORKER_HOST="152.32.216.107"

CRAWLER_HOSTS=(
  "36.255.223.141"
  "36.255.223.151"
  "103.218.240.130"
  "107.150.119.142"
  "128.1.132.49"
  "128.1.132.174"
  "152.32.174.193"
  "152.32.174.208"
  "152.32.187.186"
  "152.32.187.244"
  "152.32.188.48"
  "152.32.192.65"
  "152.32.211.203"
  "152.32.252.45"
)

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY" >&2
  exit 1
fi

ssh_cmd() {
  ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=25 -o BatchMode=yes "$@"
}

git_sync_ps1="\$ErrorActionPreference='Stop'; \$root='C:\\maxinfluencer'; \$git='C:\\Program Files\\Git\\cmd\\git.exe'; if (-not (Test-Path \$git)) { \$git='git' }; & \$git -C \$root fetch origin --prune; & \$git -C \$root checkout main; & \$git -C \$root reset --hard ${TARGET_SHA}; & \$git -C \$root clean -fd -e .chrome-cdp-9222 -e .chrome-cdp-9223"

# worker>=1；CDP 9222 或 9223 任一可用即通过（与 deploy-crawler.ps1 一致）
crawler_health_ps1="\$ok9222=\$false; \$ok9223=\$false; try { \$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 8; \$ok9222=(\$r.StatusCode -ge 200 -and \$r.StatusCode -lt 400) } catch {}; try { \$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9223/json/version' -TimeoutSec 8; \$ok9223=(\$r.StatusCode -ge 200 -and \$r.StatusCode -lt 400) } catch {}; \$wc=(Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'node.exe' -and \$_.CommandLine -match 'worker-influencer-search.js' } | Measure-Object).Count; \$sha=( & \$git -C \$root rev-parse --short HEAD ); Write-Host ('health sha='+\$sha+' cdp9222='+\$ok9222+' cdp9223='+\$ok9223+' worker='+\$wc); if (\$wc -lt 1) { throw 'Worker missing' }"

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

deploy_crawler() {
  local host="$1"
  local log="/tmp/deploy-crawler-${host}.log"
  echo "[deploy-crawler] $host sha=$TARGET_SHA"
  if ssh_cmd "${USER}@${host}" \
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"${git_sync_ps1}; powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path \$root 'deploy-crawler.ps1'); ${crawler_health_ps1}\"" \
    >"$log" 2>&1; then
    echo "[deploy-crawler] OK $host"
    return 0
  fi
  echo "[deploy-crawler] FAIL $host" >&2
  tail -25 "$log" >&2 || true
  return 1
}

fail=0
pids=()
names=()

deploy_web "$WEB_HOST" & pids+=($!); names+=("web:$WEB_HOST")
deploy_worker "$WORKER_HOST" & pids+=($!); names+=("worker:$WORKER_HOST")
for host in "${CRAWLER_HOSTS[@]}"; do
  deploy_crawler "$host" & pids+=($!); names+=("crawler:$host")
done

for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    echo "[deploy] failed: ${names[$i]}" >&2
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "[deploy] completed with failures at sha=$TARGET_SHA" >&2
  exit 1
fi

echo "[deploy] all targets OK at sha=$TARGET_SHA"
