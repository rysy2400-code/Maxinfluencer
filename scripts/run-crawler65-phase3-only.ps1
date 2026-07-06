param(
  [string]$Keyword = "AI design tool demo",
  [int]$EnrichBatch = 10
)

$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
Set-Location $Root

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "probe-tiktok|run-crawler65" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

schtasks.exe /End /TN "maxin-guard-crawler-search" 2>$null | Out-Null
Start-Sleep -Seconds 2

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\run-crawler65-reset-chrome.ps1") -SkipWorkerStop

$env:SCRAPER_MODE = "lite"
$env:CDP_ENDPOINT = "http://127.0.0.1:9222"
$env:CDP_ENDPOINT_ENRICH = "http://127.0.0.1:9223"
$env:TT_LITE_ALLOW_NAV = "0"
$env:TT_LITE_ENRICH_ALLOW_NAV = "1"
$env:TT_LITE_TAB_POOL_SIZE = "1"
$env:LITE_TT_ENRICH_CONCURRENCY = "10"
$env:NODE_OPTIONS = "--max-old-space-size=4096"
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
$env:HTTP_PROXY = "http://127.0.0.1:7897"

Write-Host "=== Phase 3 only: Enrich + LLM (9223) ==="
& node --experimental-default-type=module scripts/probe-tiktok-enrich-llm-batch.mjs $Keyword $EnrichBatch
$enrichExit = $LASTEXITCODE
Write-Host "enrich_exit=$enrichExit"

schtasks.exe /Run /TN "maxin-guard-crawler-search" | Out-Null
exit $enrichExit
