# 爬虫机专用：从 Clash 订阅拉取 anytls 节点，TikTok 走非香港节点；Instagram/YouTube -> DIRECT
param(
  [string]$ProjectRoot = "C:\maxinfluencer",
  [string]$SubUrl = $env:CLASH_SUB_URL,
  [string]$PreferredNodePattern = $(if ($env:CLASH_TT_NODE_PATTERN) { $env:CLASH_TT_NODE_PATTERN } else { "8041|8031|8021|美国|日本|新加坡|us01|jp01|sg01" }),
  [int]$MixedPort = $(if ($env:CLASH_MIXED_PORT) { [int]$env:CLASH_MIXED_PORT } else { 7897 }),
  [switch]$SkipTikTokProbe
)

$ErrorActionPreference = "Stop"
$MihomoExe = "C:\Program Files\Clash Verge\verge-mihomo.exe"
$ProxyGroupName = "TikTokProxy"
$configDir = Join-Path $ProjectRoot "config"
$configPath = Join-Path $configDir "crawler-clash.yaml"
$mihomoDataDir = Join-Path $configDir "mihomo-runtime"

function Import-DotEnv {
  param([string]$Root)
  foreach ($name in @(".env", ".env.local")) {
    $path = Join-Path $Root $name
    if (-not (Test-Path -LiteralPath $path)) { continue }
    Get-Content -LiteralPath $path | ForEach-Object {
      $line = $_.Trim()
      if (-not $line -or $line.StartsWith("#")) { return }
      $idx = $line.IndexOf("=")
      if ($idx -lt 1) { return }
      $key = $line.Substring(0, $idx).Trim()
      $val = $line.Substring($idx + 1).Trim()
      if ($val.Length -ge 2) {
        $q0 = $val[0]; $qn = $val[$val.Length - 1]
        if (($q0 -eq [char]34 -and $qn -eq [char]34) -or ($q0 -eq [char]39 -and $qn -eq [char]39)) {
          $val = $val.Substring(1, $val.Length - 2)
        }
      }
      if ($key) { Set-Item -Path "Env:$key" -Value $val }
    }
  }
}

function Test-ProxyListening {
  param([int]$Port)
  return [bool](netstat -an | Select-String "127.0.0.1:$Port\s+.*LISTENING")
}

function Test-TikTokSearchViaProxy {
  param(
    [string]$Proxy = "http://127.0.0.1:7897",
    [int]$TimeoutSec = 45
  )
  $url = "https://www.tiktok.com/search/video?q=deploy_probe"
  $raw = & curl.exe -sI --http1.1 --max-time $TimeoutSec -x $Proxy $url 2>&1
  $text = ($raw | Out-String)
  if ($text -match "Location:\s*https://www\.tiktok\.com/hk/") {
    return @{ ok = $false; reason = "hk_redirect"; raw = $text }
  }
  if ($text -match "HTTP/1\.1 200 OK" -or $text -match "HTTP/2 200") {
    return @{ ok = $true; reason = "200_ok"; raw = $text }
  }
  if ($text -match "HTTP/1\.1 302" -and $text -notmatch "tiktok\.com/hk/") {
    return @{ ok = $true; reason = "302_non_hk"; raw = $text }
  }
  if ($text -match "HTTP/1\.1 200 Connection established" -and $text -match "HTTP/1\.1 200") {
    return @{ ok = $true; reason = "200_after_connect"; raw = $text }
  }
  return @{ ok = $false; reason = "unexpected_response"; raw = $text }
}

function Decode-SubBody {
  param([string]$Body)
  $trim = $Body.Trim()
  if ($trim -match "(?m)^proxies:" -or $trim -match "(?m)^mixed-port:") { return $trim }
  try {
    $bytes = [Convert]::FromBase64String($trim)
    return [Text.Encoding]::UTF8.GetString($bytes)
  } catch {
    return $trim
  }
}

function Parse-AnyTlsUri {
  param([string]$Uri)
  if ($Uri -notmatch '^anytls://([^@]+)@([^:/]+):(\d+)') { return $null }
  $password = $Matches[1]
  $server = $Matches[2]
  $port = [int]$Matches[3]

  $name = ""
  if ($Uri -match '#(.+)$') { $name = [System.Uri]::UnescapeDataString($Matches[1]) }

  $sni = $server
  if ($Uri -match '[?&]sni=([^&#]+)') { $sni = [System.Uri]::UnescapeDataString($Matches[1]) }

  $fp = "chrome"
  if ($Uri -match '[?&]fp=([^&#]+)') { $fp = $Matches[1] }

  $skipVerify = $false
  if ($Uri -match '[?&]insecure=1(?:&|$)') { $skipVerify = $true }

  if (-not $name) { $name = "$server`:$port" }
  return [PSCustomObject]@{
    name = $name
    password = $password
    server = $server
    port = $port
    sni = $sni
    fingerprint = $fp
    skipCertVerify = $skipVerify
  }
}

