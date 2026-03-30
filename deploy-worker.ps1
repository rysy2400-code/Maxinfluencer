$ErrorActionPreference = "Stop"

# =============================================================================
# 机器 A：仅清单 1-6（邮箱轮询、三类 process-*、执行/汇报心跳）。
# 机器 B：仅任务 7 —— deploy-crawler.ps1 + PM2 跑 worker-influencer-search.js。
#
# 更新行为：本脚本只做 git pull + npm ci。计划任务每次触发都会执行当前磁盘上的
# node 脚本，因此一般无需「重启」1-6；仅在首次或任务定义变更时设置
#   $env:REGISTER_MAXIN_SCHEDULED_TASKS = "1"（强制重注册）
# 本版本已改为：自动比较 register-windows-scheduled-tasks.ps1 的 SHA256；只有脚本内容变更时才重注册。
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

$reg = Join-Path $Root "register-windows-scheduled-tasks.ps1"
if (-not (Test-Path $reg)) {
  throw "register-windows-scheduled-tasks.ps1 not found: $reg"
}

$forceRegister = $false
if ($env:REGISTER_MAXIN_SCHEDULED_TASKS -eq "1") {
  $forceRegister = $true
}

$markerFile = Join-Path $Root ".maxin_scheduled_tasks_register_sha256.txt"
$newHash = (Get-FileHash -Algorithm SHA256 -Path $reg).Hash
$oldHash = $null
if (Test-Path $markerFile) {
  $oldHash = (Get-Content -Path $markerFile -Raw).Trim()
}

if ($forceRegister -or -not $oldHash -or ($oldHash -ne $newHash)) {
  Write-Host "[deploy-worker] Scheduled tasks definition changed (or first-time); registering 1-6..."
  Write-Host "[deploy-worker] SHA256: old=$oldHash new=$newHash"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reg -Root $Root
  Set-Content -Path $markerFile -Value $newHash -Encoding UTF8
}
else {
  Write-Host "[deploy-worker] Scheduled tasks definition unchanged; skip task registration."
}

Write-Host "[deploy-worker] Done."
