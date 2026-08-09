# IG account 1 guard: Chrome 9222 (.chrome-cdp-9222, instagram.com) watchdog.
# Runs under an interactive ONLOGON scheduled task so the login window is visible.
$ErrorActionPreference = "SilentlyContinue"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = "C:\maxinfluencer\.chrome-cdp-9222"
$port = 9222
$launchUrl = "https://www.instagram.com/"
$signalFile = "C:\maxinfluencer\signals\restart-chrome-$port.flag"
$proxyServer = "direct://"
if (Test-Path "C:\maxinfluencer\.env.local") {
  $proxyLine = Get-Content "C:\maxinfluencer\.env.local" | Where-Object { $_ -match "^IG_CHROME_PROXY_SERVER_$port=" } | Select-Object -First 1
  if (-not $proxyLine) {
    $proxyLine = Get-Content "C:\maxinfluencer\.env.local" | Where-Object { $_ -match "^IG_CHROME_PROXY_SERVER=" } | Select-Object -First 1
  }
  if ($proxyLine) { $proxyServer = ($proxyLine -split "=", 2)[1].Trim() }
}
$logFile = "C:\maxinfluencer\logs\ig-guard-9222.log"
function Log($m) {
  try { Add-Content -Path $logFile -Value ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $m) } catch {}
}
function Kill-ProfileChrome {
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -match "chrome-cdp-$port" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Test-Cdp {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Start-IgChrome {
  $args = @(
    "--disable-gpu",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$port",
    "--user-data-dir=$profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--proxy-server=$proxyServer",
    $launchUrl
  )
  Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
}

# Take over on start: kill all instances of this profile (incl. SYSTEM session 0)
# so this guard's Chrome is visible in the interactive session.
Kill-ProfileChrome
Start-Sleep -Seconds 2
Start-IgChrome
Log "started chrome, takeover done"

while ($true) {
  try {
    if (Test-Path $signalFile) {
      Log "restart signal received, restarting chrome"
      Kill-ProfileChrome
      Remove-Item $signalFile -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      Start-IgChrome
      Start-Sleep -Seconds 10
    }
    if (-not (Test-Cdp)) {
      Log "CDP down, restarting chrome"
      Kill-ProfileChrome
      Start-Sleep -Seconds 2
      Start-IgChrome
      Start-Sleep -Seconds 10
    }
    Start-Sleep -Seconds 10
  } catch {
    Log ("guard loop error: " + $_.Exception.Message)
    Start-Sleep -Seconds 5
  }
}
