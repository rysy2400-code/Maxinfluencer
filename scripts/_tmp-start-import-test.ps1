$ErrorActionPreference = "Continue"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'C:\maxinfluencer\config\worker-9225-import-test.cmd' }
Write-Host ("import worker pid=" + $r.ProcessId)
Start-Sleep -Seconds 8
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'worker-influencer-search' } |
  Select-Object ProcessId,CreationDate,ParentProcessId | Format-Table -AutoSize
Write-Host "START_IMPORT_DONE"
