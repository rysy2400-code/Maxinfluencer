# Guard Chrome 9223 CDP：TikTok Enrich 专用（不登录 profile + 代理）
$ErrorActionPreference = "SilentlyContinue"

$chrome = $env:CHROME_EXE
if (-not $chrome) {
  $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
}

$chromeDir = if ($env:CHROME_9223_USER_DATA_DIR) { $env:CHROME_9223_USER_DATA_DIR } else { "C:\maxinfluencer\.chrome-cdp-9223" }
$signalFile = if ($env:CDP_9223_RESTART_SIGNAL_FILE) { $env:CDP_9223_RESTART_SIGNAL_FILE } else { "C:\maxinfluencer\signals\restart-chrome-9223.flag" }
$signalDir = Split-Path $signalFile -Parent
if (-not (Test-Path $signalDir)) { New-Item -ItemType Directory -Path $signalDir -Force | Out-Null }

$visible = $true
if ($env:CHROME_9223_VISIBLE) {
  $v = "$($env:CHROME_9223_VISIBLE)".ToLowerInvariant()
  $visible = ($v -eq "1" -or $v -eq "true" -or $v -eq "yes" -or $v -eq "y")
}
$launchUrl = if ($env:CHROME_9223_URL) { "$($env:CHROME_9223_URL)" } else { "https://www.tiktok.com" }
$proxyServer = if ($env:CHROME_9223_PROXY_SERVER) { "$($env:CHROME_9223_PROXY_SERVER)" } else { "http://127.0.0.1:7897" }
$chromeArgList = @(
  "--disable-quic",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=9223",
  "--user-data-dir=$chromeDir",
  "--proxy-server=$proxyServer",
  "--no-first-run",
  "--no-default-browser-check",
  $launchUrl
)
if (-not $visible) {
  $chromeArgList = @("--headless=new", "--disable-gpu") + $chromeArgList
} else {
  $chromeArgList = @("--disable-gpu") + $chromeArgList
}

$profileDirPattern = [Regex]::Escape($chromeDir)
$unhealthySince = $null

function Test-Cdp9223Healthy {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9223/json/version" -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Get-Chrome9223ProfileProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "chrome|msedge") -and
    ($_.CommandLine -and ($_.CommandLine -match $profileDirPattern))
  }
}

function Stop-Chrome9223 {
  Get-Chrome9223ProfileProcesses | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Start-Chrome9223 {
  if (Test-Path $chrome) {
    $wd = Split-Path $chrome -Parent
    Start-Process -FilePath $chrome -ArgumentList $chromeArgList -WorkingDirectory $wd | Out-Null
  }
}

while ($true) {
  if (Test-Path $signalFile) {
    try { Remove-Item $signalFile -Force -ErrorAction SilentlyContinue } catch {}
    $unhealthySince = $null
    Stop-Chrome9223
    Start-Sleep -Seconds 2
    Start-Chrome9223
    Start-Sleep -Seconds 5
    continue
  }

  if (Test-Cdp9223Healthy) {
    $unhealthySince = $null
  } else {
    $profileProcs = @(Get-Chrome9223ProfileProcesses)
    if ($profileProcs.Count -eq 0) {
      $unhealthySince = $null
      Start-Chrome9223
    } elseif (-not $unhealthySince) {
      $unhealthySince = Get-Date
    } elseif (((Get-Date) - $unhealthySince).TotalSeconds -ge 45) {
      $unhealthySince = $null
      Stop-Chrome9223
      Start-Sleep -Seconds 2
      Start-Chrome9223
    }
  }

  Start-Sleep -Seconds 8
}
