# 爬虫机 worker 身份：每次 guard 启动 worker 前从本机解析公网/LAN IP。
# 避免从其它机器制作的镜像重装后仍沿用旧 SEARCH_WORKER_IP。

function Resolve-CrawlerPublicIpFromIpip {
  param([int]$MaxAttempts = 3)
  $lastErr = $null
  for ($i = 1; $i -le $MaxAttempts; $i++) {
    try {
      try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
      $resp = Invoke-WebRequest -UseBasicParsing -Uri "https://myip.ipip.net" -TimeoutSec 8
      if (-not $resp -or [int]$resp.StatusCode -ne 200) {
        throw "http_status=$($resp.StatusCode)"
      }
      $body = [string]$resp.Content
      if ($body -match '(\d{1,3}(?:\.\d{1,3}){3})') {
        return @{
          Ok = $true
          Ip = $matches[1]
          Attempts = $i
          Error = $null
        }
      }
      throw "unparseable_response=$body"
    } catch {
      $lastErr = $_.Exception.Message
      if ($i -lt $MaxAttempts) { Start-Sleep -Seconds $i }
    }
  }
  return @{
    Ok = $false
    Ip = ""
    Attempts = $MaxAttempts
    Error = $lastErr
  }
}

function Get-CrawlerWorkerLanIp {
  if ($env:CRAWLER_WORKER_LAN_IP) {
    $v = "$($env:CRAWLER_WORKER_LAN_IP)".Trim()
    if ($v) { return $v }
  }
  try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -and
        $_.IPAddress -ne "127.0.0.1" -and
        $_.PrefixOrigin -ne "WellKnown"
      } |
      Select-Object -ExpandProperty IPAddress -First 1
    if ($ip) { return [string]$ip }
  } catch {}
  return ""
}

function Resolve-CrawlerWorkerPublicIp {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [int]$MaxAttempts = 3,
    [switch]$AllowCacheFallback
  )
  if ($env:CRAWLER_FORCE_WORKER_IP -match '^(1|true|yes|y)$' -and $env:SEARCH_WORKER_IP) {
    $forced = "$($env:SEARCH_WORKER_IP)".Trim()
    if ($forced -match '^\d{1,3}(?:\.\d{1,3}){3}$') {
      return @{ Ip = $forced; Source = "env:SEARCH_WORKER_IP(forced)" }
    }
  }

  $ipCacheFile = Join-Path $ProjectRoot ".last_worker_ip"
  $ipRes = Resolve-CrawlerPublicIpFromIpip -MaxAttempts $MaxAttempts
  if ($ipRes.Ok -and -not [string]::IsNullOrWhiteSpace($ipRes.Ip)) {
    $ip = [string]$ipRes.Ip
    if (Test-Path $ipCacheFile) {
      try {
        $cached = (Get-Content -Path $ipCacheFile -Raw -ErrorAction Stop).Trim()
        if ($cached -and $cached -ne $ip) {
          Write-Host "[crawler-identity] public ip changed: $cached -> $ip"
        }
      } catch {}
    }
    try { Set-Content -Path $ipCacheFile -Value $ip -Encoding ASCII } catch {}
    return @{ Ip = $ip; Source = "myip.ipip.net" }
  }

  if ($AllowCacheFallback -and (Test-Path $ipCacheFile)) {
    try {
      $cached = (Get-Content -Path $ipCacheFile -Raw -ErrorAction Stop).Trim()
      if ($cached -match '^\d{1,3}(?:\.\d{1,3}){3}$') {
        Write-Warning "[crawler-identity] myip failed ($($ipRes.Error)); using cache $cached (re-deploy after network is up if this machine was cloned from an image)"
        return @{ Ip = $cached; Source = "cache" }
      }
    } catch {}
  }

  $lan = Get-CrawlerWorkerLanIp
  if ($lan) {
    Write-Warning "[crawler-identity] myip failed ($($ipRes.Error)); fallback to lan ip=$lan"
    return @{ Ip = $lan; Source = "lan" }
  }

  throw "Could not resolve crawler worker public IP (myip error: $($ipRes.Error))"
}

function Set-CrawlerWorkerProcessEnv {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [int]$MaxAttempts = 3,
    [switch]$AllowCacheFallback
  )
  $resolved = Resolve-CrawlerWorkerPublicIp -ProjectRoot $ProjectRoot -MaxAttempts $MaxAttempts -AllowCacheFallback:$AllowCacheFallback
  $lan = Get-CrawlerWorkerLanIp
  $hostName = if ($env:CRAWLER_WORKER_HOST) { "$($env:CRAWLER_WORKER_HOST)".Trim() } else { "$env:COMPUTERNAME" }
  if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = "unknown-host" }

  $workerId = if ($env:CRAWLER_WORKER_ID) {
    "$($env:CRAWLER_WORKER_ID)".Trim()
  } else {
    "search-worker-$hostName"
  }

  $env:SEARCH_WORKER_IP = $resolved.Ip
  $env:SEARCH_WORKER_HOST = $hostName
  $env:SEARCH_WORKER_LAN_IP = $lan
  $env:SEARCH_WORKER_ID = $workerId

  return @{
    PublicIp = $resolved.Ip
    Source = $resolved.Source
    Host = $hostName
    LanIp = $lan
    WorkerId = $workerId
  }
}

function Test-CrawlerWorkerNeedsRestart {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedPublicIp
  )
  $marker = Join-Path $ProjectRoot ".worker_runtime_ip"
  if (-not (Test-Path $marker)) { return $true }
  try {
    $stored = (Get-Content -Path $marker -Raw -ErrorAction Stop).Trim()
    return ($stored -ne $ExpectedPublicIp)
  } catch {
    return $true
  }
}

function Write-CrawlerWorkerRuntimeMarker {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$PublicIp
  )
  $marker = Join-Path $ProjectRoot ".worker_runtime_ip"
  try { Set-Content -Path $marker -Value $PublicIp -Encoding ASCII } catch {}
}
