$ErrorActionPreference = "Stop"
$ConfigDir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$YamlPath = Join-Path $ConfigDir "clash-verge.yaml"
$MergePath = Join-Path $ConfigDir "profiles\QgTunnelMerge.yaml"

$lines = [System.Collections.ArrayList]@(Get-Content $YamlPath)
$out = New-Object System.Collections.ArrayList
$skipUntilDash = $false
$inGarbled = $false

for ($i = 0; $i -lt $lines.Count; $i++) {
  $line = $lines[$i]

  if ($line -match '^prepend-proxies:' -or $line -match '^prepend-rules:') { continue }
  if ($line -match '^- DOMAIN-SUFFIX,instagram\.com,QgTunnel-IG$') {
    if ($out -notcontains $line) { [void]$out.Add($line) }
    continue
  }
  if ($line -match '^- DOMAIN-SUFFIX,cdninstagram\.com,QgTunnel-IG$') { if ($out -notcontains $line) { [void]$out.Add($line) }; continue }
  if ($line -match '^- DOMAIN-KEYWORD,instagram,QgTunnel-IG$') { if ($out -notcontains $line) { [void]$out.Add($line) }; continue }
  if ($line -match '^- DOMAIN-SUFFIX,tiktok\.com,QgTunnel-IG$') { if ($out -notcontains $line) { [void]$out.Add($line) }; continue }
  if ($line -match '^- DOMAIN-SUFFIX,tiktokcdn\.com,QgTunnel-IG$') { if ($out -notcontains $line) { [void]$out.Add($line) }; continue }
  if ($line -match '^- DOMAIN-SUFFIX,tiktokv\.com,QgTunnel-IG$') { if ($out -notcontains $line) { [void]$out.Add($line) }; continue }
  if ($line -match '^- DOMAIN-SUFFIX,youtube\.com,QgTunnel-IG$') { if ($out -notcontains $line) { [void]$out.Add($line) }; continue }
  if ($line -match '^- DOMAIN-SUFFIX,googlevideo\.com,QgTunnel-IG$') { if ($out -notcontains $line) { [void]$out.Add($line) }; continue }
  if ($line -match '^- DOMAIN-SUFFIX,ytimg\.com,QgTunnel-IG$') { if ($out -notcontains $line) { [void]$out.Add($line) }; continue }

  # skip garbled duplicate proxy block
  if ($line -match '^- name: .*IG$' -and $line -notmatch 'QgTunnel-IG') {
    $inGarbled = $true
    continue
  }
  if ($inGarbled) {
    if ($line -match '^- name: ' -or $line -match '^[a-zA-Z].*:') { $inGarbled = $false } else { continue }
  }

  if ($line -match '^  server: overseas') { $line = '  server: overseas-us.tunnel.qg.net' }
  if ($line -match '^  port: 15561') { $line = '  port: 16364' }
  if ($line -match '^mode: direct') { $line = 'mode: rule' }
  if ($line -eq '  enable: true' -and $i -gt 0 -and ($lines[($i-10)..($i-1)] -join ' ') -match 'tun:') { $line = '  enable: false' }

  [void]$out.Add($line)
}

# ensure rules after rules:
$text = ($out -join "`r`n")
$needRules = @(
  '- DOMAIN-SUFFIX,instagram.com,QgTunnel-IG',
  '- DOMAIN-SUFFIX,cdninstagram.com,QgTunnel-IG',
  '- DOMAIN-KEYWORD,instagram,QgTunnel-IG',
  '- DOMAIN-SUFFIX,tiktok.com,QgTunnel-IG',
  '- DOMAIN-SUFFIX,tiktokcdn.com,QgTunnel-IG',
  '- DOMAIN-SUFFIX,tiktokv.com,QgTunnel-IG',
  '- DOMAIN-SUFFIX,youtube.com,QgTunnel-IG',
  '- DOMAIN-SUFFIX,googlevideo.com,QgTunnel-IG',
  '- DOMAIN-SUFFIX,ytimg.com,QgTunnel-IG'
)
foreach ($r in $needRules) {
  if ($text -notmatch [regex]::Escape($r)) {
    $text = $text -replace '(?m)^rules:\s*$', "rules:`r`n$r"
  }
}

Set-Content -Path $YamlPath -Value $text -Encoding UTF8
Write-Host "[patch] yaml patched"

$merge = @"
prepend-proxies:
- name: QgTunnel-IG
  type: http
  server: overseas-us.tunnel.qg.net
  port: 16364
  username: "O9QJT6VG-S-ig9222-T-600"
  password: "76B9A79198D4"

prepend-rules:
- DOMAIN-SUFFIX,instagram.com,QgTunnel-IG
- DOMAIN-SUFFIX,cdninstagram.com,QgTunnel-IG
- DOMAIN-KEYWORD,instagram,QgTunnel-IG
- DOMAIN-SUFFIX,tiktok.com,QgTunnel-IG
- DOMAIN-SUFFIX,tiktokcdn.com,QgTunnel-IG
- DOMAIN-SUFFIX,tiktokv.com,QgTunnel-IG
- DOMAIN-SUFFIX,youtube.com,QgTunnel-IG
- DOMAIN-SUFFIX,googlevideo.com,QgTunnel-IG
- DOMAIN-SUFFIX,ytimg.com,QgTunnel-IG

mode: rule
tun:
  enable: false
"@
Set-Content -Path $MergePath -Value $merge -Encoding UTF8
Write-Host "[patch] merge patched"

Get-Process verge-mihomo, clash-verge -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 2
Start-Process "C:\Program Files\Clash Verge\verge-mihomo.exe" -ArgumentList @("-f", $YamlPath, "-d", $ConfigDir) -WindowStyle Hidden
Start-Sleep -Seconds 8
Write-Host "[patch] mihomo started"
