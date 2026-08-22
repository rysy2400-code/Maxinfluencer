$ErrorActionPreference = "Continue"
$target = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'worker-9225\.cmd' } |
  Select-Object -First 1
if ($target) {
  Write-Host ("cmd pid=" + $target.ProcessId)
  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $target.ProcessId }
  foreach ($p in $children) {
    Write-Host ("child " + $p.Name + " pid=" + $p.ProcessId)
    if ($p.Name -eq 'node.exe') { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  }
} else {
  Write-Host "9225 worker cmd not found"
}
Start-Sleep -Seconds 2
Write-Host "KILL_9225_DONE"
