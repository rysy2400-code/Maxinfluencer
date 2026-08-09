# X 专属机：通过 QG 全球 HTTP 隧道（overseas-us，出口美国）为 x.com 配置美国 IP，
# 其余域名直连。参考 IG 专属机 ensure-ig-us-proxy.ps1 / TikTok 机 ensure-clash-qg-tiktok.ps1。
# 依赖：.env / .env.local 里 QG_AUTH_KEY、QG_AUTH_PWD（X 机镜像自带）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-x-us-proxy.ps1
param(
  [string]$ProjectRoot = "C:\maxinfluencer",
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
if (-not $AuthKey) { $AuthKey = $env:QG_AUTH_KEY }
if (-not $AuthPwd) { $AuthPwd = $env:QG_AUTH_PWD }
if (-not $AuthKey) { $AuthKey = "O9QJT6VG" }
if (-not $AuthPwd) { throw "QG_AUTH_PWD is required (set in .env or environment)" }

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
  Get-Process verge-mihomo -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $MihomoExe)) {
  throw "verge-mihomo not found: $MihomoExe (install Clash Verge Rev)"
}
if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir | Out-Null }
if (-not (Test-Path $mihomoDataDir)) { New-Item -ItemType Directory -Path $mihomoDataDir | Out-Null }

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
  - MATCH,DIRECT
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