function Test-IsMetadataNode {
  param($Node)
  $name = "$($Node.name)"
  if ($name -match '剩余流量|距离下次|套餐到期|重置剩余|traffic|expire|reset') { return $true }
  return $false
}

function Test-IsBlockedRegionNode {
  param($Node)
  $blob = "$($Node.name)|$($Node.server)|$($Node.sni)|$($Node.port)"
  if ($blob -match '香港|台湾|hong\s*kong|taiwan|\bhk\d|🇭🇰|🇹🇼') { return $true }
  if ($Node.server -match '^hk\d' -or $Node.sni -match '^hk\d') { return $true }
  # xsus 订阅：8001=香港 8011=台湾（metadata 行也走同一端口，必须整端口排除）
  if ($Node.server -eq 'xsus.xs-us.net' -and ($Node.port -eq 8001 -or $Node.port -eq 8011)) { return $true }
  return $false
}

function Get-NodeNameScore {
  param($Node)
  if (Test-IsMetadataNode $Node) { return 0 }
  if (Test-IsBlockedRegionNode $Node) { return -1 }
  $name = "$($Node.name)|$($Node.port)"
  if ($name -match '8041|美国|us01') { return 30 }
  if ($name -match '8031|日本|jp01') { return 20 }
  if ($name -match '8021|新加坡|sg01') { return 10 }
  return 1
}

function Merge-NodesByEndpoint {
  param([array]$NodeList)
  $byKey = @{}
  foreach ($node in $NodeList) {
    $key = "$($node.server):$($node.port)"
    if (-not $byKey.ContainsKey($key)) {
      $byKey[$key] = $node
      continue
    }
    if ((Get-NodeNameScore $node) -gt (Get-NodeNameScore $byKey[$key])) {
      $byKey[$key] = $node
    }
  }
  return @($byKey.Values)
}

function Get-UniqueProxyName {
  param([string]$Base, [hashtable]$Used)
  $candidate = $Base
  $i = 2
  while ($Used.ContainsKey($candidate)) {
    $candidate = "$Base-$i"
    $i++
  }
  $Used[$candidate] = $true
  return $candidate
}

function Get-SafeProxyName {
  param($Node)
  $label = "$($Node.name)|$($Node.port)"
  if ($label -match '8041|美国|us01') { return "US-$($Node.port)" }
  if ($label -match '8031|日本|jp01') { return "JP-$($Node.port)" }
  if ($label -match '8021|新加坡|sg01') { return "SG-$($Node.port)" }
  if ($Node.server -match '^([a-z]{2}\d+)') {
    return "$($Matches[1].ToUpper())-$($Node.port)"
  }
  $base = ($Node.server -replace '[^a-zA-Z0-9._-]', '-')
  if ($base.Length -gt 32) { $base = $base.Substring(0, 32) }
  return "$base-$($Node.port)"
}

function Escape-YamlString {
  param([string]$Value)
  return ($Value -replace '"', '\"')
}

if (Test-Path $ProjectRoot) { Import-DotEnv -Root $ProjectRoot }
if (-not $SubUrl) { $SubUrl = $env:CLASH_SUB_URL }
if (-not $SubUrl) { throw "CLASH_SUB_URL is required (set in .env or -SubUrl)" }

Write-Host "[clash-sub] fetching subscription..."
$subBody = (& curl.exe -sL --max-time 60 $SubUrl 2>&1 | Out-String).Trim()
if (-not $subBody) { throw "empty subscription response" }
$decoded = Decode-SubBody -Body $subBody

$nodes = @()
foreach ($line in ($decoded -split "`r?`n")) {
  $line = $line.Trim()
  if (-not $line.StartsWith("anytls://")) { continue }
  $parsed = Parse-AnyTlsUri -Uri $line
  if ($parsed) { $nodes += $parsed }
}
if ($nodes.Count -eq 0) { throw "no anytls nodes found in subscription" }

$usable = @(
  $nodes |
    Where-Object { -not (Test-IsMetadataNode $_) -and -not (Test-IsBlockedRegionNode $_) }
)
$usable = @(Merge-NodesByEndpoint -NodeList $usable)
if ($usable.Count -eq 0) { throw "subscription has no usable non-HK/TW nodes" }

$preferred = @(
  $usable |
    Where-Object { "$($_.name)|$($_.server)|$($_.port)" -match $PreferredNodePattern }
)
if ($preferred.Count -eq 0) {
  throw "no preferred TikTok nodes matched pattern: $PreferredNodePattern (usable=$($usable.Count))"
}
$selected = $preferred
Write-Host "[clash-sub] nodes total=$($nodes.Count) usable=$($usable.Count) selected=$($selected.Count)"
foreach ($n in $selected) {
  Write-Host "[clash-sub]   pick $($n.name) -> $($n.server):$($n.port)"
}

if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir | Out-Null }
if (-not (Test-Path $mihomoDataDir)) { New-Item -ItemType Directory -Path $mihomoDataDir | Out-Null }

