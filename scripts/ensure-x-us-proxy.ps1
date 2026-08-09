# X 专属机：为 x.com 配置美国出口 IP，其余域名直连。
# 优先模式：Clash 订阅（INS 机 ensure-ig-us-proxy.ps1 同款）——.env/.env.local 里 X_SUB_URL
#           指向订阅地址，自动解析节点、挑选美国节点、生成 config\crawler-clash.yaml。
# 兜底模式：QG 全球 HTTP 隧道（overseas-us，出口美国）——依赖 QG_AUTH_KEY、QG_AUTH_PWD。
# 说明：9222 浏览器整机走美国节点（MATCH -> XProxy），避免查 IP 站点/注册验证码等第三方域名
#       混到香港 IP（X 注册风控对 IP 一致性敏感）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-x-us-proxy.ps1
param(
  [string]$ProjectRoot = "C:\maxinfluencer",
  [string]$SubUrl = $env:X_SUB_URL,
  [string]$AuthKey = $env:QG_AUTH_KEY,
  [string]$AuthPwd = $env:QG_AUTH_PWD,
  [string]$TunnelHost = $(if ($env:QG_TUNNEL_HOST) { $env:QG_TUNNEL_HOST } else { "overseas-us.tunnel.qg.net" }),
  [int]$TunnelPort = $(if ($env:QG_TUNNEL_PORT) { [int]$env:QG_TUNNEL_PORT } else { 16364 }),
  [string]$StickySeconds = $(if ($env:QG_TUNNEL_STICKY_SEC) { $env:QG_TUNNEL_STICKY_SEC } else { "600" }),
  [int]$MixedPort = $(if ($env:CLASH_MIXED_PORT) { [int]$env:CLASH_MIXED_PORT } else { 7897 }),
  [switch]$SkipXProbe
)

$ErrorActionPreference = "Stop"
$MihomoExe = "C:\Program Files\Clash Verge\verge-mihomo.exe"
$configDir = Join-Path $ProjectRoot "config"
$configPath = Join-Path $configDir "crawler-clash.yaml"
$mihomoDataDir = Join-Path $configDir "mihomo-runtime"
$ProxyName = "QgTunnel-X"

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

Import-DotEnv -Root $ProjectRoot
if (-not $SubUrl) { $SubUrl = $env:X_SUB_URL }
if (-not $AuthKey) { $AuthKey = $env:QG_AUTH_KEY }
if (-not $AuthPwd) { $AuthPwd = $env:QG_AUTH_PWD }
if (-not $AuthKey) { $AuthKey = "O9QJT6VG" }

function Test-ProxyListening {
  param([int]$Port)
  return [bool](netstat -an | Select-String "127.0.0.1:$Port\s+.*LISTENING")
}

function Get-ExitIp {
  param([string]$Proxy = "http://127.0.0.1:$MixedPort")
  try {
    $raw = (& curl.exe -s --max-time 20 -x $Proxy "https://api.ipify.org" 2>&1 | Out-String).Trim()
    return $raw
  } catch {
    return ""
  }
}

function Test-XViaProxy {
  param([string]$Proxy = "http://127.0.0.1:$MixedPort")
  $raw = (& curl.exe -sI --http1.1 --max-time 25 -x $Proxy "https://x.com/home" 2>&1 | Out-String)
  return $raw
}

function Stop-WrongMihomo {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "verge-mihomo.exe" -and $_.CommandLine -and $_.CommandLine -notmatch [regex]::Escape($configPath)
  } | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
  # ensure 是「应用配置」入口：无论新旧进程全部重启，确保新规则生效。
  # （守护循环 guard-clash-mihomo.ps1 保持过滤式，不误杀健康实例。）
  Get-Process verge-mihomo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $MihomoExe)) {
  throw "verge-mihomo not found: $MihomoExe (install Clash Verge Rev)"
}
if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir | Out-Null }
if (-not (Test-Path $mihomoDataDir)) { New-Item -ItemType Directory -Path $mihomoDataDir | Out-Null }

