# IG Chrome port watchdog (SYSTEM, every 5 minutes)
# If a CDP port is down and its guard process is gone:
#   - interactive session exists -> /Run the interactive guard (visible window)
#   - no interactive session -> start Chrome as SYSTEM (session 0, headless but usable)
$ErrorActionPreference = "SilentlyContinue"
$logDir = "C:\maxinfluencer\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir "ig-guard-watchdog.log"
function Log($m) {
  try { Add-Content -Path $logFile -Value ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $m) } catch {}
}

function Test-CdpPort {
  param([int]$Port)
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $Port + "/json/version") -UseBasicParsing -TimeoutSec 4
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Test-InteractiveUserSession {
  $p = Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 } | Select-Object -First 1
  return [bool]$p
}

function Get-ProxyServerForPort {
  param([int]$Port)
  $proxyServer = "direct://"
  $envPath = "C:\maxinfluencer\.env.local"
  if (Test-Path $envPath) {
    $line = Get-Content $envPath | Where-Object { $_ -match ("^IG_CHROME_PROXY_SERVER_" + $Port + "=") } | Select-Object -First 1
    if (-not $line) { $line = Get-Content $envPath | Where-Object { $_ -match "^IG_CHROME_PROXY_SERVER=" } | Select-Object -First 1 }
    if ($line) { $proxyServer = ($line -split "=", 2)[1].Trim() }
  }
  return $proxyServer
}

function Start-ChromeSystem {
  param([int]$Port)
  $chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
  $profile = "C:\maxinfluencer\.chrome-cdp-" + $Port
  $proxy = Get-ProxyServerForPort -Port $Port
  $args = @(
    "--disable-gpu",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$Port",
    "--user-data-dir=$profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--proxy-server=$proxy",
    "https://www.instagram.com/"
  )
  Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
  Log ("SYSTEM-start chrome port=" + $Port + " proxy=" + $proxy)
}

function Get-GuardProcessCount {
  param([int]$Port)
  return @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -match ("run-guard-ig-" + $Port) }).Count
}

foreach ($port in @(9222, 9223)) {
  if (Test-CdpPort -Port $port) { continue }
  if ((Get-GuardProcessCount -Port $port) -gt 0) {
    # guard process still alive, Chrome will be restarted by the guard itself
    Log ("port=" + $port + " CDP down but guard alive, skip")
    continue
  }
  if (Test-InteractiveUserSession) {
    Log ("port=" + $port + " CDP down, interactive session -> /Run guard")
    schtasks /Run /TN ("ig-chrome-guard-user-" + $port) 2>&1 | Out-Null
    Start-Sleep -Seconds 6
    if (-not (Test-CdpPort -Port $port)) {
      Log ("port=" + $port + " guard /Run did not recover, SYSTEM fallback")
      Start-ChromeSystem -Port $port
    }
  } else {
    Log ("port=" + $port + " CDP down, no interactive session -> SYSTEM start")
    Start-ChromeSystem -Port $port
  }
}
