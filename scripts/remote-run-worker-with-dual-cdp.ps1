$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\nodejs;" + $env:Path
Set-Location "C:\maxinfluencer"

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { throw "Chrome not found: $chrome" }

# 清理旧实例，避免 profile/端口占用
try { taskkill /IM chrome.exe /F | Out-Null } catch {}
Start-Sleep -Seconds 2

function Start-CdpChrome([int]$port, [string]$userDataDir, [string]$url) {
  New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
  $args = @(
    "--remote-debugging-port=$port",
    "--user-data-dir=$userDataDir",
    "--no-first-run",
    "--disable-default-apps",
    $url
  )
  Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
}

function Wait-Cdp([int]$port) {
  for ($i = 0; $i -lt 8; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/json/version" -f $port) -TimeoutSec 5 | Out-Null
      return $true
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

Start-CdpChrome -port 9222 -userDataDir "C:\maxinfluencer\.chrome-profile" -url "https://www.tiktok.com/search/video?q=home%20organization"
Start-CdpChrome -port 9223 -userDataDir "C:\maxinfluencer\.chrome-profile-enrich" -url "https://www.tiktok.com"

$ok9222 = Wait-Cdp -port 9222
$ok9223 = Wait-Cdp -port 9223
if (-not $ok9222) { throw "CDP 9222 not ready" }
if (-not $ok9223) { throw "CDP 9223 not ready" }
Write-Host "CDP_READY_9222_9223"

$env:SEARCH_WORKER_LOOP = "false"
node .\scripts\worker-influencer-search.js
