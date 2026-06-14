$ErrorActionPreference = "Continue"
& "C:\maxinfluencer\scripts\ensure-mihomo-running.ps1" | Out-Null

$direct = "http://O9QJT6VG:76B9A79198D4@overseas-us.tunnel.qg.net:16364"
$clash = "http://127.0.0.1:7897"
$urls = @{
  google = "https://www.google.com/"
  instagram = "https://www.instagram.com/"
  tiktok = "https://www.tiktok.com/"
  youtube = "https://www.youtube.com/"
}

Write-Host "=== DIRECT tunnel $direct ==="
foreach ($kv in $urls.GetEnumerator()) {
  $code = curl.exe -s -o NUL -w "%{http_code}" --max-time 35 --http1.1 -x $direct $kv.Value 2>&1
  Write-Host "$($kv.Key)=$code"
}
Write-Host "ipify=$(curl.exe -s --max-time 20 -x $direct https://api.ipify.org 2>&1)"

Write-Host ""
Write-Host "=== VIA Clash $clash ==="
foreach ($kv in $urls.GetEnumerator()) {
  $code = curl.exe -s -o NUL -w "%{http_code}" --max-time 35 --http1.1 -x $clash $kv.Value 2>&1
  Write-Host "$($kv.Key)=$code"
}
Write-Host "ipify=$(curl.exe -s --max-time 20 -x $clash https://api.ipify.org 2>&1)"
