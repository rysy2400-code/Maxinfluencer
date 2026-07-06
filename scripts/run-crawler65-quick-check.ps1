$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
Set-Location $Root

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "probe-tiktok|run-crawler65|search-api" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

schtasks.exe /End /TN "maxin-guard-crawler-search" 2>$null | Out-Null
Start-Sleep -Seconds 2

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\run-crawler65-reset-chrome.ps1") -SkipWorkerStop

foreach ($port in @(9222, 9223)) {
  try {
    Invoke-RestMethod "http://127.0.0.1:$port/json/version" -TimeoutSec 5 | Out-Null
    Write-Host "[cdp] port=$port OK"
  } catch {
    Write-Host "[cdp] port=$port FAIL"
  }
}

$tabs9222 = @(Invoke-RestMethod "http://127.0.0.1:9222/json/list" -TimeoutSec 8 | Where-Object { $_.type -eq "page" })
Write-Host "[cdp] 9222 pages=$($tabs9222.Count)"
foreach ($t in $tabs9222) { Write-Host "  title=$($t.title) url=$($t.url)" }

$env:SCRAPER_MODE = "lite"
$env:CDP_ENDPOINT = "http://127.0.0.1:9222"
$env:CDP_ENDPOINT_ENRICH = "http://127.0.0.1:9223"
$env:TT_LITE_ALLOW_NAV = "0"
$env:TT_LITE_TAB_POOL_SIZE = "1"
$env:TT_LITE_COUNTRY_DISABLE_NAV = "1"
$env:TT_LITE_COUNTRY_HTML_FIRST = "1"
$env:TT_LITE_COUNTRY_CONCURRENCY = "10"
$env:TT_LITE_COUNTRY_API_ONLY = "1"
$env:LITE_TT_ENRICH_CONCURRENCY = "10"
$env:NODE_OPTIONS = "--max-old-space-size=4096"
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
$env:HTTP_PROXY = "http://127.0.0.1:7897"

$trim = Join-Path $Root "scripts\trim-cdp-tiktok-tabs.ps1"
if (Test-Path $trim) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $trim -Port 9222 -KeepMax 1
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $trim -Port 9223 -KeepMax 1
}

Write-Host ""
Write-Host "=== search api-only ==="
& node --experimental-default-type=module scripts/probe-tiktok-search-api-only.mjs "AI design tool demo"
$searchExit = $LASTEXITCODE
Write-Host "search_exit=$searchExit"

Write-Host ""
Write-Host "=== country api-only c10 1tab ==="
& node --experimental-default-type=module scripts/probe-tiktok-country-batch.mjs --api-only --concurrency 10 "AI design tool demo" 10
$countryExit = $LASTEXITCODE
Write-Host "country_exit=$countryExit"

Write-Host ""
Write-Host "=== enrich+llm 9223 c10 1tab ==="
& node --experimental-default-type=module scripts/probe-tiktok-enrich-llm-batch.mjs "AI design tool demo" 5
$enrichExit = $LASTEXITCODE
Write-Host "enrich_exit=$enrichExit"

schtasks.exe /Run /TN "maxin-guard-crawler-search" | Out-Null
Write-Host "SUMMARY search=$searchExit country=$countryExit enrich=$enrichExit"
if ($searchExit -eq 0 -and $countryExit -eq 0 -and $enrichExit -eq 0) { exit 0 }
exit 1
