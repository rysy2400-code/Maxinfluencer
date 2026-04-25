$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { throw "Chrome not found" }

$userData = "C:\maxinfluencer\.chrome-profile-enrich"
New-Item -ItemType Directory -Force -Path $userData | Out-Null

$listen = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
  $args = @(
    "--remote-debugging-port=9223",
    "--user-data-dir=$userData",
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
