param(
  [int]$TaskId = 59491,
  [int]$PollSec = 15,
  [int]$MaxWaitMin = 20
)

$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"
Set-Location $Root

Write-Host "[observe] taskId=$TaskId ensure worker guard running..."
schtasks.exe /Run /TN "maxin-guard-crawler-search" 2>$null | Out-Null
Start-Sleep -Seconds 3

$worker = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search" }
Write-Host "[observe] worker_count=$($worker.Count)"

$deadline = (Get-Date).AddMinutes($MaxWaitMin)
$lastStatus = ""

while ((Get-Date) -lt $deadline) {
  $out = & node --experimental-default-type=module -e @"
import { queryTikTok } from './lib/db/mysql-tiktok.js';
const rows = await queryTikTok(
  \`SELECT id, keyword, status, worker_ip, worker_id,
          progress_search_found_count, progress_profile_browsed_count,
          progress_analyzed_count, progress_recommended_count,
          progress_contactable_count, LEFT(error_message,180) err,
          started_at, finished_at, updated_at
   FROM tiktok_influencer_search_task WHERE id=? LIMIT 1\`,
  ['$TaskId']
);
console.log(JSON.stringify(rows?.[0] ?? null));
"@ 2>&1

  $line = ($out | Select-Object -Last 1)
  if ($line -and $line -ne $lastStatus) {
    Write-Host "[observe] $(Get-Date -Format 'HH:mm:ss') $line"
    $lastStatus = $line
  }

  try {
    $j = $line | ConvertFrom-Json
    if ($j.status -in @('succeeded', 'failed', 'cancelled')) {
      Write-Host "[observe] terminal status=$($j.status)"
      if ($j.status -eq 'succeeded') { exit 0 }
      exit 1
    }
  } catch {}

  Start-Sleep -Seconds $PollSec
}

Write-Host "[observe] timeout after ${MaxWaitMin}m"
exit 2
