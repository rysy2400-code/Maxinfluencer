$ErrorActionPreference = "Continue"
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'C:\maxinfluencer\config\worker-9223.cmd' }
Write-Host ("9223 worker pid=" + $r.ProcessId)
Start-Sleep -Seconds 8
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'worker-influencer-search' } |
  Select-Object ProcessId,CreationDate | Format-Table -AutoSize
Write-Host "START_9225_DONE"
