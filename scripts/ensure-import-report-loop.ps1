# 控制面（152.32.216.107）上确保导入完成汇报只由本机运行：
# 1) 注册计划任务 Maxinfluencer-ImportReport（每分钟跑一次一次性扫描 run-import-report-once.mjs）；
# 2) 立即执行一次扫描；
# 3) 删除 PM2 版 maxin-import-report（该机 PM2 daemon 随 SSH 会话结束被回收，不能作为常驻依赖）。
# 幂等：Register-ScheduledTask -Force 覆盖同名任务，重复执行不会叠加。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-import-report-loop.ps1

$ErrorActionPreference = "Stop"

$Root = "C:\maxinfluencer"
if (-not (Test-Path $Root)) { throw "Deploy root not found: $Root" }
Set-Location $Root

$nodeExe = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $nodeExe)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeExe = $cmd.Source } else { throw "Node.js not found." }
}

$onceScript = Join-Path $Root "scripts\run-import-report-once.mjs"
if (-not (Test-Path $onceScript)) { throw "missing $onceScript" }

# 1) 注册计划任务（每分钟一次；MultipleInstances IgnoreNew 防止重叠）
$taskName = "Maxinfluencer-ImportReport"
$arg = '/c ""' + $nodeExe + '" --experimental-default-type=module scripts\run-import-report-once.mjs"'
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $arg -WorkingDirectory $Root
$start = (Get-Date).AddMinutes(1)
$trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::FromDays(3650))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "[ensure-import-report-loop] registered $taskName (every 1 min)"

# 2) 立即执行一次扫描
Write-Host "[ensure-import-report-loop] run one-shot scan..."
& $nodeExe --experimental-default-type=module $onceScript

# 3) 移除 PM2 版汇报进程，确保唯一汇报者是上面的计划任务
if (Get-Command pm2 -ErrorAction SilentlyContinue) {
  Write-Host "[ensure-import-report-loop] pm2 delete maxin-import-report (remove dual reporter)..."
  try { & pm2 delete maxin-import-report | Out-Null } catch {}
  try { & pm2 save | Out-Null } catch {}
}

Write-Host "[ensure-import-report-loop] Done."