$usedNames = @{}
$proxyLines = New-Object System.Collections.Generic.List[string]
$groupNames = New-Object System.Collections.Generic.List[string]

foreach ($node in $selected) {
  $safeName = Get-UniqueProxyName -Base (Get-SafeProxyName $node) -Used $usedNames
  $groupNames.Add($safeName)
  $proxyLines.Add(@"
  - name: "$safeName"
    type: anytls
    server: $($node.server)
    port: $($node.port)
    password: "$($node.password)"
    sni: $($node.sni)
    client-fingerprint: $($node.fingerprint)
    skip-cert-verify: $(if ($node.skipCertVerify) { "true" } else { "false" })
"@)
}

$yaml = @"
# Auto-generated for crawler VMs. TikTok via subscription (non-HK); IG/YT direct.
mixed-port: $MixedPort
allow-lan: false
mode: rule
log-level: warning
ipv6: false
external-controller: 127.0.0.1:9090
unified-delay: true

proxies:
$($proxyLines -join "`n")

proxy-groups:
  - name: $ProxyGroupName
    type: url-test
    url: https://www.tiktok.com/search/video?q=deploy_probe
    interval: 300
    tolerance: 50
    proxies:
$(($groupNames | ForEach-Object { "      - `"$_`"" }) -join "`n")

rules:
  - DOMAIN-SUFFIX,tiktok.com,$ProxyGroupName
  - DOMAIN-SUFFIX,tiktokcdn.com,$ProxyGroupName
  - DOMAIN-SUFFIX,tiktokv.com,$ProxyGroupName
  - DOMAIN-SUFFIX,byteoversea.com,$ProxyGroupName
  - DOMAIN-SUFFIX,musical.ly,$ProxyGroupName
  - DOMAIN-SUFFIX,ibytedtos.com,$ProxyGroupName
  - DOMAIN-SUFFIX,ibyteimg.com,$ProxyGroupName
  - DOMAIN-SUFFIX,instagram.com,DIRECT
  - DOMAIN-SUFFIX,cdninstagram.com,DIRECT
  - DOMAIN-KEYWORD,instagram,DIRECT
  - DOMAIN-SUFFIX,youtube.com,DIRECT
  - DOMAIN-SUFFIX,googlevideo.com,DIRECT
  - DOMAIN-SUFFIX,ytimg.com,DIRECT
  - DOMAIN-SUFFIX,google.com,DIRECT
  - DOMAIN-SUFFIX,gstatic.com,DIRECT
  - MATCH,DIRECT
"@

Set-Content -Path $configPath -Value $yaml -Encoding UTF8
Write-Host "[clash-sub] wrote $configPath"

if (-not (Test-Path $MihomoExe)) {
  throw "verge-mihomo not found: $MihomoExe (install Clash Verge Rev)"
}

& $MihomoExe -t -f $configPath -d $mihomoDataDir 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host "[clash-sub] $_" }
if ($LASTEXITCODE -ne 0) { throw "crawler-clash.yaml validation failed" }

Get-Process clash-verge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "powershell.exe" -or $_.Name -eq "cmd.exe") -and
  $_.CommandLine -match "fix-clash-qg-yaml|restore-clash-qg-us|patch-clash-qg|test-proxy-sites\.cmd"
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}

Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "verge-mihomo.exe" -and $_.CommandLine -and $_.CommandLine -notmatch [regex]::Escape($configPath)
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Seconds 1

Get-Process verge-mihomo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Start-Process -FilePath $MihomoExe -ArgumentList @("-f", $configPath, "-d", $mihomoDataDir) -WindowStyle Hidden
Write-Host "[clash-sub] started verge-mihomo"

$ready = $false
for ($i = 0; $i -lt 25; $i++) {
  if (Test-ProxyListening -Port $MixedPort) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw "mixed-port $MixedPort not listening after 25s" }
Write-Host "[clash-sub] port $MixedPort LISTENING"

Start-Sleep -Seconds 3

$ig = & curl.exe -sI --http1.1 --max-time 20 https://www.instagram.com/ 2>&1 | Out-String
if ($ig -match "HTTP/1\.1 200" -or $ig -match "HTTP/2 200") {
  Write-Host "[clash-sub] Instagram DIRECT probe OK"
} else {
  Write-Warning "[clash-sub] Instagram DIRECT probe did not return 200"
}

if ($SkipTikTokProbe) {
  Write-Host "[clash-sub] SKIP_TIKTOK_PROBE"
  exit 0
}

$tt = Test-TikTokSearchViaProxy -Proxy "http://127.0.0.1:$MixedPort"
if (-not $tt.ok) {
  Write-Host "[clash-sub] TIKTOK_SEARCH_FAIL reason=$($tt.reason)"
  ($tt.raw | Out-String).Split("`n") | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" }
  exit 1
}

Write-Host "[clash-sub] TIKTOK_SEARCH_OK reason=$($tt.reason)"
exit 0
