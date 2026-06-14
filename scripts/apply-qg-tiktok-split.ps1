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

# 爬虫机请优先用 ensure-clash-qg-tiktok.ps1（独立 mihomo 配置，不依赖 Verge merge）。
$ensure = Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\ensure-clash-qg-tiktok.ps1"
if (Test-Path $ensure) {
  Write-Host "[apply] delegating to ensure-clash-qg-tiktok.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ensure
  exit $LASTEXITCODE
}

Write-Host "[apply] merge/yaml updated; run ensure-clash-qg-tiktok.ps1 on crawler VMs"
Write-Host "[apply] done"
