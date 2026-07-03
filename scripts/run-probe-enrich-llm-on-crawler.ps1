$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
$Keyword = if ($args[0]) { $args[0] } else { "AI design tool demo" }
$Batch = if ($args[1]) { $args[1] } else { 10 }

Set-Location $Root

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

& git -C $Root fetch origin
& git -C $Root reset --hard origin/main

$env:SCRAPER_MODE = "lite"
$env:TT_LITE_MAX_VIDEOS = "50"
$env:TT_LITE_ALLOW_NAV = "0"
$env:TT_LITE_COUNTRY_DISABLE_NAV = "1"
$env:TT_LITE_COUNTRY_VIDEO_INFO = "0"
$env:TT_LITE_COUNTRY_STUB_DOCUMENT = "0"
$env:TT_LITE_TAB_POOL_SIZE = "1"
$env:TT_LITE_COUNTRY_HTML_FIRST = "1"
$env:LITE_TT_ENRICH_CONCURRENCY = "10"
$env:COUNTRY_BATCH_STOP_ON_ZERO = "0"
$env:ENRICH_BATCH_STOP_ON_ZERO = "0"
$env:AFFILIATE_GMV_ENRICH = "true"
$env:CDP_ENDPOINT_ENRICH = "http://127.0.0.1:9222"
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
$env:HTTP_PROXY = "http://127.0.0.1:7897"

$script = Join-Path $Root "scripts\probe-tiktok-enrich-llm-batch.mjs"
& node --experimental-default-type=module $script $Keyword $Batch
$exitCode = $LASTEXITCODE

schtasks.exe /Run /TN "maxin-guard-crawler-search" | Out-Null
Write-Host "probe-enrich-llm-exit=$exitCode"
exit $exitCode
