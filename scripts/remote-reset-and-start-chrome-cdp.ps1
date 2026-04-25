$ErrorActionPreference = "Stop"

# A) Stop existing Chrome processes
try {
  taskkill /IM chrome.exe /F | Out-Host
} catch {
  Write-Host "No existing chrome.exe to kill (or already stopped)."
}

# B) Start Chrome with same profile + 9222
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = "C:\maxinfluencer\.chrome-profile"

if (-not (Test-Path $chrome)) {
  throw "chrome.exe not found: $chrome"
}

New-Item -ItemType Directory -Force -Path $profile | Out-Null

$args = @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profile",
  "--no-first-run",
  "--disable-default-apps",
  "https://www.tiktok.com/search/video?q=home%20organization"
)

Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
Start-Sleep -Seconds 4

try {
  $v = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 8
  Write-Host "CDP_READY"
  Write-Output $v.Content
} catch {
  Write-Host "CDP_NOT_READY"
  Write-Host $_.Exception.Message
  exit 2
}
