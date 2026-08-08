# IG 账户 2 守护：Chrome 9223（.chrome-cdp-9223，直连，instagram.com），进程看门狗。
$ErrorActionPreference = "SilentlyContinue"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = "C:\maxinfluencer\.chrome-cdp-9223"
$port = 9223
$launchUrl = "https://www.instagram.com/"

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
    "--proxy-server=direct://",
    $launchUrl
  )
  Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
}

while ($true) {
  if (-not (Test-Cdp)) {
    Get-CimInstance Win32_Process |
      Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -match "chrome-cdp-$port" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    Start-IgChrome
    Start-Sleep -Seconds 10
  }
  Start-Sleep -Seconds 10
}
