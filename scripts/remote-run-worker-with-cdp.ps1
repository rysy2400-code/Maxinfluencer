$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\nodejs;" + $env:Path
Set-Location "C:\maxinfluencer"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { throw "Chrome not found: $chrome" }

$listening = Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $userData = "C:\maxinfluencer\.chrome-profile"
  New-Item -ItemType Directory -Force -Path $userData | Out-Null
  $args = @(
    "--remote-debugging-port=9222",
    "--user-data-dir=$userData",
    "--no-first-run",
    "--disable-default-apps",
    "https://www.tiktok.com"
  )
  Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
  Start-Sleep -Seconds 5
}

$ok = $false
for ($i = 0; $i -lt 5; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 5 | Out-Null
    $ok = $true
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $ok) { throw "CDP endpoint not ready on 9222" }
Write-Host "CDP_READY"

$env:SEARCH_WORKER_LOOP = "false"
node .\scripts\worker-influencer-search.js
