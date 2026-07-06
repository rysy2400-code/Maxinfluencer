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
    $_.type -eq "page" -and (
      [string]$_.title -match "Access Denied" -or
      [string]$_.url -match "errors\.edgesuite\.net"
    )
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

function Get-HealthyTikTokTabs {
  param([array]$TabList)
  return @(
    $TabList | Where-Object {
      $_.type -eq "page" -and
      [string]$_.url -match "^https://www\.tiktok\.com/?(\?|$)" -and
      [string]$_.title -notmatch "Access Denied"
    }
  )
}

if ($closed -gt 0) {
  Start-Sleep -Milliseconds 600
}

try {
  $tabsAfter = @(Invoke-RestMethod "$endpoint/json/list" -TimeoutSec 5)
  $goodTt = @(Get-HealthyTikTokTabs -TabList $tabsAfter)
  if ($goodTt.Count -eq 0) {
    Write-Log "[purge-denied] port=$Port no healthy tiktok.com tab; opening new tab..."
    try {
      $bust = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $newUrl = "https://www.tiktok.com/?_purge=$bust"
      $encoded = [uri]::EscapeDataString($newUrl)
      Invoke-RestMethod -Method Put -Uri "$endpoint/json/new?$encoded" -TimeoutSec 15 | Out-Null
      Start-Sleep -Seconds 3
      $tabsAfter = @(Invoke-RestMethod "$endpoint/json/list" -TimeoutSec 5)
      $goodTt = @(Get-HealthyTikTokTabs -TabList $tabsAfter)
    } catch {
      Write-Log "[purge-denied] port=$Port open new tab failed: $($_.Exception.Message)"
    }
  }
  if ($goodTt.Count -eq 0) {
    Write-Log "[purge-denied] port=$Port warning: still no healthy tiktok.com tab after purge"
    exit 2
  }
  Write-Log "[purge-denied] port=$Port healthy_tabs=$($goodTt.Count)"
} catch {
  # ignore recheck failures
}

exit 0
