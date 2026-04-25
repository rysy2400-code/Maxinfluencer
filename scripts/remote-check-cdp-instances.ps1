$ErrorActionPreference = "Stop"
$p22 = Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
$p23 = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue

if ($p22) { Write-Host ("CDP_9222_LISTEN pid=" + $p22.OwningProcess) } else { Write-Host "CDP_9222_NOT_LISTEN" }
if ($p23) { Write-Host ("CDP_9223_LISTEN pid=" + $p23.OwningProcess) } else { Write-Host "CDP_9223_NOT_LISTEN" }

if ($p22) {
  Get-Process -Id $p22.OwningProcess | Select-Object Id, ProcessName, StartTime
}
if ($p23) {
  Get-Process -Id $p23.OwningProcess | Select-Object Id, ProcessName, StartTime
}
