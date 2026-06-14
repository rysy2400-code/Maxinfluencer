$ErrorActionPreference = "Continue"
Stop-Process -Name clash-verge -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$dir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$yaml = Join-Path $dir "clash-verge.yaml"
$mihomo = "C:\Program Files\Clash Verge\verge-mihomo.exe"
Get-Process verge-mihomo -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath $mihomo -ArgumentList @("-f", $yaml, "-d", $dir) -WindowStyle Hidden
Start-Sleep -Seconds 8

function Test-Url($label, $proxy, $url) {
  $tmp = Join-Path $env:TEMP "curl-out-$label.txt"
  $err = Join-Path $env:TEMP "curl-err-$label.txt"
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  if (Test-Path $err) { Remove-Item $err -Force }
  $args = @("-sS", "--http1.1", "--max-time", "40", "-o", $tmp, "-w", "%{http_code}", "-x", $proxy, $url)
  $code = & curl.exe @args 2>$err
  $size = if (Test-Path $tmp) { (Get-Item $tmp).Length } else { 0 }
  Write-Host "$label code=$code size=$size"
}

$direct = "http://O9QJT6VG:76B9A79198D4@overseas-us.tunnel.qg.net:16364"
$clash = "http://127.0.0.1:7897"

Write-Host "=== DIRECT $direct ==="
Test-Url "d-google" $direct "https://www.google.com/"
Test-Url "d-ig" $direct "https://www.instagram.com/"
Test-Url "d-tt" $direct "https://www.tiktok.com/"
Test-Url "d-yt" $direct "https://www.youtube.com/"
Write-Host "d-ipify=$(curl.exe -s --max-time 20 -x $direct https://api.ipify.org 2>&1)"

Write-Host ""
Write-Host "=== CLASH $clash ==="
Test-Url "c-google" $clash "https://www.google.com/"
Test-Url "c-ig" $clash "https://www.instagram.com/"
Test-Url "c-tt" $clash "https://www.tiktok.com/"
Test-Url "c-yt" $clash "https://www.youtube.com/"
Write-Host "c-ipify=$(curl.exe -s --max-time 20 -x $clash https://api.ipify.org 2>&1)"

Write-Host ""
Write-Host "=== yaml node ==="
Select-String -Path $yaml -Pattern "QgTunnel-IG" -Context 0,4 | ForEach-Object { $_.Context.PostContext | ForEach-Object { Write-Host "  $_" } }
