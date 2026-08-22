$ErrorActionPreference = "Continue"
foreach ($p in 9222, 9223, 9224, 9225) {
  $path = "C:\maxinfluencer\config\worker-$p.cmd"
  if (-not (Test-Path $path)) { Write-Host "MISS $path"; continue }
  $content = Get-Content $path -Raw
  $content = $content -replace 'set SEARCH_IMPORT_TASK_LOOP=false', 'set SEARCH_IMPORT_TASK_LOOP=true'
  $content = $content -replace 'set SEARCH_WORKER_SLOTS=8', 'set SEARCH_WORKER_SLOTS=4'
  Set-Content -Path $path -Value $content -Encoding ASCII
  $v1 = (Select-String -Path $path -Pattern 'SEARCH_IMPORT_TASK_LOOP' -SimpleMatch | Select-Object -First 1).Line
  $v2 = (Select-String -Path $path -Pattern 'SEARCH_WORKER_SLOTS' -SimpleMatch | Select-Object -First 1).Line
  Write-Host ("$p | " + $v1 + " | " + $v2)
}
Write-Host "CMD_UPDATE_DONE"
