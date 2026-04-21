$ErrorActionPreference = "Stop"

# 搜索爬虫部署脚本（机器：152.32.252.45）
# 目标：
# 1) 更新代码 + 安装依赖
# 2) 启动并守护 2 个 CDP Chrome 实例（9222 / 9223）
# 3) 启动并守护搜索 Worker（worker-influencer-search.js）

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

function Ensure-Schtask {
  param(
    [string]$TaskName,
    [string]$ScriptPath
  )
  # 旧实现用 schtasks /Run 会在每次部署时重复启动无限循环脚本，导致弹出多个 PowerShell 窗口。
  # 改为 ScheduledTasks API：后台隐藏运行 + IgnoreNew（已有实例运行时不再启动新实例）。
  $usedFallback = $false
  try {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
  } catch {
    $usedFallback = $true
  }

  if ($usedFallback) {
    # 兼容某些系统 ScheduledTasks cmdlet 不可用/异常：回退 schtasks（避免复杂重定向导致解析差异）
    $taskRun = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
    $createArgs = "/Create /F /RU SYSTEM /RL HIGHEST /SC ONSTART /TN `"$TaskName`" /TR `"$taskRun`""
    Start-Process -FilePath "schtasks.exe" -ArgumentList $createArgs -NoNewWindow -Wait | Out-Null
  }

  # 确保只运行 1 个实例：先尝试结束旧实例，再启动一次（不使用 2>&1，避免某些 PowerShell 解析异常）
  try { Start-Process -FilePath "schtasks.exe" -ArgumentList "/End /TN `"$TaskName`"" -NoNewWindow -Wait | Out-Null } catch {}
  Start-Process -FilePath "schtasks.exe" -ArgumentList "/Run /TN `"$TaskName`"" -NoNewWindow -Wait | Out-Null
}

$chromeExe = Get-ChromeExe
if (-not $chromeExe) { throw "Chrome/Edge executable not found." }
$nodeExe = Get-NodeExe
if (-not $nodeExe) { throw "Node.js executable not found." }

$workerScript = Join-Path $Root "scripts\worker-influencer-search.js"
if (-not (Test-Path $workerScript)) { throw "Worker script not found: $workerScript" }

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

$guard9222Content = @"
`$ErrorActionPreference = "SilentlyContinue"
`$chrome = "$($chromeExe.Replace("\", "\\"))"
`$args = "$chromeModeArgs --remote-debugging-port=9222 --user-data-dir=$($chromeDir9222.Replace("\", "\\")) --no-first-run --no-default-browser-check $launchUrl9222 $launchUrl9222Secondary"
while (`$true) {
  try { `$ok = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3 } catch { `$ok = `$null }
  if (-not `$ok) { Start-Process -FilePath `$chrome -ArgumentList `$args | Out-Null }
  Start-Sleep -Seconds 8
}
"@

$guard9223Content = @"
`$ErrorActionPreference = "SilentlyContinue"
`$chrome = "$($chromeExe.Replace("\", "\\"))"
`$args = "$chromeModeArgs --remote-debugging-port=9223 --user-data-dir=$($chromeDir9223.Replace("\", "\\")) --no-first-run --no-default-browser-check $launchUrl9223"
while (`$true) {
  try { `$ok = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9223/json/version" -TimeoutSec 3 } catch { `$ok = `$null }
  if (-not `$ok) { Start-Process -FilePath `$chrome -ArgumentList `$args | Out-Null }
  Start-Sleep -Seconds 8
}
"@

$guardCrawlerContent = @"
`$ErrorActionPreference = "SilentlyContinue"
`$node = "$($nodeExe.Replace("\", "\\"))"
`$script = "$($workerScript.Replace("\", "\\"))"
while (`$true) {
  `$p = Get-CimInstance Win32_Process | Where-Object { `$_.Name -eq "node.exe" -and `$_.CommandLine -match "worker-influencer-search\.js" }
  if (-not `$p) {
    Start-Process -FilePath `$node -ArgumentList "--experimental-default-type=module", "`$script" -WorkingDirectory "$($Root.Replace("\", "\\"))" -WindowStyle Hidden | Out-Null
  }
  Start-Sleep -Seconds 8
}
"@

Set-Content -Path $guard9222 -Value $guard9222Content -Encoding ASCII
Set-Content -Path $guard9223 -Value $guard9223Content -Encoding ASCII
Set-Content -Path $guardCrawler -Value $guardCrawlerContent -Encoding ASCII

Ensure-Schtask -TaskName "maxin-guard-chrome-9222" -ScriptPath $guard9222
Ensure-Schtask -TaskName "maxin-guard-chrome-9223" -ScriptPath $guard9223
Ensure-Schtask -TaskName "maxin-guard-crawler-search" -ScriptPath $guardCrawler

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
