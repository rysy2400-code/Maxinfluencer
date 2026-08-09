# IG 专属机：拉取 Clash 订阅，选美国节点，配置 mihomo（Instagram 域名走美国节点，其余直连）。
# 依赖：.env.local 里 IG_SUB_URL（订阅地址），可选 IG_PROXY_MIXED_PORT（默认 7897）。
param(
  [string]$ProjectRoot = "C:\maxinfluencer",
  [string]$SubUrl = $env:IG_SUB_URL,
  [int]$MixedPort = 7897,
  [string]$MihomoExe = "C:\maxinfluencer\bin\mihomo.exe",
  [switch]$SkipDownload,
  [switch]$RestartAlways
)

$ErrorActionPreference = "Stop"

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
      if ($key) { Set-Item -Path "Env:$key" -Value $val }
    }
  }
}

Import-DotEnv -Root $ProjectRoot
if (-not $SubUrl) { $SubUrl = $env:IG_SUB_URL }
if (-not $SubUrl) { throw "IG_SUB_URL required (set in $ProjectRoot\.env.local)" }

$configDir = Join-Path $ProjectRoot "config"
$configPath = Join-Path $configDir "ig-us-proxy.yaml"
$mihomoDataDir = Join-Path $configDir "mihomo-ig-runtime"

function Test-ProxyListening {
  param([int]$Port)
  return [bool](netstat -an | Select-String "127.0.0.1:$Port\s+.*LISTENING")
}

function Decode-SubBody {
  param([string]$Body)
  $trim = $Body.Trim()
  if ($trim -match "(?m)^proxies:" -or $trim -match "(?m)^mixed-port:") { return $trim }
  try {
    $bytes = [Convert]::FromBase64String(($trim -replace "[\r\n ]", ""))
    return [Text.Encoding]::UTF8.GetString($bytes)
  } catch {
    return $trim
  }
}

function Parse-Query {
  param([string]$Query)
  $map = @{}
  foreach ($kv in ($Query -split "&")) {
    $p = $kv -split "=", 2
    if ($p.Count -eq 2 -and $p[0]) {
      $map[$p[0]] = [System.Uri]::UnescapeDataString($p[1])
    }
  }
  return $map
}

function Parse-NodeUri {
  param([string]$Uri)
  if ($Uri -match '^vless://([^@]+)@([^:/]+):(\d+)') {
    $uuid = $Matches[1]; $server = $Matches[2]; $port = [int]$Matches[3]
    $name = ""
    if ($Uri -match '#(.+)$') { $name = [System.Uri]::UnescapeDataString($Matches[1]) }
    $q = ($Uri -split "\?", 2)[1]; $q = ($q -split "#")[0]
    $params = Parse-Query -Query $q
    $sni = if ($params["sni"]) { $params["sni"] } else { $server }
    return [PSCustomObject]@{
      type = "vless"; name = $name; server = $server; port = $port; uuid = $uuid
      sni = $sni; fp = $(if ($params["fp"]) { $params["fp"] } else { "chrome" })
      pbk = $params["pbk"]; sid = $params["sid"]; flow = $params["flow"]
      security = $(if ($params["security"]) { $params["security"] } else { "none" })
    }
  }
  if ($Uri -match '^anytls://([^@]+)@([^:/]+):(\d+)') {
    $password = $Matches[1]; $server = $Matches[2]; $port = [int]$Matches[3]
    $name = ""
    if ($Uri -match '#(.+)$') { $name = [System.Uri]::UnescapeDataString($Matches[1]) }
    $q = ($Uri -split "\?", 2)[1]; $q = ($q -split "#")[0]
    $params = Parse-Query -Query $q
    $sni = if ($params["sni"]) { $params["sni"] } else { $server }
    return [PSCustomObject]@{
      type = "anytls"; name = $name; server = $server; port = $port; password = $password
      sni = $sni; fp = $(if ($params["fp"]) { $params["fp"] } else { "chrome" })
      skipVerify = $(if ($params["insecure"] -eq "1") { $true } else { $false })
    }
  }
  return $null
}

function Test-IsUsNode {
  param($Node)
  $blob = "$($Node.name)|$($Node.server)|$($Node.sni)"
  # 使用 \uXXXX 转义（美=\u7f8e 国=\u56fd），避免 PS5.1 按 ANSI 代码页读取无 BOM UTF-8 脚本导致中文字面量乱码
  if ($blob -match '\u7f8e\u56fd|usa|united\s*states|us\d|^us[.-]') { return $true }
  if ($Node.server -match '^(us|usa)\d') { return $true }
  return $false
}

function Get-UniqueName {
  param([string]$Base, [hashtable]$Used)
  $c = $Base
  $i = 2
  while ($Used.ContainsKey($c)) { $c = "$Base-$i"; $i++ }
  $Used[$c] = $true
  return $c
}

# ---- mihomo 二进制 ----
if (-not (Test-Path $MihomoExe) -and -not $SkipDownload) {
  Write-Host "[ig-proxy] downloading mihomo..."
  $zip = Join-Path $env:TEMP "mihomo-ig.zip"
  $url = "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.29/mihomo-windows-amd64-compatible-v1.19.29.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 300
  $extract = Join-Path $env:TEMP "mihomo-ig-extract"
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  New-Item -ItemType Directory -Path (Split-Path $MihomoExe) -Force | Out-Null
  $found = Get-ChildItem $extract -Filter "mihomo.exe" -Recurse | Select-Object -First 1
  if (-not $found) { throw "mihomo.exe not found in archive" }
  Copy-Item $found.FullName $MihomoExe -Force
  Write-Host "[ig-proxy] mihomo ready: $MihomoExe"
}
if (-not (Test-Path $MihomoExe)) { throw "mihomo binary missing: $MihomoExe" }

