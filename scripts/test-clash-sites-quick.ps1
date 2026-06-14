$ErrorActionPreference = "Continue"
Stop-Process -Name clash-verge -Force -EA SilentlyContinue
$dir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$yaml = Join-Path $dir "clash-verge.yaml"
Get-Process verge-mihomo -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 2
Start-Process "C:\Program Files\Clash Verge\verge-mihomo.exe" -ArgumentList @("-f",$yaml,"-d",$dir) -WindowStyle Hidden
Start-Sleep -Seconds 8

$clash = "http://127.0.0.1:7897"
$urls = @{
  google = "https://www.google.com/"
  instagram = "https://www.instagram.com/"
  tiktok = "https://www.tiktok.com/"
  youtube = "https://www.youtube.com/"
}

Write-Host "listen=$(netstat -an | findstr '7897.*LISTENING')"
foreach ($k in @("google","instagram","tiktok","youtube")) {
  $u = $urls[$k]
  $code = cmd /c "curl.exe -s -o nul -w %{http_code} --max-time 35 --http1.1 -x $clash $u"
  Write-Host "clash-$k=$code"
}
Write-Host "clash-ipify=$(curl.exe -s --max-time 15 -x $clash https://api.ipify.org 2>&1)"
