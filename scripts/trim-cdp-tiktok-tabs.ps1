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

foreach ($p in @($pages)) {
  if ([string]$p.title -match "Access Denied") {
    try {
      Invoke-RestMethod "$endpoint/json/close/$($p.id)" -TimeoutSec 5 | Out-Null
      Write-Host "[trim-cdp] port=$Port closed Access Denied id=$($p.id)"
    } catch {}
  }
}

Start-Sleep -Milliseconds 300
try {
  $tabs = @(Invoke-RestMethod "$endpoint/json/list" -TimeoutSec 8)
  $pages = @($tabs | Where-Object { $_.type -eq "page" })
} catch {
  Write-Host "[trim-cdp] port=$Port unavailable after purge: $($_.Exception.Message)"
  exit 1
}

if ($pages.Count -le $KeepMax) {
  Write-Host "[trim-cdp] port=$Port pages=$($pages.Count) ok"
  exit 0
}

function Rank-Url($url) {
  $u = [string]$url
  if ($u -match "^https://www\.tiktok\.com/?(\?|$)" -and $u -notmatch "errors\.edgesuite") { return 0 }
  if ($u -match "tiktok\.com" -and $u -notmatch "/api/" -and $u -notmatch "errors\.edgesuite") { return 1 }
  return 9
}

function Rank-Title($title) {
  $t = [string]$title
  if ($t -match "Access Denied") { return 99 }
  return 0
}

$ranked = $pages | Sort-Object { Rank-Title $_.title }, { Rank-Url $_.url }, { $_.url }
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
