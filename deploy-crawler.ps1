$ErrorActionPreference = "Stop"

# Search crawler deploy script (Windows VM).
# Goals:
# 1) git pull + npm ci（与仅 SSH 执行本脚本的 CI 一致，无需在 Action 里单独 pull）
# 2) Start and guard CDP browser on 9222 (9223 decommissioned; enrich uses 9222).
# 3) Start and guard search worker + worker-health-heartbeat（计划任务守护）。
#
# 若本脚本自身在 pull 后被更新，会子进程重新执行一遍（避免 PowerShell 仍跑内存里的旧脚本体）。

$Root = "C:\maxinfluencer"
if (-not (Test-Path $Root)) { throw "Deploy root not found: $Root" }
Set-Location $Root

function Import-RepoDotEnv {
  param([string]$ProjectRoot)
  foreach ($name in @(".env", ".env.local")) {
    $path = Join-Path $ProjectRoot $name
    if (-not (Test-Path -LiteralPath $path)) { continue }
    Get-Content -LiteralPath $path | ForEach-Object {
      $line = $_.Trim()
      if (-not $line -or $line.StartsWith("#")) { return }
      $idx = $line.IndexOf("=")
      if ($idx -lt 1) { return }
      $key = $line.Substring(0, $idx).Trim()
      $val = $line.Substring($idx + 1).Trim()
      if ($val.Length -ge 2) {
        $q0 = $val[0]
        $qn = $val[$val.Length - 1]
        if (($q0 -eq [char]34 -and $qn -eq [char]34) -or ($q0 -eq [char]39 -and $qn -eq [char]39)) {
          $val = $val.Substring(1, $val.Length - 2)
        }
      }
      if ($key) { Set-Item -Path "Env:$key" -Value $val }
    }
  }
}
Import-RepoDotEnv -ProjectRoot $Root

$scriptsDir = Join-Path $Root "scripts"
if (-not (Test-Path $scriptsDir)) { New-Item -ItemType Directory -Path $scriptsDir | Out-Null }

function Get-ChromeExe {
  $candidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

function Get-NodeExe {
  $candidates = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  return $null
}

function Test-Cdp {
  param([int]$Port)
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
  } catch { return $false }
}

function Stop-StaleCdpBrowsers {
  # Clear stale 9222 browser processes to avoid port conflicts.
  $stale = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "chrome|msedge") -and
    ($_.CommandLine -match "remote-debugging-port=9222")
  }
  foreach ($p in $stale) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Disable-Cdp9223Guard {
  # 9223 已下线：停止守护计划任务并清理残留 Chrome（避免空占内存）。
  $taskName = "maxin-guard-chrome-9223"
  try { Start-Process -FilePath "schtasks.exe" -ArgumentList "/End /TN `"$taskName`"" -NoNewWindow -Wait | Out-Null } catch {}
  try { Start-Process -FilePath "schtasks.exe" -ArgumentList "/Delete /F /TN `"$taskName`"" -NoNewWindow -Wait | Out-Null } catch {}
  $stale9223 = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "chrome|msedge") -and ($_.CommandLine -match "remote-debugging-port=9223")
  }
  foreach ($p in $stale9223) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
  Write-Host "[deploy-crawler] CDP 9223 decommissioned (guard removed, stale processes stopped)."
}

