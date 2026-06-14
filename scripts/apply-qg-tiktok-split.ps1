# TikTok -> QgTunnel-TikTok; Instagram/YouTube -> DIRECT
$ErrorActionPreference = "Stop"
$ProxyName = "QgTunnel-TikTok"
$ConfigDir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$YamlPath = Join-Path $ConfigDir "clash-verge.yaml"
$MergePath = Join-Path $ConfigDir "profiles\QgTunnelMerge.yaml"
$ProfilesPath = Join-Path $ConfigDir "profiles.yaml"
$utf8 = New-Object System.Text.UTF8Encoding $false

$merge = @"
prepend-proxies:
- name: $ProxyName
  type: http
  server: overseas-us.tunnel.qg.net
  port: 16364
  username: "O9QJT6VG-S-tiktok9222-T-600"
  password: "76B9A79198D4"

prepend-rules:
- DOMAIN-SUFFIX,tiktok.com,$ProxyName
- DOMAIN-SUFFIX,tiktokcdn.com,$ProxyName
- DOMAIN-SUFFIX,tiktokv.com,$ProxyName
- DOMAIN-SUFFIX,instagram.com,DIRECT
- DOMAIN-SUFFIX,cdninstagram.com,DIRECT
- DOMAIN-KEYWORD,instagram,DIRECT
- DOMAIN-SUFFIX,youtube.com,DIRECT
- DOMAIN-SUFFIX,googlevideo.com,DIRECT
- DOMAIN-SUFFIX,ytimg.com,DIRECT

mode: rule
tun:
  enable: false
"@
[System.IO.File]::WriteAllText($MergePath, $merge, $utf8)
Write-Host "[apply] merge -> $MergePath"

if (-not (Test-Path $YamlPath)) {
  throw "missing $YamlPath"
}

$content = [System.IO.File]::ReadAllText($YamlPath)
$content = $content.Replace("QgTunnel-IG", $ProxyName)
$content = $content.Replace("overseas.tunnel.qg.net", "overseas-us.tunnel.qg.net")
$content = $content.Replace("port: 15561", "port: 16364")

$toDirect = @(
  "DOMAIN-SUFFIX,instagram.com,$ProxyName",
  "DOMAIN-SUFFIX,cdninstagram.com,$ProxyName",
  "DOMAIN-KEYWORD,instagram,$ProxyName",
  "DOMAIN-SUFFIX,youtube.com,$ProxyName",
  "DOMAIN-SUFFIX,googlevideo.com,$ProxyName",
  "DOMAIN-SUFFIX,ytimg.com,$ProxyName"
)
foreach ($k in $toDirect) {
  $content = $content.Replace("- $k", "- $($k.Replace($ProxyName,'DIRECT'))")
}

$tiktokRules = @(
  "- DOMAIN-SUFFIX,tiktok.com,$ProxyName",
  "- DOMAIN-SUFFIX,tiktokcdn.com,$ProxyName",
  "- DOMAIN-SUFFIX,tiktokv.com,$ProxyName"
)
foreach ($r in $tiktokRules) {
  if (-not $content.Contains($r)) {
    $content = $content.Replace("rules:`r`n", "rules:`r`n$r`r`n")
    $content = $content.Replace("rules:`n", "rules:`n$r`n")
  }
}

# upsert proxy block name/server/port
$content = [regex]::Replace(
  $content,
  '(?ms)- name: QgTunnel-TikTok\s+type: http\s+server: [^\r\n]+\s+port: \d+\s+username: "[^"]*"\s+password: "[^"]*"',
  @"
- name: QgTunnel-TikTok
  type: http
  server: overseas-us.tunnel.qg.net
  port: 16364
  username: "O9QJT6VG-S-tiktok9222-T-600"
  password: "76B9A79198D4"
"@.Trim()
)

[System.IO.File]::WriteAllText($YamlPath, $content, $utf8)
Write-Host "[apply] yaml patched"

if (Test-Path $ProfilesPath) {
  $py = [System.IO.File]::ReadAllText($ProfilesPath)
  $py = $py.Replace("now: QgTunnel-IG", "now: $ProxyName")
  [System.IO.File]::WriteAllText($ProfilesPath, $py, $utf8)
}

$mihomo = "C:\Program Files\Clash Verge\verge-mihomo.exe"
& $mihomo -t -f $YamlPath 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "[apply] yaml valid"

Get-Process verge-mihomo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process $mihomo -ArgumentList @("-f", $YamlPath, "-d", $ConfigDir) -WindowStyle Hidden
Start-Sleep -Seconds 6

# restart GUI so 代理 page reloads merge
$clashGui = "C:\Program Files\Clash Verge\clash-verge.exe"
if (Test-Path $clashGui) {
  Get-Process clash-verge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-Process $clashGui -WindowStyle Minimized
  Start-Sleep -Seconds 10
}

Write-Host "[apply] done"