# ================= 订阅模式（优先；INS 机同款） =================
if ($SubUrl) {
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
    if ($blob -match '美国|usa|united\s*states|us\d|^us[.-]') { return $true }
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

  Write-Host "[x-proxy] subscription mode (X_SUB_URL)"
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
  Write-Host "[x-proxy] nodes=$($nodes.Count) us=$($us.Count): $(($us | ForEach-Object { $_.name }) -join ', ')"

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
# Auto-generated: X via US node (subscription); everything else direct.
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
  - name: XProxy
    type: url-test
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    proxies:
$(($groupMembers | ForEach-Object { "      - `"$_`"" }) -join "`n")

rules:
  - DOMAIN-SUFFIX,x.com,XProxy
  - DOMAIN-SUFFIX,twitter.com,XProxy
  - DOMAIN-SUFFIX,t.co,XProxy
  - DOMAIN-SUFFIX,twimg.com,XProxy
  - DOMAIN-SUFFIX,abs.twimg.com,XProxy
  - DOMAIN-KEYWORD,x.com,XProxy
  - DOMAIN-SUFFIX,ipify.org,XProxy
  - MATCH,XProxy
"@
  Set-Content -Path $configPath -Value $yaml -Encoding UTF8
  Write-Host "[x-proxy] wrote $configPath"

  & $MihomoExe -t -f $configPath -d $mihomoDataDir 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host "[x-proxy] $_" }
  if ($LASTEXITCODE -ne 0) { throw "crawler-clash.yaml validation failed" }

  Stop-WrongMihomo
  Start-Sleep -Seconds 2
  Start-Process -FilePath $MihomoExe -ArgumentList @("-f", $configPath, "-d", $mihomoDataDir) -WindowStyle Hidden

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-ProxyListening -Port $MixedPort) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "mixed-port $MixedPort not listening after 30s" }

  $exitIp = Get-ExitIp
  Write-Host "[x-proxy] subscription exit_ip=$exitIp"
  if (-not $exitIp) { throw "no exit ip via proxy" }
  if ($exitIp -eq "103.218.240.130") { throw "exit still local HK IP" }
  if ($exitIp -match "^(104\.16|172\.67|1\.1\.1\.1|8\.8\.8\.8)") { throw "exit looks like CDN/echo: $exitIp" }

  if (-not $SkipXProbe) {
    $x = Test-XViaProxy
    Write-Host "[x-proxy] x.com probe: $($x.Split([Environment]::NewLine)[0])"
  }

  Write-Host "[x-proxy] OK subscription mode exit_ip=$exitIp (config=$configPath)"
  exit 0
}

# ================= QG 隧道兜底模式 =================
if (-not $AuthPwd) { throw "QG_AUTH_PWD is required (set in .env or environment) when X_SUB_URL is not set" }

# 候选 channel：优先显式指定，其次用 IG/TikTok 已验证可用的美国出口 channel
$channels = New-Object System.Collections.Generic.List[string]
if ($env:QG_TUNNEL_CHANNEL_X) { $channels.Add($env:QG_TUNNEL_CHANNEL_X) }
$channels.Add("ig9222")
$channels.Add("tiktok9222")

$used = @{}
$ok = $false
foreach ($channel in $channels) {
  if ($used.ContainsKey($channel)) { continue }
  $used[$channel] = $true
  $username = "$AuthKey-S-$channel-T-$StickySeconds"
  Write-Host "[x-proxy] trying channel=$channel user=$username"

  $yaml = @"
# Auto-generated for X crawler VM (ensure-x-us-proxy.ps1). X via QG tunnel (US exit); others direct.
mixed-port: $MixedPort
allow-lan: false
mode: rule
log-level: warning
ipv6: false
external-controller: 127.0.0.1:9090
unified-delay: true

proxies:
  - name: $ProxyName
    type: http
    server: $TunnelHost
    port: $TunnelPort
    username: "$username"
    password: "$AuthPwd"

rules:
  - DOMAIN-SUFFIX,x.com,$ProxyName
  - DOMAIN-SUFFIX,twitter.com,$ProxyName
  - DOMAIN-SUFFIX,t.co,$ProxyName
  - DOMAIN-SUFFIX,twimg.com,$ProxyName
  - DOMAIN-SUFFIX,abs.twimg.com,$ProxyName
  - DOMAIN-KEYWORD,x.com,$ProxyName
  - DOMAIN-SUFFIX,ipify.org,$ProxyName
  - MATCH,$ProxyName
"@

  Set-Content -Path $configPath -Value $yaml -Encoding UTF8
  & $MihomoExe -t -f $configPath -d $mihomoDataDir 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "[x-proxy] $_" }
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "[x-proxy] config validation failed for channel=$channel"
    continue
  }

  Stop-WrongMihomo
  Start-Sleep -Seconds 2
  Start-Process -FilePath $MihomoExe -ArgumentList @("-f", $configPath, "-d", $mihomoDataDir) -WindowStyle Hidden

  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    if (Test-ProxyListening -Port $MixedPort) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) {
    Write-Warning "[x-proxy] port $MixedPort not listening (channel=$channel)"
    continue
  }

  $exitIp = Get-ExitIp
  Write-Host "[x-proxy] channel=$channel exit_ip=$exitIp"
  if (-not $exitIp) { continue }
  # 出口必须是美国；若仍是香港/本机 IP 则换 channel
  if ($exitIp -eq "103.218.240.130") { Write-Warning "[x-proxy] exit still local HK IP, next channel"; continue }
  if ($exitIp -match "^(104\.16|172\.67|1\.1\.1\.1|8\.8\.8\.8)") { Write-Warning "[x-proxy] exit looks like CDN/echo, next channel"; continue }

  if (-not $SkipXProbe) {
    $x = Test-XViaProxy
    if ($x -notmatch "HTTP/1\.1 200|HTTP/2 200" -and $x -match "403|429|error") {
      Write-Host "[x-proxy] x.com probe: $($x.Split([Environment]::NewLine)[0])"
    }
  }

  $ok = $true
  Write-Host "[x-proxy] OK channel=$channel exit_ip=$exitIp (US exit, config=$configPath)"
  break
}

if (-not $ok) {
  Write-Host "[x-proxy] FAILED: no channel yielded a US exit"
  exit 1
}
exit 0
