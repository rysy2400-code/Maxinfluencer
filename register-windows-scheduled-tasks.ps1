# 在机器 A 上注册清单 1-6 对应的 Windows 计划任务（需管理员 PowerShell 时更稳妥）。
# 用法：在仓库根目录执行：
#   powershell -ExecutionPolicy Bypass -File .\register-windows-scheduled-tasks.ps1
# 或通过 deploy-worker.ps1 设置环境变量 REGISTER_MAXIN_SCHEDULED_TASKS=1 后一并执行。
#
# 日常发版：只跑 deploy-worker.ps1（git + npm ci）即可，不必重复执行本脚本——计划任务
# 每次触发都会运行当前工作目录下的脚本，无需为「应用新代码」而重启任务。

param(
  [string]$Root = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = "Stop"

$nodeExe = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $nodeExe)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeExe = $cmd.Source } else { throw "Node.js not found." }
}

if (-not (Test-Path $Root)) { throw "Root not found: $Root" }

function Register-MaxinNodeRepeatMinutes {
  param(
    [string]$Name,
    [string]$ScriptRelative,
    [int]$Minutes
  )
  $taskName = "Maxinfluencer-$Name"
  # Windows（Node 20+）：含 import 的 .js 在未声明 type:module 时会被当 CJS。
  # 本仓库 worker 机已验证可用：node --experimental-default-type=module <script.js>
  # （动态 import 的 node-import.mjs 仍会把子 .js 当 CJS，故不用 loader。）
  $arg = "--experimental-default-type=module $ScriptRelative"
  $action = New-ScheduledTaskAction -Execute $nodeExe -Argument $arg -WorkingDirectory $Root
  $start = (Get-Date).AddMinutes(1)
  $trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes $Minutes) -RepetitionDuration ([TimeSpan]::FromDays(3650))
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "[register-tasks] Registered: $taskName (every $Minutes min) -> $ScriptRelative"
}

Write-Host "[register-tasks] Root=$Root Node=$nodeExe"

Register-MaxinNodeRepeatMinutes -Name "PollInfluencerReplies" -ScriptRelative "scripts\poll-influencer-replies.js" -Minutes 1
Register-MaxinNodeRepeatMinutes -Name "ProcessInfluencerEmailEvents" -ScriptRelative "scripts\process-influencer-email-events.js" -Minutes 1
Register-MaxinNodeRepeatMinutes -Name "ProcessInfluencerAgentEvents" -ScriptRelative "scripts\process-influencer-agent-events.js" -Minutes 1
Register-MaxinNodeRepeatMinutes -Name "ProcessCampaignAgentEvents" -ScriptRelative "scripts\process-campaign-agent-events.js" -Minutes 1
Register-MaxinNodeRepeatMinutes -Name "RunExecutionHeartbeat" -ScriptRelative "scripts\run-execution-heartbeat.js" -Minutes 1
Register-MaxinNodeRepeatMinutes -Name "RunReportHeartbeat" -ScriptRelative "scripts\run-report-heartbeat.js" -Minutes 10

Write-Host "[register-tasks] Done (6 tasks)."