function Ensure-Schtask {
  param(
    [string]$TaskName,
    [string]$ScriptPath
  )
  # Run guard tasks in logged-in user session so Chrome is visible in RDP.
  # Default user is current login user; can override via CRAWLER_RUN_AS_USER.
  $runAsUser = if ($env:CRAWLER_RUN_AS_USER) { "$($env:CRAWLER_RUN_AS_USER)" } else { "$env:USERNAME" }
  if ([string]::IsNullOrWhiteSpace($runAsUser)) { $runAsUser = "Administrator" }
  $usedFallback = $false
  try {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $runAsUser
    $principal = New-ScheduledTaskPrincipal -UserId $runAsUser -LogonType InteractiveToken -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  } catch {
    $usedFallback = $true
  }

  if ($usedFallback) {
    # Fallback: create task with schtasks and bind to interactive session.
    $taskRun = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
    & schtasks.exe /Create /F /RU $runAsUser /RL HIGHEST /SC ONLOGON /TN $TaskName /TR $taskRun /IT | Out-Null
  }

  # Ensure only one instance: stop old task instance then run once.
  try { Start-Process -FilePath "schtasks.exe" -ArgumentList "/End /TN `"$TaskName`"" -NoNewWindow -Wait | Out-Null } catch {}
  Start-Process -FilePath "schtasks.exe" -ArgumentList "/Run /TN `"$TaskName`"" -NoNewWindow -Wait | Out-Null
}

function Resolve-PublicIpFromIpip {
  param([int]$MaxAttempts = 3)
  $identityScript = Join-Path $scriptsDir "crawler-worker-identity.ps1"
  if (-not (Test-Path $identityScript)) {
    throw "Missing $identityScript (run git pull on crawler VM)"
  }
  . $identityScript
  return Resolve-CrawlerPublicIpFromIpip -MaxAttempts $MaxAttempts
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git not found. Install Git for Windows and ensure git.exe is in PATH."
}

$deployCrawlerSelfPath = Join-Path $Root "deploy-crawler.ps1"
$deployCrawlerSelfHashAtStart = $null
if (Test-Path $deployCrawlerSelfPath) {
  $deployCrawlerSelfHashAtStart = (Get-FileHash -Algorithm SHA256 -Path $deployCrawlerSelfPath).Hash
}

$nodeDirForPath = "C:\Program Files\nodejs"
if (Test-Path $nodeDirForPath) {
  $env:Path = "$nodeDirForPath;$env:Path"
}

Write-Host "[deploy-crawler] Fetch + pull main..."
# Mitigate Windows Git/libcurl "getaddrinfo() thread failed to start" / flaky DNS (esp. over SSH sessions).
try {
  git config http.sslBackend schannel 2>$null | Out-Null
  git config http.version HTTP/1.1 2>$null | Out-Null
  git config core.preferIPv4 true 2>$null | Out-Null
} catch {}
git fetch origin
git checkout main
git pull origin main

$deployCrawlerSelfHashAfterPull = $null
if (Test-Path $deployCrawlerSelfPath) {
  $deployCrawlerSelfHashAfterPull = (Get-FileHash -Algorithm SHA256 -Path $deployCrawlerSelfPath).Hash
}
if ($deployCrawlerSelfHashAtStart -and $deployCrawlerSelfHashAfterPull -and ($deployCrawlerSelfHashAtStart -ne $deployCrawlerSelfHashAfterPull)) {
  Write-Host "[deploy-crawler] deploy-crawler.ps1 changed after git pull; re-invoking..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $deployCrawlerSelfPath
  exit $LASTEXITCODE
}

Write-Host "[deploy-crawler] npm ci..."
npm ci

$chromeExe = Get-ChromeExe
if (-not $chromeExe) { throw "Chrome/Edge executable not found." }
$nodeExe = Get-NodeExe
if (-not $nodeExe) { throw "Node.js executable not found." }

$workerScript = Join-Path $Root "scripts\worker-influencer-search.js"
if (-not (Test-Path $workerScript)) { throw "Worker script not found: $workerScript" }

# Work-live events channel via Redis (worker -> pub/sub -> web SSE).
$redisUrl = if ($env:CRAWLER_REDIS_URL) { "$($env:CRAWLER_REDIS_URL)" } elseif ($env:REDIS_URL) { "$($env:REDIS_URL)" } else { "" }
if ([string]::IsNullOrWhiteSpace($redisUrl)) {
  throw "REDIS_URL is required for crawler work-live events. Set CRAWLER_REDIS_URL (preferred) or REDIS_URL before deploy."
}
$workLiveChannelPrefix = if ($env:WORK_LIVE_CHANNEL_PREFIX) { "$($env:WORK_LIVE_CHANNEL_PREFIX)" } else { "work-live" }

. (Join-Path $scriptsDir "crawler-worker-identity.ps1")
$workerIdentity = Set-CrawlerWorkerProcessEnv -ProjectRoot $Root -MaxAttempts 3 -AllowCacheFallback
$workerIp = $workerIdentity.PublicIp
$workerIpSource = $workerIdentity.Source
$workerHost = $workerIdentity.Host
$workerLanIp = $workerIdentity.LanIp
$workerId = $workerIdentity.WorkerId
Write-Host "[deploy-crawler] worker_ip(source=$workerIpSource, lan=$workerLanIp, host=$workerHost) -> using=$workerIp"
$searchCdpEndpoint = if ($env:CRAWLER_CDP_SEARCH_ENDPOINT) { "$($env:CRAWLER_CDP_SEARCH_ENDPOINT)" } else { "http://127.0.0.1:9222" }
$enrichCdpEndpoint = if ($env:CRAWLER_CDP_ENRICH_ENDPOINT) { "$($env:CRAWLER_CDP_ENRICH_ENDPOINT)" } else { $searchCdpEndpoint }

# 152.32.192.65 曾用 parallel+2 slots，CDP 易超时；现与其它爬虫机一致：serial + 1 slot。
$parallelCrawlerIps = @()
if ($parallelCrawlerIps -contains $workerIp) {
  $searchWorkerSlots = "2"
  $cdp9222Mode = "parallel"
} else {
  $searchWorkerSlots = if ($env:SEARCH_WORKER_SLOTS) { "$($env:SEARCH_WORKER_SLOTS)".Trim() } else { "1" }
  $cdp9222Mode = if ($env:CDP_9222_MODE) { "$($env:CDP_9222_MODE)".Trim() } else { "serial" }
}
$cdp9222LockTimeoutMs = if ($env:CDP_9222_LOCK_TIMEOUT_MS) { "$($env:CDP_9222_LOCK_TIMEOUT_MS)".Trim() } else { "300000" }
Write-Host "[deploy-crawler] worker parallel: slots=$searchWorkerSlots cdp9222=$cdp9222Mode (ip=$workerIp)"

# 写入 guard 内嵌环境，使 worker 进程不依赖本机 .env 是否已配置
$deepseekAnalysisTimeoutMs = if ($env:DEEPSEEK_ANALYSIS_TIMEOUT_MS -and -not [string]::IsNullOrWhiteSpace("$($env:DEEPSEEK_ANALYSIS_TIMEOUT_MS)")) {
  "$($env:DEEPSEEK_ANALYSIS_TIMEOUT_MS)".Trim()
} else {
  "120000"
}
$searchTaskStuckReclaimMinutes = if ($env:SEARCH_TASK_STUCK_RECLAIM_MINUTES -and -not [string]::IsNullOrWhiteSpace("$($env:SEARCH_TASK_STUCK_RECLAIM_MINUTES)")) {
  "$($env:SEARCH_TASK_STUCK_RECLAIM_MINUTES)".Trim()
} else {
  "7"
}
Write-Host "[deploy-crawler] guard env: DEEPSEEK_ANALYSIS_TIMEOUT_MS=$deepseekAnalysisTimeoutMs, SEARCH_TASK_STUCK_RECLAIM_MINUTES=$searchTaskStuckReclaimMinutes"

$chromeDir9222 = "C:\maxinfluencer\.chrome-cdp-9222"
if (-not (Test-Path $chromeDir9222)) { New-Item -ItemType Directory -Path $chromeDir9222 | Out-Null }

$isVisible = $true
if ($env:CHROME_VISIBLE) {
  $v = "$($env:CHROME_VISIBLE)".ToLowerInvariant()
  $isVisible = ($v -eq "1" -or $v -eq "true" -or $v -eq "yes" -or $v -eq "y")
}
$chromeModeArgs = if ($isVisible) { "--disable-gpu" } else { "--headless=new --disable-gpu" }
$launchUrl9222 = if ($env:CHROME_9222_URL) { "$($env:CHROME_9222_URL)" } else { "about:blank" }

$guard9222 = Join-Path $scriptsDir "guard-chrome-9222.ps1"
$guardCrawler = Join-Path $scriptsDir "guard-crawler-search.ps1"
$guardHealth = Join-Path $scriptsDir "guard-worker-health.ps1"

$guard9222Content = @"
`$ErrorActionPreference = "SilentlyContinue"
`$chrome = "$($chromeExe.Replace("\", "\\"))"
`$args = "$chromeModeArgs --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=$($chromeDir9222.Replace("\", "\\")) --no-first-run --no-default-browser-check $launchUrl9222"
while (`$true) {
  `$mine = Get-CimInstance Win32_Process | Where-Object {
    (`$_.Name -match "chrome|msedge") -and
    (`$_.CommandLine -match "remote-debugging-port=9222")
  }
  if (-not `$mine) { Start-Process -FilePath `$chrome -ArgumentList `$args | Out-Null }
  Start-Sleep -Seconds 8
}
"@

