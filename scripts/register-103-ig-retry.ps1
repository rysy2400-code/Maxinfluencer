# Register an IG-only retry that runs every 2 hours until the rate limit clears.
# The worker skips creators that already have analysis data, so repeats are cheap.
$Root = "C:\maxinfluencer"
$runner = Join-Path $Root "scripts\run-comment-analysis-batch1.ps1"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -All -Platform instagram" `
  -WorkingDirectory $Root
$start = (Get-Date).AddMinutes(90)
$trigger = New-ScheduledTaskTrigger -Once -At $start `
  -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration ([TimeSpan]::FromDays(30))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName "maxin-comment-ig-retry" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output ("registered: maxin-comment-ig-retry  first run at " + $start.ToString("yyyy-MM-dd HH:mm"))
Write-Output ("   command: run-comment-analysis-batch1.ps1 -All -Platform instagram")
