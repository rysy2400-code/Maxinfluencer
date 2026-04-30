$ErrorActionPreference = "Stop"

# =============================================================================
# 机器 A：仅清单 1-6（邮箱轮询、三类 process-*、执行/汇报心跳）。
# 机器 B：仅任务 7 —— deploy-crawler.ps1 + PM2 跑 worker-influencer-search.js。
#
# 更新行为：本脚本只做 git pull + npm ci。计划任务每次触发都会执行当前磁盘上的
# node 脚本，因此一般无需「重启」1-6；仅在首次或任务定义变更时设置
#   $env:REGISTER_MAXIN_SCHEDULED_TASKS = "1"（强制重注册）
# 本版本已改为：自动比较 register-windows-scheduled-tasks.ps1 的 SHA256；只有脚本内容变更时才重注册。
# =============================================================================

$Root = "C:\maxinfluencer"
if (-not (Test-Path $Root)) {
  throw "Deploy root not found: $Root"
}
Set-Location $Root

$deployWorkerSelfPath = Join-Path $Root "deploy-worker.ps1"
$deployWorkerSelfHashAtStart = $null
if (Test-Path $deployWorkerSelfPath) {
  $deployWorkerSelfHashAtStart = (Get-FileHash -Algorithm SHA256 -Path $deployWorkerSelfPath).Hash
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git not found. Install Git for Windows and ensure git.exe is in PATH."
}

$nodeDir = "C:\Program Files\nodejs"
if (Test-Path $nodeDir) {
  $env:Path = "$nodeDir;$env:Path"
}

# 非交互 SSH / LocalSystem 等会话常缺少 npm 全局目录，导致找不到 pm2.cmd
$npmRoaming = Join-Path $env:APPDATA "npm"
if (Test-Path $npmRoaming) {
  $env:Path = "$npmRoaming;$env:Path"
}
try {
  $npmGlobalBin = ([string](& npm bin -g 2>$null)).Trim()
  if ($npmGlobalBin -and (Test-Path $npmGlobalBin)) {
    $env:Path = "$npmGlobalBin;$env:Path"
  }
}
catch {}

Write-Host "[deploy-worker] Fetch + pull main..."
git fetch origin
git checkout main
git pull origin main

$deployWorkerSelfHashAfterPull = $null
if (Test-Path $deployWorkerSelfPath) {
  $deployWorkerSelfHashAfterPull = (Get-FileHash -Algorithm SHA256 -Path $deployWorkerSelfPath).Hash
}
if ($deployWorkerSelfHashAtStart -and $deployWorkerSelfHashAfterPull -and ($deployWorkerSelfHashAtStart -ne $deployWorkerSelfHashAfterPull)) {
  Write-Host "[deploy-worker] deploy-worker.ps1 changed after git pull; re-invoking so new logic runs..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $deployWorkerSelfPath
  exit $LASTEXITCODE
}

Write-Host "[deploy-worker] npm ci..."
npm ci

$reg = Join-Path $Root "register-windows-scheduled-tasks.ps1"
if (-not (Test-Path $reg)) {
  throw "register-windows-scheduled-tasks.ps1 not found: $reg"
}

$forceRegister = $false
if ($env:REGISTER_MAXIN_SCHEDULED_TASKS -eq "1") {
  $forceRegister = $true
}

$markerFile = Join-Path $Root ".maxin_scheduled_tasks_register_sha256.txt"
$newHash = (Get-FileHash -Algorithm SHA256 -Path $reg).Hash
$oldHash = $null
if (Test-Path $markerFile) {
  $oldHash = (Get-Content -Path $markerFile -Raw).Trim()
}

if ($forceRegister -or -not $oldHash -or ($oldHash -ne $newHash)) {
  Write-Host "[deploy-worker] Scheduled tasks definition changed (or first-time); registering 1-6..."
  Write-Host "[deploy-worker] SHA256: old=$oldHash new=$newHash"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reg -Root $Root
  Set-Content -Path $markerFile -Value $newHash -Encoding UTF8
}
else {
  Write-Host "[deploy-worker] Scheduled tasks definition unchanged; skip task registration."
}

