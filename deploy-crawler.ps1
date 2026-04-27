$ErrorActionPreference = "Stop"

# Search crawler deploy script (Windows VM).
# Goals:
# 1) Pull/update code and dependencies.
# 2) Start and guard two CDP browser instances (9222 / 9223).
# 3) Start and guard search worker (worker-influencer-search.js).

$Root = "C:\maxinfluencer"
if (-not (Test-Path $Root)) { throw "Deploy root not found: $Root" }
Set-Location $Root

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
  # Clear stale 9222/9223 browser processes to avoid port conflicts.
  $stale = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match "chrome|msedge") -and
    ($_.CommandLine -match "remote-debugging-port=9222" -or $_.CommandLine -match "remote-debugging-port=9223")
  }
  foreach ($p in $stale) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
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
$executionOnePerTask = if ($env:CRAWLER_EXECUTION_ONE_PER_TASK) { "$($env:CRAWLER_EXECUTION_ONE_PER_TASK)" } else { "" }
$workerId = if ($env:CRAWLER_WORKER_ID) { "$($env:CRAWLER_WORKER_ID)" } else { "search-worker-$($env:COMPUTERNAME)" }
$workerHost = if ($env:CRAWLER_WORKER_HOST) { "$($env:CRAWLER_WORKER_HOST)" } else { "$($env:COMPUTERNAME)" }
$workerIp = if ($env:CRAWLER_WORKER_IP) { "$($env:CRAWLER_WORKER_IP)" } else { "" }
if ([string]::IsNullOrWhiteSpace($workerIp)) {
  try {
    $workerIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -and $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } |
      Select-Object -ExpandProperty IPAddress -First 1)
  } catch { $workerIp = "" }
}
$searchCdpEndpoint = if ($env:CRAWLER_CDP_SEARCH_ENDPOINT) { "$($env:CRAWLER_CDP_SEARCH_ENDPOINT)" } else { "http://127.0.0.1:9222" }
$enrichCdpEndpoint = if ($env:CRAWLER_CDP_ENRICH_ENDPOINT) { "$($env:CRAWLER_CDP_ENRICH_ENDPOINT)" } else { "http://127.0.0.1:9223" }

$chromeDir9222 = "C:\maxinfluencer\.chrome-cdp-9222"
$chromeDir9223 = "C:\maxinfluencer\.chrome-cdp-9223"
if (-not (Test-Path $chromeDir9222)) { New-Item -ItemType Directory -Path $chromeDir9222 | Out-Null }
if (-not (Test-Path $chromeDir9223)) { New-Item -ItemType Directory -Path $chromeDir9223 | Out-Null }

$isVisible = $true
if ($env:CHROME_VISIBLE) {
  $v = "$($env:CHROME_VISIBLE)".ToLowerInvariant()
  $isVisible = ($v -eq "1" -or $v -eq "true" -or $v -eq "yes" -or $v -eq "y")
}
$chromeModeArgs = if ($isVisible) { "--disable-gpu" } else { "--headless=new --disable-gpu" }
$launchUrl9222 = if ($env:CHROME_9222_URL) { "$($env:CHROME_9222_URL)" } else { "https://accounts.google.com/signin/v2/identifier?service=mail" }
$launchUrl9222Secondary = if ($env:CHROME_9222_URL_2) { "$($env:CHROME_9222_URL_2)" } else { "https://www.tiktok.com" }
$launchUrl9223 = if ($env:CHROME_9223_URL) { "$($env:CHROME_9223_URL)" } else { "https://www.tiktok.com" }

$guard9222 = Join-Path $scriptsDir "guard-chrome-9222.ps1"
$guard9223 = Join-Path $scriptsDir "guard-chrome-9223.ps1"
$guardCrawler = Join-Path $scriptsDir "guard-crawler-search.ps1"
$guardHealth = Join-Path $scriptsDir "guard-worker-health.ps1"

$guard9222Content = @"
`$ErrorActionPreference = "SilentlyContinue"
`$chrome = "$($chromeExe.Replace("\", "\\"))"
`$args = "$chromeModeArgs --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=$($chromeDir9222.Replace("\", "\\")) --no-first-run --no-default-browser-check $launchUrl9222 $launchUrl9222Secondary"
while (`$true) {
  `$mine = Get-CimInstance Win32_Process | Where-Object {
    (`$_.Name -match "chrome|msedge") -and
    (`$_.CommandLine -match "remote-debugging-port=9222")
  }
  if (-not `$mine) { Start-Process -FilePath `$chrome -ArgumentList `$args | Out-Null }
  Start-Sleep -Seconds 8
}
"@

$guard9223Content = @"
`$ErrorActionPreference = "SilentlyContinue"
`$chrome = "$($chromeExe.Replace("\", "\\"))"
`$args = "$chromeModeArgs --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --user-data-dir=$($chromeDir9223.Replace("\", "\\")) --no-first-run --no-default-browser-check $launchUrl9223"
while (`$true) {
  `$mine = Get-CimInstance Win32_Process | Where-Object {
    (`$_.Name -match "chrome|msedge") -and
    (`$_.CommandLine -match "remote-debugging-port=9223")
  }
  if (-not `$mine) { Start-Process -FilePath `$chrome -ArgumentList `$args | Out-Null }
  Start-Sleep -Seconds 8
}
"@

