$ErrorActionPreference = "Continue"
$dir = "C:\maxinfluencer\.chrome-cdp-9222"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$ensureMihomo = "C:\maxinfluencer\scripts\ensure-mihomo-running.ps1"
if (Test-Path $ensureMihomo) {
  & $ensureMihomo
  if ($LASTEXITCODE -ne 0) {
    Write-Host "WARN: mihomo not ready, continuing anyway"
  }
}

Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and ($_.CommandLine -like "*chrome-cdp-9222*")
} | ForEach-Object {
  Write-Host "KILL $($_.ProcessId)"
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# 再杀 guard，避免其拉起旧 Chrome（仅手动强制重启时使用）
if ($env:KILL_GUARD -eq "1") {
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and ($_.CommandLine -like "*guard-chrome-9222*")
  } | ForEach-Object {
    Write-Host "KILL_GUARD $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Seconds 3

  $args = @(
    "--disable-gpu",
    "--disable-quic",
    "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=9222",
  "--user-data-dir=$dir",
  "--proxy-server=http://127.0.0.1:7897",
  "--no-first-run",
  "--no-default-browser-check",
  "https://www.instagram.com/"
)
Start-Process -FilePath $chrome -ArgumentList $args -WorkingDirectory (Split-Path $chrome)
Write-Host "STARTED chrome with proxy"

Start-Sleep -Seconds 30

$p = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "chrome.exe" -and $_.CommandLine -and ($_.CommandLine -like "*chrome-cdp-9222*") -and ($_.CommandLine -like "*--remote-debugging-port=9222*")
} | Select-Object -First 1

if ($p) {
  Write-Host "CMD=$($p.CommandLine)"
} else {
  Write-Host "NO_CHROME_PROCESS"
}
