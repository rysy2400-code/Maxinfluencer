$ErrorActionPreference = "Stop"
$ConfigDir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$YamlPath = Join-Path $ConfigDir "clash-verge.yaml"
$MergePath = Join-Path $ConfigDir "profiles\QgTunnelMerge.yaml"
$BakPath = Join-Path $ConfigDir "clash-verge.yaml.bak-20260615-022306"
$ProxyName = "QgTunnel-TikTok"
$utf8 = New-Object System.Text.UTF8Encoding $false

$content = [System.IO.File]::ReadAllText($BakPath)
$content = $content.Replace("overseas.tunnel.qg.net", "overseas-us.tunnel.qg.net")
$content = $content.Replace("port: 15561", "port: 16364")
$content = $content.Replace("QgTunnel-IG", $ProxyName)
$extraRules = @(
  "- DOMAIN-SUFFIX,tiktok.com,$ProxyName",
  "- DOMAIN-SUFFIX,tiktokcdn.com,$ProxyName",
  "- DOMAIN-SUFFIX,tiktokv.com,$ProxyName"
)
foreach ($r in $extraRules) {
  if (-not $content.Contains($r)) {
    $content = $content.Replace("rules:`r`n", "rules:`r`n$r`r`n")
    $content = $content.Replace("rules:`n", "rules:`n$r`n")
  }
}

[System.IO.File]::WriteAllText($YamlPath, $content, $utf8)

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

$mihomo = "C:\Program Files\Clash Verge\verge-mihomo.exe"
& $mihomo -t -f $YamlPath 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { exit 1 }

Get-Process verge-mihomo, clash-verge -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 2
Start-Process $mihomo -ArgumentList @("-f", $YamlPath, "-d", $ConfigDir) -WindowStyle Hidden
Start-Sleep -Seconds 8
Write-Host READY