$guardCrawlerContent = @"
`$ErrorActionPreference = "SilentlyContinue"
`$node = "$($nodeExe.Replace("\", "\\"))"
`$script = "$($workerScript.Replace("\", "\\"))"
`$env:REDIS_URL = "$($redisUrl.Replace("\", "\\").Replace('"','\"'))"
`$env:WORK_LIVE_CHANNEL_PREFIX = "$($workLiveChannelPrefix.Replace("\", "\\").Replace('"','\"'))"
`$env:WORK_LIVE_PUSH_URL = ""
`$env:WORK_LIVE_PUSH_SECRET = ""
`$env:EXECUTION_ONE_PER_TASK = "$($executionOnePerTask.Replace("\", "\\").Replace('"','\"'))"
`$env:SEARCH_WORKER_ID = "$($workerId.Replace("\", "\\").Replace('"','\"'))"
`$env:SEARCH_WORKER_HOST = "$($workerHost.Replace("\", "\\").Replace('"','\"'))"
`$env:SEARCH_WORKER_IP = "$($workerIp.Replace("\", "\\").Replace('"','\"'))"
`$env:CDP_ENDPOINT = "$($searchCdpEndpoint.Replace("\", "\\").Replace('"','\"'))"
`$env:CDP_ENDPOINT_ENRICH = "$($enrichCdpEndpoint.Replace("\", "\\").Replace('"','\"'))"
while (`$true) {
  `$p = Get-CimInstance Win32_Process | Where-Object { `$_.Name -eq "node.exe" -and `$_.CommandLine -match "worker-influencer-search\.js" }
  if (-not `$p) {
    Start-Process -FilePath `$node -ArgumentList "--experimental-default-type=module", "`$script" -WorkingDirectory "$($Root.Replace("\", "\\"))" -WindowStyle Hidden | Out-Null
  }
  Start-Sleep -Seconds 8
}
"@

$healthScript = Join-Path $Root "scripts\worker-health-heartbeat.js"
$guardHealthContent = @"
`$ErrorActionPreference = "SilentlyContinue"
`$node = "$($nodeExe.Replace("\", "\\"))"
`$script = "$($healthScript.Replace("\", "\\"))"
`$env:SEARCH_WORKER_ID = "$($workerId.Replace("\", "\\").Replace('"','\"'))"
`$env:SEARCH_WORKER_HOST = "$($workerHost.Replace("\", "\\").Replace('"','\"'))"
`$env:SEARCH_WORKER_IP = "$($workerIp.Replace("\", "\\").Replace('"','\"'))"
`$env:WORKER_HEALTH_INTERVAL_MS = "30000"
while (`$true) {
  `$p = Get-CimInstance Win32_Process | Where-Object { `$_.Name -eq "node.exe" -and `$_.CommandLine -match "worker-health-heartbeat\.js" }
  if (-not `$p) {
    Start-Process -FilePath `$node -ArgumentList "--experimental-default-type=module", "`$script" -WorkingDirectory "$($Root.Replace("\", "\\"))" -WindowStyle Hidden | Out-Null
  }
  Start-Sleep -Seconds 8
}
"@

Set-Content -Path $guard9222 -Value $guard9222Content -Encoding ASCII
Set-Content -Path $guard9223 -Value $guard9223Content -Encoding ASCII
Set-Content -Path $guardCrawler -Value $guardCrawlerContent -Encoding ASCII
Set-Content -Path $guardHealth -Value $guardHealthContent -Encoding ASCII

Stop-StaleCdpBrowsers
Ensure-Schtask -TaskName "maxin-guard-chrome-9222" -ScriptPath $guard9222
Ensure-Schtask -TaskName "maxin-guard-chrome-9223" -ScriptPath $guard9223
Ensure-Schtask -TaskName "maxin-guard-crawler-search" -ScriptPath $guardCrawler
Ensure-Schtask -TaskName "maxin-guard-worker-health" -ScriptPath $guardHealth

Start-Sleep -Seconds 4
$ok9222 = Test-Cdp -Port 9222
$ok9223 = Test-Cdp -Port 9223
$crawlerProcess = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "worker-influencer-search\.js" }

Write-Host "[deploy-crawler] CDP 9222: $ok9222"
Write-Host "[deploy-crawler] CDP 9223: $ok9223"
Write-Host "[deploy-crawler] Crawler process count: $($crawlerProcess.Count)"
if (-not $ok9222 -or -not $ok9223) {
  Write-Warning "CDP health check failed (9222=$ok9222, 9223=$ok9223). Guard tasks will keep trying; you may need to login/verify Chrome profile or switch CHROME_VISIBLE=1 for troubleshooting."
}
if (-not $crawlerProcess) {
  Write-Warning "Crawler process not detected yet. Guard task will keep trying to start it."
}
Write-Host "[deploy-crawler] Done."
