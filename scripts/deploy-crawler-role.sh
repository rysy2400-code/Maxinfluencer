#!/usr/bin/env bash
# Deploy crawler VMs for one dedicated platform role.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <youtube|tiktok|instagram> <host> [host...]" >&2
  exit 2
fi

ROLE="$1"
shift
case "$ROLE" in
  youtube|tiktok|instagram) ;;
  *) echo "Invalid role: $ROLE" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEY="${CRAWLER_SSH_KEY_PATH:-$HOME/.ssh/maxin_web_vm}"
USER="${CRAWLER_SSH_USER:-administrator}"
PORT="${CRAWLER_SSH_PORT:-22}"
TARGET_SHA="${TARGET_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY" >&2
  exit 1
fi

build_remote_ps() {
  local role="$1"
  local sha="$2"
  cat <<PS
\$ErrorActionPreference = "Stop"
\$role = "$role"
\$targetSha = "$sha"
\$root = "C:\\maxinfluencer"
\$git = "C:\\Program Files\\Git\\cmd\\git.exe"
if (-not (Test-Path \$git)) { \$git = "git" }
if (-not (Test-Path \$root)) { throw "Deploy root not found: \$root" }

\$env:CRAWLER_PLATFORM_ROLE = \$role
& \$git -C \$root fetch origin --prune
& \$git -C \$root checkout main
& \$git -C \$root reset --hard \$targetSha
& \$git -C \$root clean -fd -e .chrome-cdp-9222 -e .chrome-cdp-9223
\$deploy = Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path \$root "deploy-crawler.ps1")
) -NoNewWindow -Wait -PassThru
if (\$deploy.ExitCode -ne 0) {
  throw ("deploy-crawler.ps1 failed with exit code " + \$deploy.ExitCode)
}
Start-Sleep -Seconds 45

function Test-Cdp([int]\$Port) {
  try {
    \$r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:\$Port/json/version" -TimeoutSec 8
    return (\$r.StatusCode -ge 200 -and \$r.StatusCode -lt 400)
  } catch {
    return \$false
  }
}

function Get-CdpPages([int]\$Port) {
  try {
    return @(Invoke-RestMethod -Uri "http://127.0.0.1:\$Port/json/list" -TimeoutSec 8)
  } catch {
    return @()
  }
}

\$ok9222 = Test-Cdp 9222
\$ok9223 = Test-Cdp 9223
\$guardCrawlerPath = Join-Path \$root "scripts\\guard-crawler-search.ps1"
if (-not (Test-Path \$guardCrawlerPath)) { throw "guard-crawler-search.ps1 missing" }
\$guardCrawler = Get-Content -LiteralPath \$guardCrawlerPath -Raw
\$platformNeedle = '\$env:SEARCH_WORKER_PLATFORMS = "' + \$role + '"'
\$platformOk = \$guardCrawler.Contains(\$platformNeedle)
\$workerCount = @(Get-CimInstance Win32_Process | Where-Object {
  \$_.Name -eq "node.exe" -and \$_.CommandLine -match "worker-influencer-search\\.js"
}).Count
\$shaShort = (& \$git -C \$root rev-parse --short HEAD)

if (-not \$platformOk) {
  throw "SEARCH_WORKER_PLATFORMS is not pinned to \$role in guard-crawler-search.ps1"
}
if (\$workerCount -lt 1) {
  throw "worker-influencer-search.js is not running"
}

if (\$role -eq "youtube") {
  if (-not \$ok9222) { throw "YouTube role requires CDP 9222" }
  if (\$ok9223) { throw "YouTube role must not expose CDP 9223" }
  foreach (\$needle in @(
    '\$env:YT_LITE_TAB_POOL_SIZE = "3"',
    '\$env:LITE_YT_ENRICH_CONCURRENCY = "150"',
    '\$env:LITE_YT_ENRICH_CONCURRENCY_MAX = "150"',
    '\$env:YT_LITE_DISABLE_EVALUATE_LOCK = "1"'
  )) {
    if (-not \$guardCrawler.Contains(\$needle)) { throw "Missing YouTube guard env: \$needle" }
  }
  \$pages = Get-CdpPages 9222
  \$ytTabs = @(\$pages | Where-Object { \$_.type -eq "page" -and \$_.url -match "youtube\\.com" }).Count
  \$wrongTabs = @(\$pages | Where-Object { \$_.type -eq "page" -and \$_.url -match "(instagram|tiktok)\\.com" }).Count
  if (\$ytTabs -lt 3) { throw "YouTube role expected at least 3 YouTube tabs, got \$ytTabs" }
  if (\$wrongTabs -gt 0) { throw "YouTube role has Instagram/TikTok tabs on 9222" }
  Write-Host "health role=\$role sha=\$shaShort cdp9222=\$ok9222 cdp9223=\$ok9223 worker=\$workerCount ytTabs=\$ytTabs wrongTabs=\$wrongTabs concurrency=3x50"
} elseif (\$role -eq "tiktok") {
  if (-not \$ok9222) { throw "TikTok role requires CDP 9222" }
  if (-not \$ok9223) { throw "TikTok role requires CDP 9223 for lite enrich" }
  Write-Host "health role=\$role sha=\$shaShort cdp9222=\$ok9222 cdp9223=\$ok9223 worker=\$workerCount platforms=tiktok"
} elseif (\$role -eq "instagram") {
  if (-not \$ok9222) { throw "Instagram role requires CDP 9222" }
  if (\$ok9223) { throw "Instagram role must not expose CDP 9223" }
  \$pages = Get-CdpPages 9222
  \$igTabs = @(\$pages | Where-Object { \$_.type -eq "page" -and \$_.url -match "instagram\\.com" }).Count
  Write-Host "health role=\$role sha=\$shaShort cdp9222=\$ok9222 cdp9223=\$ok9223 worker=\$workerCount igTabs=\$igTabs platforms=instagram"
}
PS
}

deploy_one() {
  local host="$1"
  local log="/tmp/deploy-${ROLE}-crawler-${host}.log"
  echo "[deploy-$ROLE] starting $host sha=$TARGET_SHA"
  if build_remote_ps "$ROLE" "$TARGET_SHA" | ssh -i "$KEY" -p "$PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=25 -o BatchMode=yes \
    "${USER}@${host}" \
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command -" \
    >"$log" 2>&1; then
    echo "[deploy-$ROLE] OK $host"
    grep -E "health role=|\\[deploy-crawler\\] role=|SEARCH_WORKER_PLATFORMS=" "$log" | tail -5 || true
    return 0
  fi
  echo "[deploy-$ROLE] FAIL $host - tail $log:" >&2
  tail -40 "$log" >&2 || true
  return 1
}

fail=0
pids=()
hosts=("$@")
for host in "${hosts[@]}"; do
  deploy_one "$host" &
  pids+=($!)
done
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then fail=1; fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "[deploy-$ROLE] completed with failures at sha=$TARGET_SHA" >&2
  exit 1
fi

echo "[deploy-$ROLE] all ${#hosts[@]} hosts OK at sha=$TARGET_SHA"