$guardCrawlerContent = @"
`$ErrorActionPreference = "SilentlyContinue"
`$Root = "$($Root.Replace("\", "\\"))"
. (Join-Path `$Root "scripts\crawler-worker-identity.ps1")
`$node = "$($nodeExe.Replace("\", "\\"))"
`$script = "$($workerScript.Replace("\", "\\"))"
`$env:REDIS_URL = "$($redisUrl.Replace("\", "\\").Replace('"','\"'))"
`$env:WORK_LIVE_CHANNEL_PREFIX = "$($workLiveChannelPrefix.Replace("\", "\\").Replace('"','\"'))"
`$env:WORK_LIVE_PUSH_URL = ""
`$env:WORK_LIVE_PUSH_SECRET = ""
`$env:CDP_ENDPOINT = "$($searchCdpEndpoint.Replace("\", "\\").Replace('"','\"'))"
`$env:CDP_ENDPOINT_ENRICH = "$($enrichCdpEndpoint.Replace("\", "\\").Replace('"','\"'))"
`$env:SEARCH_WORKER_SLOTS = "$searchWorkerSlots"
`$env:CDP_9222_MODE = "$cdp9222Mode"
`$env:CDP_9222_LOCK_TIMEOUT_MS = "$cdp9222LockTimeoutMs"
`$env:DEEPSEEK_ANALYSIS_TIMEOUT_MS = "$deepseekAnalysisTimeoutMs"
`$env:SEARCH_TASK_STUCK_RECLAIM_MINUTES = "$searchTaskStuckReclaimMinutes"
while (`$true) {
  try {
    `$identity = Set-CrawlerWorkerProcessEnv -ProjectRoot `$Root -MaxAttempts 2 -AllowCacheFallback
  } catch {
    Start-Sleep -Seconds 8
    continue
  }
  `$all = @(Get-CimInstance Win32_Process | Where-Object { `$_.Name -eq "node.exe" -and `$_.CommandLine -match "worker-influencer-search\.js" })
  if (`$all.Count -gt 0 -and (Test-CrawlerWorkerNeedsRestart -ProjectRoot `$Root -ExpectedPublicIp `$identity.PublicIp)) {
    foreach (`$proc in `$all) {
      try { Stop-Process -Id `$proc.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
    `$all = @()
  }
  if (`$all.Count -gt 1) {
    `$keep = `$all | Sort-Object CreationDate -Descending | Select-Object -First 1
    foreach (`$proc in `$all) {
      if (`$proc.ProcessId -ne `$keep.ProcessId) {
        try { Stop-Process -Id `$proc.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
      }
    }
  } elseif (`$all.Count -eq 0) {
    Start-Process -FilePath `$node -ArgumentList "--experimental-default-type=module", "`$script" -WorkingDirectory `$Root -WindowStyle Hidden | Out-Null
    Write-CrawlerWorkerRuntimeMarker -ProjectRoot `$Root -PublicIp `$identity.PublicIp
  }
  Start-Sleep -Seconds 8
}
"@

$healthScript = Join-Path $Root "scripts\worker-health-heartbeat.js"
$guardHealthContent = @"
`$ErrorActionPreference = "SilentlyContinue"
`$Root = "$($Root.Replace("\", "\\"))"
. (Join-Path `$Root "scripts\crawler-worker-identity.ps1")
`$node = "$($nodeExe.Replace("\", "\\"))"
`$script = "$($healthScript.Replace("\", "\\"))"
`$env:WORKER_HEALTH_INTERVAL_MS = "30000"
while (`$true) {
  try {
    `$identity = Set-CrawlerWorkerProcessEnv -ProjectRoot `$Root -MaxAttempts 2 -AllowCacheFallback
  } catch {
    Start-Sleep -Seconds 8
    continue
  }
  `$p = @(Get-CimInstance Win32_Process | Where-Object { `$_.Name -eq "node.exe" -and `$_.CommandLine -match "worker-health-heartbeat\.js" })
  if (`$p.Count -gt 0 -and (Test-CrawlerWorkerNeedsRestart -ProjectRoot `$Root -ExpectedPublicIp `$identity.PublicIp)) {
    foreach (`$proc in `$p) {
      try { Stop-Process -Id `$proc.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
    `$p = @()
  }
  if (-not `$p -or `$p.Count -eq 0) {
    Start-Process -FilePath `$node -ArgumentList "--experimental-default-type=module", "`$script" -WorkingDirectory `$Root -WindowStyle Hidden | Out-Null
    Write-CrawlerWorkerRuntimeMarker -ProjectRoot `$Root -PublicIp `$identity.PublicIp
  }
  Start-Sleep -Seconds 8
}
"@

Set-Content -Path $guard9222 -Value $guard9222Content -Encoding ASCII
Set-Content -Path $guardCrawler -Value $guardCrawlerContent -Encoding ASCII
Set-Content -Path $guardHealth -Value $guardHealthContent -Encoding ASCII

# 重要：worker/health 进程在启动后不会自动继承新的 env。
# 这里强制结束旧进程，让 guard 以最新 worker_ip 重新拉起（幂等：杀完再起，不会叠多个）。
try {
  $oldHealth = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-health-heartbeat\.js" }
  foreach ($p in $oldHealth) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
} catch {}
try {
  $oldWorker = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search\.js" }
  foreach ($p in $oldWorker) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
} catch {}
try {
  Remove-Item -Path (Join-Path $Root ".worker_runtime_ip") -Force -ErrorAction SilentlyContinue
} catch {}
Write-CrawlerWorkerRuntimeMarker -ProjectRoot $Root -PublicIp $workerIp

Stop-StaleCdpBrowsers
Disable-Cdp9223Guard
Ensure-Schtask -TaskName "maxin-guard-chrome-9222" -ScriptPath $guard9222
Ensure-Schtask -TaskName "maxin-guard-crawler-search" -ScriptPath $guardCrawler
Ensure-Schtask -TaskName "maxin-guard-worker-health" -ScriptPath $guardHealth

Start-Sleep -Seconds 4
$ok9222 = Test-Cdp -Port 9222
$crawlerProcess = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search\.js" }

Write-Host "[deploy-crawler] CDP 9222: $ok9222"
Write-Host "[deploy-crawler] Crawler process count: $($crawlerProcess.Count)"
if ($crawlerProcess.Count -gt 1) {
  Write-Warning "Multiple search workers detected; guard will trim to one on next cycle."
}
if (-not $ok9222) {
  Write-Warning "CDP health check failed (9222=$ok9222). Guard tasks will keep trying; you may need to login/verify Chrome profile or switch CHROME_VISIBLE=1 for troubleshooting."
}
if (-not $crawlerProcess) {
  Write-Warning "Crawler process not detected yet. Guard task will keep trying to start it."
}
Write-Host "[deploy-crawler] Done."
