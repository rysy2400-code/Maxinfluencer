param(
  [int]$Port = 9222,
  [int]$KeepMax = 2
)

$endpoint = "http://127.0.0.1:$Port"
try {
  $tabs = @(Invoke-RestMethod "$endpoint/json/list" -TimeoutSec 8)
} catch {
  Write-Host "[trim-cdp] port=$Port unavailable: $($_.Exception.Message)"
  exit 1
}

$pages = @($tabs | Where-Object { $_.type -eq "page" })
$deniedClosed = 0
foreach ($p in @($pages | Where-Object { [string]$_.title -match "Access Denied" })) {
  try {
    Invoke-RestMethod "$endpoint/json/close/$($p.id)" -TimeoutSec 5 | Out-Null
    $deniedClosed += 1
  } catch {
    # ignore
  }
}
if ($deniedClosed -gt 0) {
  $pages = @(
    Invoke-RestMethod "$endpoint/json/list" -TimeoutSec 8 |
      Where-Object { $_.type -eq "page" }
  )
}
if ($pages.Count -le $KeepMax) {
  Write-Host "[trim-cdp] port=$Port pages=$($pages.Count) ok deniedClosed=$deniedClosed"
  exit 0
}

function Rank-Url($url) {
  $u = [string]$url
  if ($u -match "^https://www\.tiktok\.com/?(\?|$)") { return 0 }
  if ($u -match "tiktok\.com" -and $u -notmatch "/api/") { return 1 }
  return 9
}

$ranked = $pages | Sort-Object { Rank-Url $_.url }, { $_.url }
$keep = @($ranked | Select-Object -First $KeepMax)
$keepIds = @($keep | ForEach-Object { $_.id })
$closed = 0

foreach ($p in $pages) {
  if ($keepIds -contains $p.id) { continue }
  try {
    Invoke-RestMethod "$endpoint/json/close/$($p.id)" -TimeoutSec 5 | Out-Null
    $closed += 1
  } catch {
    # ignore
  }
}

Write-Host "[trim-cdp] port=$Port closed=$closed kept=$($keepIds.Count) remaining=$($pages.Count - $closed)"
exit 0
