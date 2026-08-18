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
$launchUrl = if ($env:CHROME_9222_URL) { "$($env:CHROME_9222_URL)" } else { "about:blank" }
$launchUrls = @(
  $launchUrl -split "[,\r\n]+" |
    ForEach-Object { "$_".Trim() } |
    Where-Object { $_ }
)
if ($launchUrls.Count -eq 0) { $launchUrls = @("about:blank") }
$proxyServer = if ($env:CHROME_9222_PROXY_SERVER) { "$($env:CHROME_9222_PROXY_SERVER)" } else { "http://127.0.0.1:7897" }
$chromeArgList = @(
  "--disable-quic",
  "--blink-settings=imagesEnabled=false",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=9222",
  "--user-data-dir=$chromeDir",
  "--profile-directory=Default",
  "--proxy-server=$proxyServer",
  "--no-first-run",
  "--no-default-browser-check"
)
$chromeArgList += $launchUrls
if (-not $visible) {
  $chromeArgList = @("--headless=new", "--disable-gpu") + $chromeArgList
} else {
  $chromeArgList = @("--disable-gpu") + $chromeArgList
}

$profileDirPattern = [Regex]::Escape($chromeDir)
$unhealthySince = $null
$lastStartAt = $null
$lastTabEnsureAt = $null
$startGraceSec = if ($env:CHROME_GUARD_START_GRACE_SEC) { [int]$env:CHROME_GUARD_START_GRACE_SEC } else { 90 }

function Test-Cdp9222Healthy {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Get-Chrome9222ProfileProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "chrome|msedge") -and
    ($_.CommandLine -and ($_.CommandLine -match $profileDirPattern))
  }
}

function Stop-Chrome9222 {
  Get-Chrome9222ProfileProcesses | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Start-Chrome9222 {
  if (Test-Path $chrome) {
    $wd = Split-Path $chrome -Parent
    Start-Process -FilePath $chrome -ArgumentList $chromeArgList -WorkingDirectory $wd | Out-Null
    $script:lastStartAt = Get-Date
  }
}

function Normalize-TabUrl([string]$Url) {
  $u = "$Url".Trim()
  if (-not $u) { return "" }
  $u = ($u -split "#")[0]
  $u = ($u -split "\?")[0]
  return $u.TrimEnd("/")
}

function Get-LaunchTabRank($Tab) {
  $u = [string]$Tab.url
  $normalized = Normalize-TabUrl $u
  $launch = Normalize-TabUrl $launchUrls[0]
  if ($normalized -eq $launch) { return 0 }
  if ($u -match ("^" + [Regex]::Escape($launch) + "([/?#]|$)")) { return 1 }
  if ($u -eq "about:blank" -or $u -match "^chrome://newtab") { return 8 }
  return 9
}

function Ensure-SingleLaunchUrlTab {
  if ($launchUrls.Count -ne 1) { return }
  try {
    $allTargets = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/list" -TimeoutSec 5
    $pages = @(
      $allTargets |
        Where-Object { $_.type -eq "page" }
    )

    if ($pages.Count -eq 0) {
      $url = [uri]::EscapeDataString($launchUrls[0])
      Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:9222/json/new?$url" -TimeoutSec 5 | Out-Null
      return
    }

    $ranked = @(
      $pages | Sort-Object `
        @{ Expression = { Get-LaunchTabRank $_ }; Ascending = $true }, `
        @{ Expression = { [string]$_.url }; Ascending = $true }
    )

    $bestRank = Get-LaunchTabRank $ranked[0]
    if ($bestRank -gt 1) {
      foreach ($p in $pages) {
        try { Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/close/$($p.id)" -TimeoutSec 5 | Out-Null } catch {}
      }
      Start-Sleep -Milliseconds 500
      $url = [uri]::EscapeDataString($launchUrls[0])
      Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:9222/json/new?$url" -TimeoutSec 5 | Out-Null
      return
    }

    $keeperId = [string]$ranked[0].id
    foreach ($p in $pages) {
      if ([string]$p.id -eq $keeperId) { continue }
      try { Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/close/$($p.id)" -TimeoutSec 5 | Out-Null } catch {}
    }
  } catch {}
}

function Ensure-LaunchUrlTabs {
  if ($launchUrls.Count -le 1) { return }
  try {
    $allTargets = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/list" -TimeoutSec 5
    $targets = @(
      $allTargets |
        Where-Object { $_.type -eq "page" }
    )
    for ($i = $targets.Count; $i -lt $launchUrls.Count; $i++) {
      $url = [uri]::EscapeDataString($launchUrls[$i])
      Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:9222/json/new?$url" -TimeoutSec 5 | Out-Null
    }
  } catch {}
}

while ($true) {
  if (Test-Path $signalFile) {
    if ($lastStartAt -and (((Get-Date) - $lastStartAt).TotalSeconds -lt $startGraceSec)) {
      Start-Sleep -Seconds 8
      continue
    }
    try { Remove-Item $signalFile -Force -ErrorAction SilentlyContinue } catch {}
    # 该信号只会在真实 CDP WebSocket/RPC 连续连接失败后产生。
    # /json/version 可用不能证明 browser WebSocket 可用，因此必须重启。
    $unhealthySince = $null
    Stop-Chrome9222
    Start-Sleep -Seconds 2
    Start-Chrome9222
    Start-Sleep -Seconds 10
    continue
  }

  if (Test-Cdp9222Healthy) {
    $unhealthySince = $null
    if (-not $lastTabEnsureAt -or (((Get-Date) - $lastTabEnsureAt).TotalSeconds -ge 30)) {
      if ($launchUrls.Count -eq 1) {
        Ensure-SingleLaunchUrlTab
      } else {
        Ensure-LaunchUrlTabs
      }
      $lastTabEnsureAt = Get-Date
    }
  } else {
    $profileProcs = @(Get-Chrome9222ProfileProcesses)
    if ($profileProcs.Count -eq 0) {
      $unhealthySince = $null
      Start-Chrome9222
      Start-Sleep -Seconds 10
    } elseif ($lastStartAt -and (((Get-Date) - $lastStartAt).TotalSeconds -lt $startGraceSec)) {
      # 启动宽限期内不因 CDP 未就绪而强杀
    } elseif (-not $unhealthySince) {
      $unhealthySince = Get-Date
    } elseif (((Get-Date) - $unhealthySince).TotalSeconds -ge 120) {
      $unhealthySince = $null
      Stop-Chrome9222
      Start-Sleep -Seconds 2
      Start-Chrome9222
      Start-Sleep -Seconds 10
    }
  }

  Start-Sleep -Seconds 8
}
