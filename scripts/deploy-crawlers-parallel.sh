#!/usr/bin/env bash
# 并行 SSH 部署 5 台爬虫机（git pull + deploy-crawler.ps1）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEY="${CRAWLER_SSH_KEY_PATH:-$HOME/.ssh/maxin_web_vm}"
USER="${CRAWLER_SSH_USER:-administrator}"
PORT="${CRAWLER_SSH_PORT:-22}"

HOSTS=(
  "152.32.252.45"
  "36.255.223.141"
  "152.32.192.65"
  "152.32.211.203"
  "107.150.119.142"
)

TARGET_SHA="${1:-}"
if [[ -z "$TARGET_SHA" ]]; then
  git -C "$REPO_ROOT" fetch origin main 2>/dev/null || true
  TARGET_SHA="$(git -C "$REPO_ROOT" rev-parse origin/main 2>/dev/null || git -C "$REPO_ROOT" rev-parse HEAD)"
fi

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY" >&2
  exit 1
fi

deploy_one() {
  local host="$1"
  local log="/tmp/deploy-crawler-${host}.log"
  echo "[deploy] starting $host (sha=$TARGET_SHA)"
  if ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o ConnectTimeout=20 -o BatchMode=yes \
    "${USER}@${host}" \
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"\$ErrorActionPreference='Stop'; \$root='C:\\maxinfluencer'; \$git='C:\\Program Files\\Git\\cmd\\git.exe'; if (-not (Test-Path \$git)) { \$git='git' }; & \$git -C \$root fetch origin --prune; & \$git -C \$root checkout main; & \$git -C \$root reset --hard ${TARGET_SHA}; & \$git -C \$root clean -fd -e .chrome-cdp-9222 -e .chrome-cdp-9223; powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path \$root 'deploy-crawler.ps1'); \$ok9222=\$false; try { \$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 8; \$ok9222=(\$r.StatusCode -ge 200 -and \$r.StatusCode -lt 400) } catch {}; \$wc=(Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'node.exe' -and \$_.CommandLine -match 'worker-influencer-search.js' } | Measure-Object).Count; Write-Host ('health cdp9222='+\$ok9222+' worker='+\$wc); if (-not \$ok9222) { throw 'CDP failed' }; if (\$wc -lt 1) { throw 'Worker missing' }\"" \
    >"$log" 2>&1; then
    echo "[deploy] OK $host"
    return 0
  fi
  echo "[deploy] FAIL $host — tail $log:" >&2
  tail -30 "$log" >&2 || true
  return 1
}

export KEY USER PORT TARGET_SHA
fail=0
pids=()
for host in "${HOSTS[@]}"; do
  deploy_one "$host" &
  pids+=($!)
done
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then fail=1; fi
done

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "[deploy] all ${#HOSTS[@]} crawlers deployed at ${TARGET_SHA}"
