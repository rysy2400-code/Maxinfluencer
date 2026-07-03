param(
  [int]$Port = 9222,
  [switch]$Quiet
)

function Write-Log([string]$Message) {
  if (-not $Quiet) { Write-Host $Message }
}

$endpoint = "http://127.0.0.1:$Port"
try {
  $tabs = @(Invoke-RestMethod "$endpoint/json/list" -TimeoutSec 5)
} catch {
  Write-Log "[purge-denied] port=$Port unavailable: $($_.Exception.Message)"
  exit 1
}

$denied = @(
  $tabs | Where-Object {
    $_.type -eq "page" -and [string]$_.title -match "Access Denied"
  }
)

$closed = 0
foreach ($d in $denied) {
  try {
    Invoke-RestMethod "$endpoint/json/close/$($d.id)" -TimeoutSec 5 | Out-Null
    $closed += 1
    Write-Log "[purge-denied] port=$Port closed Access Denied id=$($d.id)"
  } catch {
    # ignore close failures
  }
}

if ($closed -gt 0) {
  Start-Sleep -Milliseconds 400
  try {
    $tabsAfter = @(Invoke-RestMethod "$endpoint/json/list" -TimeoutSec 5)
    $goodTt = @(
      $tabsAfter | Where-Object {
        $_.type -eq "page" -and
        [string]$_.url -match "^https://www\.tiktok\.com/?(\?|$)" -and
        [string]$_.title -notmatch "Access Denied"
      }
    )
    if ($goodTt.Count -eq 0) {
      Write-Log "[purge-denied] port=$Port warning: no healthy tiktok.com tab after purge"
      exit 2
    }
  } catch {
    # ignore recheck failures
  }
}

exit 0
