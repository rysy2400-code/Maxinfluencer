$ErrorActionPreference = "Continue"
Write-Host "=== Clash QG check ==="

Write-Host "[1] processes"
Get-Process clash-verge, verge-mihomo -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "  $($_.Name) pid=$($_.Id)"
}

Write-Host "[2] port 7897"
$listen = netstat -an | Select-String "127.0.0.1:7897.*LISTENING"
if ($listen) { Write-Host "  LISTENING" } else { Write-Host "  NOT_LISTENING" }

Write-Host "[3] yaml keys"
$yaml = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev\clash-verge.yaml"
if (Test-Path $yaml) {
  Get-Content $yaml | Select-String -Pattern "^mode:|^mixed-port:|QgTunnel-IG|instagram.com|overseas-us.tunnel|overseas.tunnel|tun:" | ForEach-Object {
    Write-Host "  $($_.Line.Trim())"
  }
}

Write-Host "[4] merge file"
$merge = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev\profiles\QgTunnelMerge.yaml"
if (Test-Path $merge) { Get-Content $merge | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" } }

Write-Host "[5] clash proxy HEAD instagram"
$clash = curl.exe -sI --max-time 25 -x http://127.0.0.1:7897 https://www.instagram.com/ 2>&1
Write-Host $clash

Write-Host "[6] clash proxy GET instagram"
$code = curl.exe -s -o NUL -w "%{http_code}" --max-time 35 -x http://127.0.0.1:7897 https://www.instagram.com/ 2>&1
Write-Host "  http_code=$code"

Write-Host "[7] direct qg tunnel HEAD"
$direct = curl.exe -sI --max-time 25 -x "http://O9QJT6VG-S-ig9222-T-600:76B9A79198D4@overseas-us.tunnel.qg.net:16364" https://www.instagram.com/ 2>&1
Write-Host $direct

Write-Host "[8] chrome 9222"
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3
  Write-Host "  CDP status=$($r.StatusCode)"
} catch {
  Write-Host "  CDP down"
}

Write-Host "=== done ==="
