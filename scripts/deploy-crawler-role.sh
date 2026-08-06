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

REGISTRY_OUTPUT="$(node "$SCRIPT_DIR/list-crawler-deploy-targets.mjs" "$ROLE")"
REGISTRY_RELEASE="$(printf '%s\n' "$REGISTRY_OUTPUT" | sed -n 's/^CRAWLER_RELEASE=//p' | head -1)"
if [[ ! "$REGISTRY_RELEASE" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "No active production release returned for $ROLE" >&2
  exit 1
fi

if [[ -n "${TARGET_SHA:-}" ]]; then
  if [[ ! "$TARGET_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "Invalid TARGET_SHA: $TARGET_SHA" >&2
    exit 2
  fi
  target_sha_lc="$(printf '%s' "$TARGET_SHA" | tr '[:upper:]' '[:lower:]')"
  registry_release_lc="$(printf '%s' "$REGISTRY_RELEASE" | tr '[:upper:]' '[:lower:]')"
  if [[ "$target_sha_lc" != "$registry_release_lc" && "${ALLOW_NON_REGISTRY_TARGET_SHA:-}" != "1" ]]; then
    echo "Refusing to deploy non-active $ROLE release: TARGET_SHA=$TARGET_SHA active=$REGISTRY_RELEASE" >&2
    echo "Set ALLOW_NON_REGISTRY_TARGET_SHA=1 only for an explicit emergency rollback/test." >&2
    exit 1
  fi
else
  TARGET_SHA="$REGISTRY_RELEASE"
fi

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY" >&2
  exit 1
fi

build_remote_ps() {
  local role="$1"
  local sha="$2"
  local host="$3"
  local machine_key="$4"
  cat <<PS
\$ErrorActionPreference = "Stop"
\$role = "$role"
\$targetSha = "$sha"
\$root = "C:\\maxinfluencer"
\$git = "C:\\Program Files\\Git\\cmd\\git.exe"
if (-not (Test-Path \$git)) { \$git = "git" }
if (-not (Test-Path \$root)) { throw "Deploy root not found: \$root" }

\$env:CRAWLER_PLATFORM_ROLE = \$role
\$env:CRAWLER_MACHINE_KEY = "$machine_key"
\$env:CRAWLER_DEPLOY_SHA = \$targetSha
& \$git -C \$root fetch origin --prune
& \$git -C \$root checkout --detach --force \$targetSha
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
    '\$env:YT_LITE_DISABLE_EVALUATE_LOCK = "1"',
    '\$env:YT_LITE_REQUIRE_EMAIL_FOR_ANALYSIS = "1"'
  )) {
    if (-not \$guardCrawler.Contains(\$needle)) { throw "Missing YouTube guard env: \$needle" }
  }
  \$gateModule = ([System.Uri](Join-Path \$root "lib\\tools\\influencer-functions\\youtube\\extract-youtube-channel-lite.js")).AbsoluteUri
  & node --experimental-default-type=module -e "import(process.argv[1]).then(m=>{if(!m.isYoutubeLiteEmailGateEnabled(undefined)||m.isYoutubeLiteEmailGateEnabled('0'))process.exit(1)})" \$gateModule
  if (\$LASTEXITCODE -ne 0) { throw "YouTube email gate fail-closed self-check failed" }
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
  if (-not \$ok9223) { throw "Instagram role requires CDP 9223 for lite enrich canary" }
  \$pages = Get-CdpPages 9222
  \$pages9223 = Get-CdpPages 9223
  \$igTabs = @(\$pages | Where-Object { \$_.type -eq "page" -and \$_.url -match "instagram\\.com" }).Count
  \$igTabs9223 = @(\$pages9223 | Where-Object { \$_.type -eq "page" -and \$_.url -match "instagram\\.com" }).Count
  foreach (\$needle in @(
    '\$env:SEARCH_WORKER_SLOTS = "1"',
    '\$env:IG_LITE_ENRICH_CDP_ENDPOINTS = "http://127.0.0.1:9222,http://127.0.0.1:9223"',
    '\$env:IG_LITE_TAB_POOL_SIZE = "2"',
    '\$env:LITE_IG_ENRICH_CONCURRENCY = "2"',
    '\$env:LITE_IG_ENRICH_CONCURRENCY_MAX = "2"',
    '\$env:LITE_IG_ENRICH_HARD_MAX = "2"',
    '\$env:IG_LITE_REQUIRE_EMAIL_FOR_ANALYSIS = "1"',
    '\$env:CDP_RPC_TIMEOUTS_BEFORE_RESTART = "3"',
    '\$env:IG_LITE_EVALUATE_CONCURRENCY = "1"',
    '\$env:IG_REQUEST_DELAY_MIN_MS = "1000"',
    '\$env:IG_REQUEST_DELAY_MAX_MS = "3000"',
    '\$env:IG_ABOUT_CONCURRENCY = "1"',
    '\$env:IG_API_ONLY_NO_NAVIGATION = "0"',
    '\$env:IG_LITE_SKIP_RELAY_WARMUP = "0"',
    '\$env:IG_ALLOW_REELS_SCROLL_FALLBACK = "0"'
  )) {
    if (-not \$guardCrawler.Contains(\$needle)) { throw "Missing Instagram guard env: \$needle" }
  }
  if (\$igTabs -ne 1) { throw "Instagram role expected exactly 1 Instagram tab, got \$igTabs" }
  if (\$igTabs9223 -lt 1) { throw "Instagram role expected at least 1 Instagram tab on 9223, got \$igTabs9223" }
  Write-Host "health role=\$role sha=\$shaShort cdp9222=\$ok9222 cdp9223=\$ok9223 worker=\$workerCount igTabs9222=\$igTabs igTabs9223=\$igTabs9223 platforms=instagram taskSlots=1 enrich=2 endpoints=9222,9223 emailGate=1 evaluate=1 about=1 requestDelay=1000-3000ms"
}
PS
}

deploy_one() {
  local spec="$1"
  local host machine_key
  if [[ "$spec" == *=* ]]; then
    machine_key="${spec%%=*}"
    host="${spec#*=}"
  else
    host="$spec"
    machine_key="crawler-${host//./-}"
  fi
  if [[ ! "$host" =~ ^[a-zA-Z0-9.-]+$ || ! "$machine_key" =~ ^[a-zA-Z0-9.-]+$ ]]; then
    echo "Invalid crawler target: $spec" >&2
    return 2
  fi
  local log="/tmp/deploy-${ROLE}-crawler-${host}.log"
  local tmp_script
  tmp_script="$(mktemp "/tmp/deploy-${ROLE}-${host}.XXXXXX")"
  build_remote_ps "$ROLE" "$TARGET_SHA" "$host" "$machine_key" >"$tmp_script"
  echo "[deploy-$ROLE] starting $host sha=$TARGET_SHA"
  if ssh -i "$KEY" -p "$PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=25 -o BatchMode=yes \
      "${USER}@${host}" \
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"\$content = [Console]::In.ReadToEnd(); Set-Content -LiteralPath 'C:\\maxinfluencer\\scripts\\deploy-role-run.ps1' -Value \$content -Encoding UTF8\"" \
      <"$tmp_script" >"$log" 2>&1 &&
    ssh -i "$KEY" -p "$PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=25 -o BatchMode=yes \
      "${USER}@${host}" \
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\maxinfluencer\\scripts\\deploy-role-run.ps1" \
      >>"$log" 2>&1; then
    echo "[deploy-$ROLE] OK $host"
    grep -E "health role=|\\[deploy-crawler\\] role=|SEARCH_WORKER_PLATFORMS=" "$log" | tail -5 || true
    rm -f "$tmp_script"
    return 0
  fi
  rm -f "$tmp_script"
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
