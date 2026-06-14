# 将青果全球 HTTP 隧道接入 Clash Verge Rev（152.32.252.45）
# 用法: .\configure-qg-tunnel-proxy.ps1 -AuthKey O9QJT6VG -AuthPwd 76B9A79198D4
param(
  [Parameter(Mandatory = $true)][string]$AuthKey,
  [Parameter(Mandatory = $true)][string]$AuthPwd,
  [string]$TunnelHost = "overseas-us.tunnel.qg.net",
  [int]$TunnelPort = 16364,
  [string]$ProxyName = "QgTunnel-IG",
  [string]$Channel = "ig9222",
  [int]$StickySeconds = 600
)

$ErrorActionPreference = "Stop"
$ConfigDir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$YamlPath = Join-Path $ConfigDir "clash-verge.yaml"
$ProfilesYaml = Join-Path $ConfigDir "profiles.yaml"
$MergePath = Join-Path $ConfigDir "profiles\QgTunnelMerge.yaml"
$MergeUid = "QgTunnelMerge"

if (-not (Test-Path $YamlPath)) {
  throw "未找到 clash-verge.yaml: $YamlPath"
}

$Username = "$AuthKey-S-$Channel-T-$StickySeconds"
$ProxyYaml = @"
- name: $ProxyName
  type: http
  server: $TunnelHost
  port: $TunnelPort
  username: "$Username"
  password: "$AuthPwd"
"@

$MergeContent = @"
# 青果隧道 Merge（订阅刷新后仍保留）
prepend-proxies:
$ProxyYaml

prepend-rules:
- DOMAIN-SUFFIX,instagram.com,$ProxyName
- DOMAIN-SUFFIX,cdninstagram.com,$ProxyName
- DOMAIN-KEYWORD,instagram,$ProxyName
- DOMAIN-SUFFIX,tiktok.com,$ProxyName
- DOMAIN-SUFFIX,tiktokcdn.com,$ProxyName
- DOMAIN-SUFFIX,tiktokv.com,$ProxyName
- DOMAIN-SUFFIX,youtube.com,$ProxyName
- DOMAIN-SUFFIX,googlevideo.com,$ProxyName
- DOMAIN-SUFFIX,ytimg.com,$ProxyName

mode: rule
tun:
  enable: false
"@

Set-Content -Path $MergePath -Value $MergeContent -Encoding UTF8
Write-Host "[qg] 已写入 Merge: $MergePath"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $YamlPath "$YamlPath.bak-$stamp" -Force

$content = [System.IO.File]::ReadAllText($YamlPath)
$content = [System.Text.RegularExpressions.Regex]::Replace($content, "(?m)^mode: direct\s*$", "mode: rule")

if ($content -notmatch [regex]::Escape($ProxyName)) {
  $content = [System.Text.RegularExpressions.Regex]::Replace(
    $content,
    "(?m)^proxies:\s*$",
    "proxies:`r`n$ProxyYaml"
  )
}

$groupNeedle = "- name: 🔰国外流量"
$proxyLine = "  - $ProxyName"
if ($content.Contains($groupNeedle) -and $content -notmatch [regex]::Escape($proxyLine)) {
  $content = [System.Text.RegularExpressions.Regex]::Replace(
    $content,
    "(- name: 🔰国外流量\s+type: select\s+proxies:\s*)",
    "`$1$proxyLine`r`n"
  )
}

[System.IO.File]::WriteAllText($YamlPath, $content)
Write-Host "[qg] 已更新 clash-verge.yaml (mode=rule, proxy=$ProxyName)"

