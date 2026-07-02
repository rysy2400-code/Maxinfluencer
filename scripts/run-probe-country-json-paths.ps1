$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
$Keyword = if ($args[0]) { $args[0] } else { "AI design tool demo" }
$Batch = if ($args[1]) { $args[1] } else { 20 }

Set-Location $Root

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

& git -C $Root fetch origin
& git -C $Root reset --hard origin/main

$env:HTTPS_PROXY = "http://127.0.0.1:7897"
$env:HTTP_PROXY = "http://127.0.0.1:7897"
$env:TT_LITE_COUNTRY_PROBE_DELAY_MS = "200"

$script = Join-Path $Root "scripts\probe-tiktok-country-json-paths.mjs"
& node --experimental-default-type=module $script $Keyword $Batch
$exitCode = $LASTEXITCODE

schtasks.exe /Run /TN "maxin-guard-crawler-search" | Out-Null
Write-Host "probe-json-paths-exit=$exitCode"
exit $exitCode
