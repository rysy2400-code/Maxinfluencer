# Keep-alive guard for the ipweb mihomo instance on port 7896 (TikTok browser 9222).
# ASCII-only: PS 5.1 mangles non-ASCII comments when the file has no BOM.
$ErrorActionPreference = "SilentlyContinue"
$Root = "C:\maxinfluencer"
$mihomo = "C:\Program Files\Clash Verge\verge-mihomo.exe"
$cfg = Join-Path $Root "config\tiktok-ipweb-7896.yaml"
$dir = Join-Path $Root "config\mihomo-tiktok-7896"
$log = Join-Path $Root "logs\mihomo-7896.log"
$errLog = Join-Path $Root "logs\mihomo-7896.err.log"
$port = 7896

if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

while ($true) {
  $listening = (netstat -an | Select-String (":" + $port + "\s+.*LISTENING") | Measure-Object).Count -gt 0
  $proc = (Get-CimInstance Win32_Process -Filter "Name='verge-mihomo.exe'" |
    Where-Object { [string]$_.CommandLine -like "*tiktok-ipweb-7896*" } | Measure-Object).Count
  if (-not $listening -or $proc -eq 0) {
    Get-CimInstance Win32_Process -Filter "Name='verge-mihomo.exe'" |
      Where-Object { [string]$_.CommandLine -like "*tiktok-ipweb-7896*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 2
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$ts] starting mihomo 7896" | Out-File -FilePath $log -Append -Encoding UTF8
    Start-Process -FilePath $mihomo -ArgumentList @("-d", $dir, "-f", $cfg) `
      -RedirectStandardOutput $log -RedirectStandardError $errLog -WindowStyle Hidden
    Start-Sleep -Seconds 12
  }
  Start-Sleep -Seconds 20
}
