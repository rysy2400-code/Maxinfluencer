# 看门狗：由计划任务 Maxinfluencer-CrawlerHealth 每分钟调用。
# 若 crawler-health-checker.js 已在运行（含 PM2 托管），直接退出；
# 否则以独立 node 进程拉起（不依赖 PM2 daemon，SSH 会话结束后仍存活）。
$ErrorActionPreference = "Stop"

$root = "C:\maxinfluencer"
$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) { $node = "node" }
$script = Join-Path $root "scripts\crawler-health-checker.js"
if (-not (Test-Path $script)) {
  Write-Warning "[run-crawler-health-checker] missing $script"
  exit 2
}

$running = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -match 'crawler-health-checker\.js' }
)
if ($running.Count -gt 0) {
  exit 0
}

$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$out = Join-Path $logDir "crawler-health-checker-watchdog.out.log"
$err = Join-Path $logDir "crawler-health-checker-watchdog.err.log"

Start-Process -FilePath $node `
  -ArgumentList @("--experimental-default-type=module", $script) `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err

Write-Host "[run-crawler-health-checker] started crawler-health-checker (pid via watchdog)"
exit 0