# -----------------------------------------------------------------------------
# 控制面（216 Windows）：crawler-health-checker — 校验 node/pm2、写入 .env.local、
# PM2 幂等：仅一条名为 crawler-health-checker 的进程；不存在则创建（含 cron），存在则 reload；pm2 save。
# 重复部署不会叠加多条 PM2 任务或第二个 cron（同一 app name 覆盖）。
# -----------------------------------------------------------------------------
function Merge-EnvLocalLine {
  param(
    [string]$EnvLocalPath,
    [string]$Key,
    [string]$Value
  )
  if ([string]::IsNullOrWhiteSpace($Key)) { return }
  if ($null -eq $Value) { return }
  $dir = Split-Path -Parent $EnvLocalPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $lines = @()
  if (Test-Path $EnvLocalPath) {
    $lines = @(Get-Content -Path $EnvLocalPath -ErrorAction SilentlyContinue)
  }
  $escaped = [regex]::Escape($Key)
  $pattern = "^\s*$escaped\s*="
  $found = $false
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line -match $pattern) {
      $found = $true
      [void]$out.Add("$Key=$Value")
    }
    else {
      [void]$out.Add($line)
    }
  }
  if (-not $found) {
    [void]$out.Add("$Key=$Value")
  }
  Set-Content -Path $EnvLocalPath -Value $out.ToArray() -Encoding UTF8
}

function Test-Pm2ProcessByName {
  param([string]$Name)
  try {
    $raw = & pm2 jlist 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $apps = $raw | ConvertFrom-Json
    foreach ($a in $apps) {
      if ($a.name -eq $Name) { return $true }
    }
  }
  catch { return $false }
  return $false
}

Write-Host "[deploy-worker] Crawler health checker (PM2)..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node not found in PATH after PATH update. Install Node.js (e.g. under C:\Program Files\nodejs)."
}
Write-Host "[deploy-worker] node $(node -v)"

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  throw "pm2 not found in PATH. Install: npm i -g pm2"
}
Write-Host "[deploy-worker] pm2 $(pm2 -v)"

$envLocalPath = Join-Path $Root ".env.local"
$defaultSshKey = "C:/ProgramData/ssh/maxin_crawler_key"
$sshKeyPath = if ($env:CRAWLER_SSH_KEY_PATH) { $env:CRAWLER_SSH_KEY_PATH.Trim() } elseif ($env:DEPLOY_CRAWLER_SSH_KEY_PATH) { $env:DEPLOY_CRAWLER_SSH_KEY_PATH.Trim() } else { $defaultSshKey }
Merge-EnvLocalLine -EnvLocalPath $envLocalPath -Key "CRAWLER_SSH_KEY_PATH" -Value $sshKeyPath

if ($env:CRAWLER_SSH_USER) {
  Merge-EnvLocalLine -EnvLocalPath $envLocalPath -Key "CRAWLER_SSH_USER" -Value $env:CRAWLER_SSH_USER.Trim()
}
if ($env:CRAWLER_SSH_PORT) {
  Merge-EnvLocalLine -EnvLocalPath $envLocalPath -Key "CRAWLER_SSH_PORT" -Value $env:CRAWLER_SSH_PORT.Trim()
}
if ($env:CRAWLER_WHITELIST_IPS) {
  Merge-EnvLocalLine -EnvLocalPath $envLocalPath -Key "CRAWLER_WHITELIST_IPS" -Value $env:CRAWLER_WHITELIST_IPS.Trim()
}
if ($env:CRAWLER_WHITELIST_HOSTS) {
  Merge-EnvLocalLine -EnvLocalPath $envLocalPath -Key "CRAWLER_WHITELIST_HOSTS" -Value $env:CRAWLER_WHITELIST_HOSTS.Trim()
}

$hcName = "crawler-health-checker"
$hcScript = Join-Path $Root "scripts\crawler-health-checker.js"
if (-not (Test-Path $hcScript)) {
  Write-Host "[deploy-worker] WARN: missing $hcScript — skip PM2 $hcName."
}
else {
  $exists = Test-Pm2ProcessByName -Name $hcName
  if (-not $exists) {
    Write-Host "[deploy-worker] pm2 start $hcName (cron */1 * * * *, no-autorestart)..."
    & pm2 start $hcScript `
      --name $hcName `
      --cwd $Root `
      --interpreter node `
      --interpreter-args "--experimental-default-type=module" `
      --no-autorestart `
      --cron-restart "*/1 * * * *"
  }
  else {
    Write-Host "[deploy-worker] pm2 reload $hcName --update-env..."
    & pm2 reload $hcName --update-env
  }
  & pm2 save
}

Write-Host "[deploy-worker] Done."
