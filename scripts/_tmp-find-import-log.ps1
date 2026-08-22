$ErrorActionPreference = "Continue"
foreach ($p in 9222, 9223, 9224, 9225) {
  $path = "C:\maxinfluencer\logs\worker-$p.log"
  $lines = Get-Content $path | Select-String -Pattern "task=83|process-import-task|resolveImportTiktokFirstVideos" -SimpleMatch
  $count = @($lines).Count
  Write-Host ("===== $p hit=$count")
  $lines | Select-Object -Last 4 | ForEach-Object { Write-Host $_.Line }
}
