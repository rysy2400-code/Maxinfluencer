$ErrorActionPreference = "Stop"
$paths = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
)
$exe = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
  Write-Host "NO_BROWSER"
  exit 2
}
Write-Host "BROWSER=$exe"
$listen = Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
  $userData = "C:\maxinfluencer\.chrome-profile"
  New-Item -ItemType Directory -Force -Path $userData | Out-Null
  Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9222","--user-data-dir=$userData","--no-first-run","--disable-default-apps","https://www.tiktok.com" | Out-Null
  Start-Sleep -Seconds 4
}
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 8
  Write-Host "CDP_OK"
  Write-Output $resp.Content
} catch {
  Write-Host "CDP_FAIL"
  Write-Host $_.Exception.Message
  exit 3
}
