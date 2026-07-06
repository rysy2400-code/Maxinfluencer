param(
  [switch]$SkipWorkerStop
)

$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
Set-Location $Root

if (-not $SkipWorkerStop) {
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "probe-tiktok|run-crawler65|search-api|worker-influencer-search" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  schtasks.exe /End /TN "maxin-guard-crawler-search" 2>$null | Out-Null
  Start-Sleep -Seconds 2
}

function Restart-CdpChrome {
  param([int]$Port)
  $signal = Join-Path $Root "signals\restart-chrome-$Port.flag"
  New-Item -ItemType File -Path $signal -Force | Out-Null
  Start-Sleep -Seconds 20
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\purge-cdp-access-denied.ps1") -Port $Port -Quiet 2>$null | Out-Null
  $trim = Join-Path $Root "scripts\trim-cdp-tiktok-tabs.ps1"
  if (Test-Path $trim) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $trim -Port $Port -KeepMax 1
  }
}

Write-Host "[reset] restarting Chrome 9222 + 9223..."
Restart-CdpChrome -Port 9222
Restart-CdpChrome -Port 9223
Start-Sleep -Seconds 3

foreach ($port in @(9222, 9223)) {
  try {
    $pages = @(Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 8 | Where-Object { $_.type -eq "page" })
    Write-Host "[reset] port=$port pages=$($pages.Count)"
    foreach ($p in $pages) { Write-Host "  $($p.title) | $($p.url)" }
  } catch {
    Write-Host "[reset] port=$port list failed"
  }
}

Write-Host "[reset] done"
