param(
  [Parameter(Mandatory = $true)][int]$TaskId,
  [string]$Mode = "default"
)

$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
Set-Location $Root
. (Join-Path $Root "scripts\crawler-worker-identity.ps1")
Set-CrawlerWorkerProcessEnv -ProjectRoot $Root -MaxAttempts 2 -AllowCacheFallback | Out-Null

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

$env:SCRAPER_MODE = "lite"
$env:SEARCH_WORKER_LOOP = "false"
$env:SEARCH_TASK_ID = "$TaskId"
$env:SEARCH_WORKER_PLATFORMS = "tiktok"
$env:CDP_ENDPOINT = "http://127.0.0.1:9222"
$env:CDP_ENDPOINT_ENRICH = "http://127.0.0.1:9223"

if ($Mode -eq "api-only") {
  $env:TT_LITE_ALLOW_NAV = "0"
  $env:TT_LITE_COUNTRY_DISABLE_NAV = "1"
  $env:TT_LITE_COUNTRY_VIDEO_INFO = "0"
  $env:TT_LITE_COUNTRY_STUB_DOCUMENT = "0"
  $env:TT_LITE_TAB_POOL_SIZE = "1"
  $env:TT_LITE_COUNTRY_HTML_FIRST = "1"
  $env:TT_LITE_COUNTRY_CONCURRENCY = "10"
  $env:LITE_TT_ENRICH_CONCURRENCY = "10"
  $env:COUNTRY_BATCH_STOP_ON_ZERO = "0"
  $env:ENRICH_BATCH_STOP_ON_ZERO = "0"
  $env:AFFILIATE_GMV_ENRICH = "true"
  Write-Host "[e2e] mode=api-only (1 tab, full-pool country, stub-no-goto, c=10)"
} else {
  $env:TT_LITE_ALLOW_NAV = "1"
  Remove-Item Env:TT_LITE_COUNTRY_DISABLE_NAV -ErrorAction SilentlyContinue
  Write-Host "[e2e] mode=default (nav fallbacks enabled)"
}

$log = Join-Path $Root "logs\e2e-task-$TaskId-$Mode.log"
Write-Host "[e2e] task=$TaskId log=$log"

& node --experimental-default-type=module scripts/worker-influencer-search.js 2>&1 | Tee-Object -FilePath $log
$exit = $LASTEXITCODE

$navCount = (Select-String -Path $log -Pattern '\[lite-page-nav\]' -AllMatches).Count
Write-Host "[e2e] lite-page-nav count=$navCount"
Write-Host "[e2e] exit=$exit"

schtasks.exe /Run /TN "maxin-guard-crawler-search" | Out-Null
if ($exit -ne 0) { exit $exit }
