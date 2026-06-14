$ErrorActionPreference = "Continue"
Write-Host "=== verify QgTunnel-TikTok ==="

$merge = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev\profiles\QgTunnelMerge.yaml"
$yaml = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev\clash-verge.yaml"

Write-Host "[merge]"
Get-Content $merge | Select-Object -First 22 | ForEach-Object { Write-Host "  $_" }

Write-Host "[yaml proxy]"
Select-String -Path $yaml -Pattern "QgTunnel-TikTok|QgTunnel-IG" | Select-Object -First 8 | ForEach-Object { Write-Host "  $($_.Line.Trim())" }

Write-Host "[7897]"
$listen = netstat -an | Select-String "127.0.0.1:7897.*LISTENING"
if ($listen) { Write-Host "  LISTENING" } else { Write-Host "  NOT_LISTENING" }

Write-Host "[processes]"
Get-Process verge-mihomo, clash-verge -EA SilentlyContinue | ForEach-Object { Write-Host "  $($_.Name) pid=$($_.Id)" }

# clash external API (verge default 9097)
$ports = @(9097, 9090)
foreach ($p in $ports) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:${p}/proxies" -TimeoutSec 5
    $names = $r.proxies.PSObject.Properties.Name
    $hit = $names | Where-Object { $_ -like "*QgTunnel*" }
    if ($hit) {
      Write-Host "[api :$p] proxy names:"
      $hit | ForEach-Object { Write-Host "  $_" }
      exit 0
    }
  } catch {
    Write-Host "[api :$p] unavailable"
  }
}

if (Select-String -Path $yaml -Pattern "name: QgTunnel-TikTok" -Quiet) {
  Write-Host "[fallback] yaml contains QgTunnel-TikTok"
  exit 0
}
Write-Host "[fail] QgTunnel-TikTok not found"
exit 1
