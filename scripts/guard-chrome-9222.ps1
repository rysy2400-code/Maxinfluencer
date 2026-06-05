# Guard Chrome 9222 CDP：进程守护 + 响应 worker 重启信号
$ErrorActionPreference = "SilentlyContinue"

$chrome = $env:CHROME_EXE
if (-not $chrome) {
  $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
}

$chromeDir = if ($env:CHROME_9222_USER_DATA_DIR) { $env:CHROME_9222_USER_DATA_DIR } else { "C:\maxinfluencer\.chrome-cdp-9222" }
$signalFile = if ($env:CDP_RESTART_SIGNAL_FILE) { $env:CDP_RESTART_SIGNAL_FILE } else { "C:\maxinfluencer\signals\restart-chrome-9222.flag" }
$signalDir = Split-Path $signalFile -Parent
if (-not (Test-Path $signalDir)) { New-Item -ItemType Directory -Path $signalDir -Force | Out-Null }

$visible = $true
if ($env:CHROME_VISIBLE) {
  $v = "$($env:CHROME_VISIBLE)".ToLowerInvariant()
  $visible = ($v -eq "1" -or $v -eq "true" -or $v -eq "yes" -or $v -eq "y")
}
$chromeModeArgs = if ($visible) { "--disable-gpu" } else { "--headless=new --disable-gpu" }
$launchUrl = if ($env:CHROME_9222_URL) { "$($env:CHROME_9222_URL)" } else { "about:blank" }
$args = "$chromeModeArgs --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=$chromeDir --no-first-run --no-default-browser-check $launchUrl"

function Stop-Chrome9222 {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "chrome|msedge") -and
    ($_.CommandLine -match "remote-debugging-port=9222")
  } | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Start-Chrome9222 {
  if (Test-Path $chrome) {
    Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
  }
}

while ($true) {
  if (Test-Path $signalFile) {
    try { Remove-Item $signalFile -Force -ErrorAction SilentlyContinue } catch {}
    Stop-Chrome9222
    Start-Sleep -Seconds 2
    Start-Chrome9222
    Start-Sleep -Seconds 3
  }

  $mine = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "chrome|msedge") -and
    ($_.CommandLine -match "remote-debugging-port=9222")
  }
  if (-not $mine) { Start-Chrome9222 }
  Start-Sleep -Seconds 8
}
