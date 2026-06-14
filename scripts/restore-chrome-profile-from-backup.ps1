$ErrorActionPreference = "Stop"
Write-Host "=== restore-chrome-profile-from-backup ==="

$root = "C:\maxinfluencer"
$profile = Join-Path $root ".chrome-cdp-9222"
$bak = @(Get-ChildItem $root -Directory | Where-Object { $_.Name -like ".chrome-cdp-9222.bak-*" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1)

if (-not $bak) {
  throw "No .chrome-cdp-9222.bak-* backup found under $root"
}
Write-Host "Using backup: $($bak.Name)"

Write-Host "--- stop guard + chrome ---"
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "powershell.exe" -and $_.CommandLine -match "run-guard-chrome-9222") -or
  ($_.Name -match "chrome" -and $_.CommandLine -match "\.chrome-cdp-9222")
} | ForEach-Object {
  Write-Host "stop pid=$($_.ProcessId) $($_.Name)"
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 4

if (Test-Path "C:\maxinfluencer\signals\restart-chrome-9222.flag") {
  Remove-Item "C:\maxinfluencer\signals\restart-chrome-9222.flag" -Force
}

$freshBackup = Join-Path $root (".chrome-cdp-9222.empty-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
if (Test-Path $profile) {
  Write-Host "Move current profile -> $freshBackup"
  Rename-Item $profile $freshBackup -Force
}

Write-Host "Rename backup $($bak.Name) -> .chrome-cdp-9222"
Rename-Item $bak.FullName $profile -Force

$cookies = Join-Path $profile "Default\Network\Cookies"
if (Test-Path $cookies) {
  Write-Host "cookies_size=$((Get-Item $cookies).Length)"
} else {
  Write-Host "WARN cookies_missing"
}

Write-Host "--- restart guard ---"
schtasks /Run /TN maxin-guard-chrome-9222 2>&1 | ForEach-Object { Write-Host $_ }
Write-Host "Waiting 25s for Chrome CDP..."
Start-Sleep -Seconds 25

$cdpOk = $false
try {
  Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 5 | Out-Null
  $cdpOk = $true
} catch {}

Write-Host "CDP=$cdpOk chrome=$((Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count)"
netstat -ano | findstr "LISTENING" | findstr ":9222"
Write-Host "RESTORE_DONE cdp=$cdpOk"
