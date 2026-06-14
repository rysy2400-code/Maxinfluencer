$ErrorActionPreference = "Continue"
$ClashVerge = "C:\Program Files\Clash Verge\clash-verge.exe"
$Mihomo = "C:\Program Files\Clash Verge\verge-mihomo.exe"
$ConfigDir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$YamlPath = Join-Path $ConfigDir "clash-verge.yaml"

# 优先用 Clash Verge GUI 托管 mihomo（比裸起 verge-mihomo 更稳定）
if (-not (Get-Process clash-verge -ErrorAction SilentlyContinue)) {
  if (Test-Path $ClashVerge) {
    Start-Process -FilePath $ClashVerge -WindowStyle Minimized
    Write-Host "CLASH_VERGE_STARTED"
    Start-Sleep -Seconds 12
  }
}

$listen = netstat -an | Select-String "127.0.0.1:7897.*LISTENING"
if (-not $listen) {
  if (Test-Path $Mihomo) {
    Start-Process -FilePath $Mihomo -ArgumentList @("-f", $YamlPath, "-d", $ConfigDir) -WindowStyle Hidden
    Write-Host "MIHOMO_STARTED_FALLBACK"
    Start-Sleep -Seconds 8
  }
}

$listen2 = netstat -an | Select-String "127.0.0.1:7897.*LISTENING"
if ($listen2) {
  Write-Host "MIHOMO_LISTENING"
} else {
  Write-Host "MIHOMO_NOT_LISTENING"
  exit 1
}

$ig = curl.exe -sI --max-time 20 -x http://127.0.0.1:7897 https://www.instagram.com/ 2>&1
Write-Host "CURL=$ig"
if ($ig -match "HTTP/1\.1 200" -or $ig -match "HTTP/2 200") {
  Write-Host "IG_OK"
  exit 0
}
Write-Host "IG_FAIL"
exit 1
