$ErrorActionPreference = "Continue"
Stop-Process -Name clash-verge -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$dir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$yaml = Join-Path $dir "clash-verge.yaml"
$mihomo = "C:\Program Files\Clash Verge\verge-mihomo.exe"

Get-Process verge-mihomo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Start-Process -FilePath $mihomo -ArgumentList @("-f", $yaml, "-d", $dir) -WindowStyle Hidden
Start-Sleep -Seconds 8

for ($i = 0; $i -lt 4; $i++) {
  $listen = netstat -an | Select-String "7897.*LISTENING"
  if ($listen) { Write-Host "t=$i LISTEN" } else { Write-Host "t=$i DOWN" }
  $code = curl.exe -s -o NUL -w "%{http_code}" --max-time 25 -x http://127.0.0.1:7897 https://www.instagram.com/ 2>&1
  Write-Host "t=$i http_code=$code"
  Start-Sleep -Seconds 10
}
