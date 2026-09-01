# Guard Chrome 9222 CDP: process watchdog + responds to worker restart signal
$ErrorActionPreference = "SilentlyContinue"

$chrome = $env:CHROME_EXE
if (-not $chrome) {
  $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
}

$nodeExe = if (Test-Path "C:\Program Files\nodejs\node.exe") {
  "C:\Program Files\nodejs\node.exe"
} elseif (Test-Path "C:\Program Files (x86)\nodejs\node.exe") {
  "C:\Program Files (x86)\nodejs\node.exe"
} else {
  "node"
}
$cdpRpcProbeScript = Join-Path $PSScriptRoot "probe-cdp-rpc.mjs"
$rpcFailStreak = 0
$lastRpcProbeAt = $null
$rpcProbeIntervalSec = if ($env:CHROME_GUARD_RPC_PROBE_SEC) { [int]$env:CHROME_GUARD_RPC_PROBE_SEC } else { 30 }
$skipTabEnsure = $false
if ($env:CHROME_GUARD_SKIP_TAB_ENSURE) {
  $v = "$($env:CHROME_GUARD_SKIP_TAB_ENSURE)".ToLowerInvariant()
  $skipTabEnsure = ($v -eq "1" -or $v -eq "true" -or $v -eq "yes")
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
# headless 模式不支持多目标 URL（Chrome 直接报错退出），只保留第一个
if (-not $visible -and $launchUrls.Count -gt 1) {
  $launchUrls = @($launchUrls[0])
}
$proxyMode = if ($env:CHROME_9222_PROXY_MODE) { "$($env:CHROME_9222_PROXY_MODE)".ToLowerInvariant() } else { "" }
$proxyDirect = ($proxyMode -eq "direct" -or $proxyMode -eq "none" -or $proxyMode -eq "off")
$proxyServer = if ($proxyDirect) { "" } elseif ($env:CHROME_9222_PROXY_SERVER) { "$($env:CHROME_9222_PROXY_SERVER)" } else { "http://127.0.0.1:7897" }
$chromeArgList = @(
  "--disable-quic",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=9222",
  "--user-data-dir=$chromeDir",
  "--profile-directory=Default"
)
if ($proxyDirect) {
  $chromeArgList += "--no-proxy-server"
} else {
  $chromeArgList += "--proxy-server=$proxyServer"
}
$chromeArgList += @(
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
$scriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptsDir) { $scriptsDir = "C:\maxinfluencer\scripts" }
$purgeDeniedScript = Join-Path $scriptsDir "purge-cdp-access-denied.ps1"
$skipTiktokPurge = $false
if ($env:CDP_9222_SKIP_TIKTOK_PURGE) {
  $v = "$($env:CDP_9222_SKIP_TIKTOK_PURGE)".ToLowerInvariant()
  $skipTiktokPurge = ($v -eq "1" -or $v -eq "true" -or $v -eq "yes" -or $v -eq "y")
}
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
    # Signal is only produced after real CDP WebSocket/RPC consecutive failures.
     # /json/version being up does not prove the browser WebSocket works; restart is required.
    $unhealthySince = $null
    Stop-Chrome9222
    Start-Sleep -Seconds 2
    Start-Chrome9222
    Start-Sleep -Seconds 10
    continue
  }

  if (Test-Cdp9222Healthy) {
    $unhealthySince = $null
    # Aliveness: HTTP /json/version being up does not prove the browser WebSocket works, so
     # probe the real RPC periodically and restart Chrome after 3 consecutive failures.
    if ($rpcProbeIntervalSec -gt 0 -and (-not $lastRpcProbeAt -or (((Get-Date) - $lastRpcProbeAt).TotalSeconds -ge $rpcProbeIntervalSec))) {
      $lastRpcProbeAt = Get-Date
      & $nodeExe --experimental-default-type=module $cdpRpcProbeScript "http://127.0.0.1:9222" 5000 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $rpcFailStreak = 0
      } else {
        $rpcFailStreak += 1
        if ($rpcFailStreak -ge 3) {
          Write-Host "[guard-chrome-9222] CDP RPC failed x$rpcFailStreak; restarting Chrome"
          $rpcFailStreak = 0
          $unhealthySince = $null
          Stop-Chrome9222
          Start-Sleep -Seconds 2
          Start-Chrome9222
          Start-Sleep -Seconds 10
          continue
        }
      }
    }
    if (-not $skipTabEnsure -and (-not $lastTabEnsureAt -or (((Get-Date) - $lastTabEnsureAt).TotalSeconds -ge 30))) {
      Ensure-LaunchUrlTabs
      $lastTabEnsureAt = Get-Date
    }
    if ((-not $skipTiktokPurge) -and (Test-Path $purgeDeniedScript)) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $purgeDeniedScript -Port 9222 -Quiet 2>$null | Out-Null
      if ($LASTEXITCODE -eq 2) {
        Write-Host "[guard-9222] Access Denied persists; restarting Chrome 9222..."
        Stop-Chrome9222
        Start-Sleep -Seconds 2
        Start-Chrome9222
        Start-Sleep -Seconds 12
      }
    }
  } else {
    $profileProcs = @(Get-Chrome9222ProfileProcesses)
    if ($profileProcs.Count -eq 0) {
      $unhealthySince = $null
      Start-Chrome9222
      Start-Sleep -Seconds 10
    } elseif ($lastStartAt -and (((Get-Date) - $lastStartAt).TotalSeconds -lt $startGraceSec)) {
      # within start grace period, do not force-kill because CDP is not ready
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