# 更新已存在的 QgTunnel 节点地址（旧配置迁移）
$content = [System.IO.File]::ReadAllText($YamlPath)
$content = [System.Text.RegularExpressions.Regex]::Replace(
  $content,
  '(?ms)(- name: QgTunnel-IG\s+type: http\s+server: )[^\r\n]+',
  "`${1}$TunnelHost"
)
$content = [System.Text.RegularExpressions.Regex]::Replace(
  $content,
  '(?ms)(- name: QgTunnel-IG\s+type: http\s+server: [^\r\n]+\s+port: )\d+',
  "`${1}$TunnelPort"
)
$content = $content -replace 'overseas\.tunnel\.qg\.net', $TunnelHost
$content = [System.Text.RegularExpressions.Regex]::Replace(
  $content,
  '(?ms)(- name: QgTunnel-IG\s+type: http\s+server: [^\r\n]+\s+port: )15561',
  "`${1}$TunnelPort"
)
[System.IO.File]::WriteAllText($YamlPath, $content)
Write-Host "[qg] 节点地址 -> ${TunnelHost}:${TunnelPort}"

# 关闭 TUN，避免无管理员权限时 verge-mihomo 崩溃
$content = [System.IO.File]::ReadAllText($YamlPath)
$content = [System.Text.RegularExpressions.Regex]::Replace(
  $content,
  '(?ms)(^tun:\s*\r?\n(?:  .*\r?\n)*?  enable: )true',
  '${1}false'
)
[System.IO.File]::WriteAllText($YamlPath, $content)
Write-Host "[qg] 已关闭 tun.enable"

$igRules = @(
  "- DOMAIN-SUFFIX,instagram.com,$ProxyName",
  "- DOMAIN-SUFFIX,cdninstagram.com,$ProxyName",
  "- DOMAIN-KEYWORD,instagram,$ProxyName"
)
$rulesBlock = ($igRules -join "`r`n")
if ($content -notmatch "DOMAIN-SUFFIX,instagram.com,$ProxyName") {
  $content = [System.IO.File]::ReadAllText($YamlPath)
  $content = [System.Text.RegularExpressions.Regex]::Replace(
    $content,
    "(?m)^rules:\s*$",
    "rules:`r`n$rulesBlock"
  )
  [System.IO.File]::WriteAllText($YamlPath, $content)
  Write-Host "[qg] 已添加 Instagram 专用规则 -> $ProxyName"
}

if (Test-Path $ProfilesYaml) {
  $py = [System.IO.File]::ReadAllText($ProfilesYaml)
  if ($py -match "uid: rIzpylWSvSRI") {
    if ($py -notmatch "uid: $MergeUid") {
      $mergeItem = @"

- uid: $MergeUid
  type: merge
  name: QgTunnelMerge
  file: QgTunnelMerge.yaml
  updated: $([int][double]::Parse((Get-Date -UFormat %s)))
"@
      $py = $py + $mergeItem
    }
    $py = [System.Text.RegularExpressions.Regex]::Replace(
      $py,
      "(?ms)(uid: rIzpylWSvSRI.*?option:\s*\r?\n\s*update_interval:.*?\r?\n\s*allow_auto_update:.*?\r?\n\s*)merge: null",
      "`$1merge: $MergeUid"
    )
    $py = [System.Text.RegularExpressions.Regex]::Replace(
      $py,
      "(?ms)- name: 🔰国外流量\s+now: .+",
      "- name: 🔰国外流量`r`n    now: $ProxyName"
    )
    [System.IO.File]::WriteAllText($ProfilesYaml, $py)
    Write-Host "[qg] 已关联 Merge 并选中 $ProxyName"
  }
}

Get-Process verge-mihomo -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Start-Process -FilePath "C:\Program Files\Clash Verge\verge-mihomo.exe" -ArgumentList @(
  "-f", $YamlPath,
  "-d", $ConfigDir
) -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 6

Write-Host "[qg] 测试 Instagram（经 127.0.0.1:7897）..."
$ig = curl.exe -sI --max-time 25 -x http://127.0.0.1:7897 https://www.instagram.com/ 2>&1
Write-Host $ig
if ($ig -match "HTTP/1\.1 200" -or $ig -match "HTTP/2 200") {
  Write-Host "[qg] Instagram 可达"
  exit 0
}
Write-Host "[qg] Instagram 仍不可达，请检查青果套餐/节点或在 Clash Verge 手动选中 $ProxyName"
exit 1
