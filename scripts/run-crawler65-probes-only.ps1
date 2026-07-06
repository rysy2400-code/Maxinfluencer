$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
Set-Location $Root

for ($i = 1; $i -le 3; $i++) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\purge-cdp-access-denied.ps1") -Port 9222
  $tabs = Invoke-RestMethod "http://127.0.0.1:9222/json/list" -TimeoutSec 8
  $pages = @($tabs | Where-Object { $_.type -eq "page" })
  $ok = @($pages | Where-Object { $_.url -match "^https://www\.tiktok\.com" -and $_.title -notmatch "Access Denied" })
  Write-Host "[check] attempt=$i ok_tiktok=$($ok.Count)"
  if ($ok.Count -ge 1) { break }
  New-Item -ItemType File -Path (Join-Path $Root "signals\restart-chrome-9222.flag") -Force | Out-Null
  Start-Sleep -Seconds 20
}

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
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
$env:HTTP_PROXY = "http://127.0.0.1:7897"

Write-Host "=== search ==="
& node --experimental-default-type=module scripts/probe-tiktok-search-api-only.mjs "AI design tool demo"
$searchExit = $LASTEXITCODE
Write-Host "search_exit=$searchExit"

Write-Host "=== country ==="
& node --experimental-default-type=module scripts/probe-tiktok-country-batch.mjs --api-only --concurrency 10 "AI design tool demo" 10
$countryExit = $LASTEXITCODE
Write-Host "country_exit=$countryExit"

Write-Host "=== enrich ==="
& node --experimental-default-type=module scripts/probe-tiktok-enrich-llm-batch.mjs "AI design tool demo" 5
$enrichExit = $LASTEXITCODE
Write-Host "enrich_exit=$enrichExit"

Write-Host "SUMMARY search=$searchExit country=$countryExit enrich=$enrichExit"
