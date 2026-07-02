$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
$Keyword = if ($args[0]) { $args[0] } else { "AI design tool demo" }
$Batch = if ($args[1]) { $args[1] } else { 20 }
$MaxAttempts = 5
if ($args[2] -and $args[2] -match '^\d+$') { $MaxAttempts = [int]$args[2] }

Set-Location $Root

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

& git -C $Root fetch origin
& git -C $Root reset --hard origin/main

$env:TT_LITE_ALLOW_NAV = "0"
$env:TT_LITE_COUNTRY_DISABLE_NAV = "1"
$env:TT_LITE_COUNTRY_VIDEO_INFO = "0"
$env:TT_LITE_COUNTRY_HTML_FIRST = "1"
$env:TT_LITE_COUNTRY_CONCURRENCY = "10"
$env:TT_LITE_COUNTRY_API_ONLY = "1"
$env:TT_LITE_COUNTRY_PROBE_DELAY_MS = "400"
$env:TT_LITE_COUNTRY_VIDEO_INFO_CHAIN = "1"
$env:TT_LITE_UNIVERSAL_MAX_WAIT_MS = "18000"
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
$env:HTTP_PROXY = "http://127.0.0.1:7897"

$probeScript = Join-Path $Root "scripts\probe-tiktok-country-batch.mjs"
$attempt = 0
$exitCode = 1

while ($attempt -lt $MaxAttempts -and $exitCode -ne 0) {
  $attempt += 1
  Write-Host ""
  Write-Host "=== api-only probe attempt $attempt/$MaxAttempts keyword=`"$Keyword`" batch=$Batch ==="
  & node --experimental-default-type=module $probeScript --api-only --concurrency 10 $Keyword $Batch
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    Write-Host "[probe] SUCCESS ${Batch}/${Batch} locationCreated (api-only)"
    break
  }
  Write-Host "[probe] attempt $attempt failed exit=$exitCode, retry in 15s..."
  Start-Sleep -Seconds 15
}

schtasks.exe /Run /TN "maxin-guard-crawler-search" | Out-Null
Write-Host "probe-api-only-exit=$exitCode attempts=$attempt"
exit $exitCode
