$ErrorActionPreference = "Stop"

# =============================================================================
# 机器 A：仅清单 1-6（邮箱轮询、三类 process-*、执行/汇报心跳）。
# 机器 B：仅任务 7 —— deploy-crawler.ps1 + PM2 跑 worker-influencer-search.js。
#
# 更新行为：本脚本只做 git pull + npm ci。计划任务每次触发都会执行当前磁盘上的
# node 脚本，因此一般无需「重启」1-6；仅在首次或任务定义变更时设置
#   $env:REGISTER_MAXIN_SCHEDULED_TASKS = "1"
# 或手动运行 register-windows-scheduled-tasks.ps1（勿在每次发版都全量重复注册，除非要改间隔/路径）。
# =============================================================================

$Root = "C:\maxinfluencer"
if (-not (Test-Path $Root)) {
  throw "Deploy root not found: $Root"
}
Set-Location $Root

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git not found. Install Git for Windows and ensure git.exe is in PATH."
}

$nodeDir = "C:\Program Files\nodejs"
if (Test-Path $nodeDir) {
  $env:Path = "$nodeDir;$env:Path"
}

Write-Host "[deploy-worker] Fetch + pull main..."
git fetch origin
git checkout main
git pull origin main

Write-Host "[deploy-worker] npm ci..."
npm ci

if ($env:REGISTER_MAXIN_SCHEDULED_TASKS -eq "1") {
  $reg = Join-Path $Root "register-windows-scheduled-tasks.ps1"
  if (-not (Test-Path $reg)) {
    throw "register-windows-scheduled-tasks.ps1 not found: $reg"
  }
  Write-Host "[deploy-worker] Registering Windows scheduled tasks (1-6)..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reg -Root $Root
}
else {
  Write-Host "[deploy-worker] No task registration (set REGISTER_MAXIN_SCHEDULED_TASKS=1 for first-time or task-definition changes)."
}

Write-Host "[deploy-worker] Done."
