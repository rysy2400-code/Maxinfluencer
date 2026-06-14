$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { throw "Chrome not found" }

$userData = if ($env:CHROME_9223_USER_DATA_DIR) { $env:CHROME_9223_USER_DATA_DIR } else { "C:\maxinfluencer\.chrome-cdp-9223" }
New-Item -ItemType Directory -Force -Path $userData | Out-Null

$proxyServer = if ($env:CHROME_9223_PROXY_SERVER) { $env:CHROME_9223_PROXY_SERVER } else { "http://127.0.0.1:7897" }

$listen = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
  $args = @(
    "--disable-quic",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9223",
    "--user-data-dir=$userData",
    "--proxy-server=$proxyServer",
    "--no-first-run",
    "--disable-default-apps",
    "https://www.tiktok.com"
  )
  Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
  Start-Sleep -Seconds 5
}
$resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9223/json/version" -TimeoutSec 8
Write-Host "CDP_9223_READY"
Write-Output $resp.Content
