param(
  [string]$Keyword = "AI design tool demo",
  [int]$CountryBatch = 10,
  [int]$EnrichBatch = 10
)

$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
Set-Location $Root

function Stop-SearchWorker {
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search|probe-tiktok" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  schtasks.exe /End /TN "maxin-guard-crawler-search" 2>$null | Out-Null
  Start-Sleep -Seconds 2
}

function Trim-CdpPort {
  param([int]$Port, [int]$Keep = 1)
  $trimScript = Join-Path $Root "scripts\trim-cdp-tiktok-tabs.ps1"
  if (Test-Path $trimScript) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $trimScript -Port $Port -KeepMax $Keep
  }
}

function Test-CdpPort {
  param([int]$Port)
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
    return $r.StatusCode -ge 200 -and $r.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Restart-Chrome9222 {
  $signal = Join-Path $Root "signals\restart-chrome-9222.flag"
  New-Item -ItemType File -Path $signal -Force | Out-Null
  Start-Sleep -Seconds 18
}

function Set-LiteEnv {
  $env:SCRAPER_MODE = "lite"
  $env:CDP_ENDPOINT = "http://127.0.0.1:9222"
  $env:CDP_ENDPOINT_ENRICH = "http://127.0.0.1:9223"
  $env:TT_LITE_ALLOW_NAV = "0"
  $env:TT_LITE_ENRICH_ALLOW_NAV = "1"
  $env:TT_LITE_COUNTRY_DISABLE_NAV = "1"
  $env:TT_LITE_COUNTRY_VIDEO_INFO = "0"
  $env:TT_LITE_COUNTRY_STUB_DOCUMENT = "0"
  $env:TT_LITE_TAB_POOL_SIZE = "1"
$env:NODE_OPTIONS = "--max-old-space-size=4096"
  $env:TT_LITE_COUNTRY_HTML_FIRST = "1"
  $env:TT_LITE_COUNTRY_CONCURRENCY = "10"
  $env:TT_LITE_COUNTRY_API_ONLY = "1"
  $env:TT_LITE_COUNTRY_PROBE_DELAY_MS = "800"
  $env:TT_LITE_COUNTRY_VIDEO_INFO_CHAIN = "1"
  $env:TT_LITE_UNIVERSAL_MAX_WAIT_MS = "18000"
  $env:TT_LITE_MAX_VIDEOS = "50"
  $env:LITE_TT_ENRICH_CONCURRENCY = "10"
  $env:COUNTRY_BATCH_STOP_ON_ZERO = "0"
  $env:ENRICH_BATCH_STOP_ON_ZERO = "0"
  $env:HTTPS_PROXY = "http://127.0.0.1:7897"
  $env:HTTP_PROXY = "http://127.0.0.1:7897"
}

Stop-SearchWorker
Set-LiteEnv

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\run-crawler65-reset-chrome.ps1") -SkipWorkerStop

Write-Host "================================================================"
Write-Host "[crawler65-test] keyword=`"$Keyword`" country=$CountryBatch@c10 enrich=$EnrichBatch@c10"
Write-Host "  search+country=9222 api-only  enrich+llm=9223 api-only"
Write-Host "================================================================"

if (-not (Test-CdpPort 9222)) { Write-Host "[FAIL] CDP 9222 not ready"; exit 2 }
if (-not (Test-CdpPort 9223)) { Write-Host "[FAIL] CDP 9223 not ready"; exit 2 }

Trim-CdpPort -Port 9222 -Keep 1
Trim-CdpPort -Port 9223 -Keep 1
Start-Sleep -Seconds 2

$searchExit = 1
$countryExit = 1
$enrichExit = 1

Write-Host ""
Write-Host "=== Phase 1: Search API only (9222) ==="
$sw1 = [Diagnostics.Stopwatch]::StartNew()
& node --experimental-default-type=module scripts/probe-tiktok-search-api-only.mjs $Keyword
$searchExit = $LASTEXITCODE
$sw1.Stop()
Write-Host "[phase1] search_exit=$searchExit elapsed_sec=$([int]$sw1.Elapsed.TotalSeconds)"

if ($searchExit -ne 0) {
  Write-Host "[phase1] retry after Chrome 9222 restart..."
  Restart-Chrome9222
  Trim-CdpPort -Port 9222 -Keep 1
  $sw1b = [Diagnostics.Stopwatch]::StartNew()
  & node --experimental-default-type=module scripts/probe-tiktok-search-api-only.mjs $Keyword
  $searchExit = $LASTEXITCODE
  $sw1b.Stop()
  Write-Host "[phase1-retry] search_exit=$searchExit elapsed_sec=$([int]$sw1b.Elapsed.TotalSeconds)"
}

Write-Host ""
Write-Host "=== Phase 2: Country pre-filter API only (9222, 1 tab, c=10) ==="
$sw2 = [Diagnostics.Stopwatch]::StartNew()
& node --experimental-default-type=module scripts/probe-tiktok-country-batch.mjs --api-only --concurrency 10 $Keyword $CountryBatch
$countryExit = $LASTEXITCODE
$sw2.Stop()
Write-Host "[phase2] country_exit=$countryExit elapsed_sec=$([int]$sw2.Elapsed.TotalSeconds)"

if ($countryExit -ne 0) {
  Write-Host "[phase2] retry after Chrome 9222 restart..."
  Restart-Chrome9222
  Trim-CdpPort -Port 9222 -Keep 1
  $sw2b = [Diagnostics.Stopwatch]::StartNew()
  & node --experimental-default-type=module scripts/probe-tiktok-country-batch.mjs --api-only --concurrency 10 $Keyword $CountryBatch
  $countryExit = $LASTEXITCODE
  $sw2b.Stop()
  Write-Host "[phase2-retry] country_exit=$countryExit elapsed_sec=$([int]$sw2b.Elapsed.TotalSeconds)"
}

Trim-CdpPort -Port 9222 -Keep 1
Trim-CdpPort -Port 9223 -Keep 1

Write-Host ""
Write-Host "=== Phase 3: Enrich + LLM (9223, 1 tab, c=10) ==="
$sw3 = [Diagnostics.Stopwatch]::StartNew()
& node --experimental-default-type=module scripts/probe-tiktok-enrich-llm-batch.mjs $Keyword $EnrichBatch
$enrichExit = $LASTEXITCODE
$sw3.Stop()
Write-Host "[phase3] enrich_exit=$enrichExit elapsed_sec=$([int]$sw3.Elapsed.TotalSeconds)"

schtasks.exe /Run /TN "maxin-guard-crawler-search" | Out-Null

Write-Host ""
Write-Host "================================================================"
Write-Host "[crawler65-test] search=$searchExit country=$countryExit enrich=$enrichExit"
Write-Host "================================================================"

if ($searchExit -eq 0 -and $countryExit -eq 0 -and $enrichExit -eq 0) { exit 0 }
exit 1
