# Keep exactly one worker-influencer-search.js process (guard will respawn if zero).
$ErrorActionPreference = "SilentlyContinue"
$procs = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search\.js"
})
Write-Host "[trim-search-workers] before=$($procs.Count)"
foreach ($p in $procs) {
  try { Stop-Process -Id $p.ProcessId -Force } catch {}
}
Start-Sleep -Seconds 12
$after = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search\.js"
})
if ($after.Count -gt 1) {
  $keep = $after | Sort-Object CreationDate -Descending | Select-Object -First 1
  foreach ($p in $after) {
    if ($p.ProcessId -ne $keep.ProcessId) {
      try { Stop-Process -Id $p.ProcessId -Force } catch {}
    }
  }
  Start-Sleep -Seconds 3
  $after = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search\.js"
  })
}
Write-Host "[trim-search-workers] after=$($after.Count)"
if ($after.Count -eq 1) {
  Write-Host "[trim-search-workers] pid=$($after[0].ProcessId)"
}
if ($after.Count -gt 1) { exit 1 }
if ($after.Count -eq 0) {
  Write-Host "[trim-search-workers] waiting for guard to start worker..."
  Start-Sleep -Seconds 10
  $final = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search\.js"
  })
  Write-Host "[trim-search-workers] final=$($final.Count)"
  if ($final.Count -ne 1) { exit 1 }
}
