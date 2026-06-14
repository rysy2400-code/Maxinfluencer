param(
  [string]$AuthKey = $env:QG_AUTH_KEY,
  [string]$AuthPwd = $env:QG_AUTH_PWD
)

$ErrorActionPreference = "Continue"
if (-not $AuthKey) { throw "请提供 -AuthKey 或设置环境变量 QG_AUTH_KEY" }
if (-not $AuthPwd) { throw "请提供 -AuthPwd 或设置环境变量 QG_AUTH_PWD" }
Write-Host "=== bootstrap-qg-ig.ps1 ==="

$YamlPath = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev\clash-verge.yaml"
$needConfigure = $true
if (Test-Path $YamlPath) {
  $txt = Get-Content $YamlPath -Raw
  if ($txt -match "QgTunnel-IG" -and $txt -match "DOMAIN-SUFFIX,instagram.com,QgTunnel-IG") {
    $needConfigure = $false
    Write-Host "CONFIGURE_SKIP (already has QgTunnel-IG)"
  }
}
if ($needConfigure) {
  & "C:\maxinfluencer\scripts\configure-qg-tunnel-proxy.ps1" -AuthKey $AuthKey -AuthPwd $AuthPwd
  if ($LASTEXITCODE -ne 0) { Write-Host "CONFIGURE_FAILED"; exit 1 }
}

& "C:\maxinfluencer\scripts\ensure-mihomo-running.ps1"
if ($LASTEXITCODE -ne 0) { Write-Host "MIHOMO_FAILED"; exit 1 }

$dir = "C:\maxinfluencer\.chrome-cdp-9222"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$proxy = "http://127.0.0.1:7897"

# 仅当 9222 无响应或主进程缺 proxy 时才重启 Chrome
$needRestart = $true
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3
  if ($r.StatusCode -eq 200) {
    $main = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq "chrome.exe" -and $_.CommandLine -like "*chrome-cdp-9222*" -and $_.CommandLine -like "*--remote-debugging-port=9222*"
    } | Select-Object -First 1
    if ($main -and $main.CommandLine -like "*--proxy-server=$proxy*") {
      $needRestart = $false
      Write-Host "CHROME_OK pid=$($main.ProcessId)"
    }
  }
} catch {
  $needRestart = $true
}

if ($needRestart) {
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and ($_.CommandLine -like "*chrome-cdp-9222*")
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
  Start-Sleep -Seconds 2
  $args = @(
    "--disable-gpu",
    "--disable-quic",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "--user-data-dir=$dir",
    "--proxy-server=$proxy",
    "--no-first-run",
    "--no-default-browser-check",
    "https://www.instagram.com/"
  )
  Start-Process -FilePath $chrome -ArgumentList $args -WorkingDirectory (Split-Path $chrome)
  Write-Host "CHROME_RESTARTED"
  Start-Sleep -Seconds 25
}

# 拉起 guard（不先杀，避免竞态）
schtasks /Run /TN maxin-guard-chrome-9222 2>$null | Out-Null
Start-Sleep -Seconds 3

try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 5
  Write-Host "CDP_STATUS=$($r.StatusCode)"
} catch {
  Write-Host "CDP_DOWN"
  exit 1
}

$ig = curl.exe -sI --max-time 20 -x http://127.0.0.1:7897 https://www.instagram.com/ 2>&1
if ($ig -match "HTTP/1\.1 200" -or $ig -match "HTTP/2 200") { Write-Host "IG_PROXY_OK" } else { Write-Host "IG_PROXY_FAIL" }

Write-Host "BOOTSTRAP_DONE"
