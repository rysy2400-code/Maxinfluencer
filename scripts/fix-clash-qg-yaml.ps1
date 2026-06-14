param(
  [string]$AuthKey = "O9QJT6VG",
  [string]$AuthPwd = "76B9A79198D4",
  [string]$TunnelHost = "overseas-us.tunnel.qg.net",
  [int]$TunnelPort = 16364,
  [string]$ProxyName = "QgTunnel-IG"
)

$ErrorActionPreference = "Stop"
$ConfigDir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$YamlPath = Join-Path $ConfigDir "clash-verge.yaml"
$MergePath = Join-Path $ConfigDir "profiles\QgTunnelMerge.yaml"
$Username = "$AuthKey-S-ig9222-T-600"

# restore clean backup if main yaml contains broken prepend-* blocks in body
$content = Get-Content $YamlPath -Raw
if ($content -match "prepend-proxies:" -or $content -match "prepend-rules:") {
  $bak = Get-ChildItem $ConfigDir -Filter "clash-verge.yaml.bak-*" |
    Where-Object { (Get-Content $_.FullName -Raw) -notmatch "prepend-proxies:" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($bak) {
    Copy-Item $bak.FullName $YamlPath -Force
    Write-Host "[fix] restored from $($bak.Name)"
  }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $YamlPath "$YamlPath.bak-fix-$stamp" -Force

$content = Get-Content $YamlPath -Raw
$content = [regex]::Replace($content, "(?m)^mode: direct\s*$", "mode: rule")
$content = [regex]::Replace(
  $content,
  '(?ms)(^tun:\s*\r?\n(?:  .*\r?\n)*?  enable: )true',
  '${1}false'
)

# remove garbled duplicate qg proxy entries (non-ascii name)
$content = [regex]::Replace(
  $content,
  '(?ms)- name: [^\r\n]*IG\r?\n  type: http\r?\n  server: overseas[^\r\n]*\r?\n  port: \d+\r?\n  username:[^\r\n]*\r?\n  password:[^\r\n]*\r?\n',
  ''
)

# upsert QgTunnel-IG in proxies section
$proxyBlock = @"
- name: $ProxyName
  type: http
  server: $TunnelHost
  port: $TunnelPort
  username: "$Username"
  password: "$AuthPwd"
"@

if ($content -match [regex]::Escape("- name: $ProxyName")) {
  $content = [regex]::Replace(
    $content,
    '(?ms)- name: QgTunnel-IG\r?\n  type: http\r?\n  server: [^\r\n]+\r?\n  port: \d+\r?\n  username: "[^"]*"\r?\n  password: "[^"]*"',
    $proxyBlock.TrimEnd()
  )
} else {
  $content = [regex]::Replace($content, "(?m)^proxies:\s*$", "proxies:`r`n$proxyBlock")
}

# prepend site rules once
$ruleLines = @(
  "- DOMAIN-SUFFIX,instagram.com,$ProxyName",
  "- DOMAIN-SUFFIX,cdninstagram.com,$ProxyName",
  "- DOMAIN-KEYWORD,instagram,$ProxyName",
  "- DOMAIN-SUFFIX,tiktok.com,$ProxyName",
  "- DOMAIN-SUFFIX,tiktokcdn.com,$ProxyName",
  "- DOMAIN-SUFFIX,tiktokv.com,$ProxyName",
  "- DOMAIN-SUFFIX,youtube.com,$ProxyName",
  "- DOMAIN-SUFFIX,googlevideo.com,$ProxyName",
  "- DOMAIN-SUFFIX,ytimg.com,$ProxyName"
)
foreach ($line in $ruleLines) {
  if ($content -notmatch [regex]::Escape($line)) {
    $content = [regex]::Replace($content, "(?m)^rules:\s*$", "rules:`r`n$line")
  }
}

Set-Content -Path $YamlPath -Value $content -Encoding UTF8
Write-Host "[fix] yaml updated -> ${TunnelHost}:${TunnelPort}"

$merge = @"
# Qg tunnel merge
prepend-proxies:
$proxyBlock

prepend-rules:
$(($ruleLines -join "`r`n"))

mode: rule
tun:
  enable: false
"@
Set-Content -Path $MergePath -Value $merge -Encoding UTF8
Write-Host "[fix] merge updated"

Get-Process verge-mihomo -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 2
Start-Process "C:\Program Files\Clash Verge\verge-mihomo.exe" -ArgumentList @("-f", $YamlPath, "-d", $ConfigDir) -WindowStyle Hidden
Start-Sleep -Seconds 8
Write-Host "[fix] mihomo restarted"
