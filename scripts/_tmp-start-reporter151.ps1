$ErrorActionPreference = "Continue"
$cmd = 'cmd.exe /c cd /d C:\maxinfluencer && node --experimental-default-type=module scripts\_tmp-task-reporter-151.mjs >> C:\maxinfluencer\logs\task-reporter-151.out 2>&1'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
Write-Host ("reporter pid=" + $r.ProcessId)
Start-Sleep -Seconds 6
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'task-reporter-151' } |
  Select-Object ProcessId,CreationDate | Format-Table -AutoSize
