$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
Set-Location $Root

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

& git -C $Root fetch origin
& git -C $Root reset --hard origin/main

Write-Host "=== probe six unknown ==="
& node --experimental-default-type=module (Join-Path $Root "scripts\probe-tiktok-country-six-unknown.mjs")
$sixExit = $LASTEXITCODE

Write-Host ""
Write-Host "=== probe batch 20 ==="
& node --experimental-default-type=module (Join-Path $Root "scripts\probe-tiktok-country-batch.mjs") "AI design tool demo" 20
$batchExit = $LASTEXITCODE

schtasks.exe /Run /TN "maxin-guard-crawler-search" | Out-Null
Write-Host "probe-six-exit=$sixExit probe-batch-exit=$batchExit"
if ($sixExit -ne 0 -or $batchExit -ne 0) { exit 1 }