# ---- 拉订阅、解析、选美国节点 ----
Write-Host "[ig-proxy] fetching subscription..."
$subBody = (& curl.exe -sL --max-time 60 $SubUrl 2>&1 | Out-String).Trim()
if (-not $subBody) { throw "empty subscription response" }
$decoded = Decode-SubBody -Body $subBody
$nodes = @()
foreach ($line in ($decoded -split "`r?`n")) {
  $line = $line.Trim()
  if (-not $line) { continue }
  $n = Parse-NodeUri -Uri $line
  if ($n) { $nodes += $n }
}
if ($nodes.Count -eq 0) { throw "no parseable nodes in subscription" }
$us = @($nodes | Where-Object { Test-IsUsNode $_ })
if ($us.Count -eq 0) { throw "no US nodes found (total=$($nodes.Count))" }
Write-Host "[ig-proxy] nodes=$($nodes.Count) us=$($us.Count): $(($us | ForEach-Object { $_.name }) -join ', ')"

if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir | Out-Null }
if (-not (Test-Path $mihomoDataDir)) { New-Item -ItemType Directory -Path $mihomoDataDir | Out-Null }

$used = @{}
$proxyLines = New-Object System.Collections.Generic.List[string]
$groupMembers = New-Object System.Collections.Generic.List[string]
foreach ($n in $us) {
  $safe = Get-UniqueName -Base ("US-" + $n.port) -Used $used
  $groupMembers.Add($safe)
  if ($n.type -eq "vless") {
    $tlsLine = "    tls: true"
    $reality = ""
    if ($n.security -eq "reality" -and $n.pbk) {
      $reality = "    reality-opts:`n      public-key: `"$($n.pbk)`"`n      short-id: `"$($n.sid)`""
    }
    $proxyLines.Add(@"
  - name: "$safe"
    type: vless
    server: $($n.server)
    port: $($n.port)
    uuid: "$($n.uuid)"
    network: tcp
    udp: true
    servername: "$($n.sni)"
    client-fingerprint: $($n.fp)
    flow: $($n.flow)
$tlsLine
$reality
"@)
  } else {
    $proxyLines.Add(@"
  - name: "$safe"
    type: anytls
    server: $($n.server)
    port: $($n.port)
    password: "$($n.password)"
    sni: "$($n.sni)"
    client-fingerprint: $($n.fp)
    skip-cert-verify: $(if ($n.skipVerify) { "true" } else { "false" })
"@)
  }
}

$yaml = @"
# Auto-generated: Instagram via US node; everything else direct.
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
  - name: IGProxy
    type: url-test
    url: https://www.instagram.com/
    interval: 300
    tolerance: 50
    proxies:
$(($groupMembers | ForEach-Object { "      - `"$_`"" }) -join "`n")

rules:
  - DOMAIN-SUFFIX,instagram.com,IGProxy
  - DOMAIN-SUFFIX,cdninstagram.com,IGProxy
  - DOMAIN-SUFFIX,fbcdn.net,IGProxy
  - DOMAIN-SUFFIX,facebook.com,IGProxy
  - DOMAIN-SUFFIX,fb.com,IGProxy
  - DOMAIN-SUFFIX,fb.me,IGProxy
  - DOMAIN-SUFFIX,instagram.failover,IGProxy
  - DOMAIN-KEYWORD,instagram,IGProxy
  - MATCH,DIRECT
"@
Set-Content -Path $configPath -Value $yaml -Encoding UTF8
Write-Host "[ig-proxy] wrote $configPath"

if ((Test-ProxyListening -Port $MixedPort) -and (Test-Path $configPath) -and -not $RestartAlways) {
  Write-Host "[ig-proxy] mihomo already listening on $MixedPort, skip restart (guard mode)"
  $exitIp = (& curl.exe -s --max-time 20 -x "http://127.0.0.1:$MixedPort" "https://api.ipify.org" 2>&1 | Out-String).Trim()
  Write-Host "[ig-proxy] proxy exit ip: $exitIp"
  exit 0
}

& $MihomoExe -t -f $configPath -d $mihomoDataDir 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host "[ig-proxy] $_" }
if ($LASTEXITCODE -ne 0) { throw "ig-us-proxy.yaml validation failed" }

Get-Process mihomo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath $MihomoExe -ArgumentList @("-f", $configPath, "-d", $mihomoDataDir) -WindowStyle Hidden

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  if (Test-ProxyListening -Port $MixedPort) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw "mixed-port $MixedPort not listening after 30s" }
Write-Host "[ig-proxy] mihomo listening on 127.0.0.1:$MixedPort"

$exitIp = (& curl.exe -s --max-time 20 -x "http://127.0.0.1:$MixedPort" "https://api.ipify.org" 2>&1 | Out-String).Trim()
Write-Host "[ig-proxy] proxy exit ip: $exitIp"
