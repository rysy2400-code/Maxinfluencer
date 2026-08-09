# 确保 maxin-web 在目标端口监听（默认 80，可用机器环境变量 WEB_PORT 覆盖，如 3000）；
# 供 Windows 计划任务定期/开机执行（SYSTEM 账户）
$ErrorActionPreference = "SilentlyContinue"

$Root = "C:\maxinfluencer"
$LogDir = Join-Path $Root "logs"
$Log = Join-Path $LogDir "ensure-maxin-web.log"
$PidFile = Join-Path $LogDir "maxin-web.pid"
$Node = "C:\Program Files\nodejs\node.exe"
$Next = Join-Path $Root "node_modules\next\dist\bin\next"
$EcosystemPath = Join-Path $Root "ecosystem.web.config.cjs"

# 与 deploy-web.ps1 保持一致：WEB_PORT 未设置时默认 80
$WebPort = if ($env:WEB_PORT -match '^\d{1,5}$') { [int]$env:WEB_PORT } else { 80 }

$null = New-Item -ItemType Directory -Force -Path $LogDir

function Write-Log($msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  Add-Content -Path $Log -Value $line
}

function Test-PortListening {
  param([Parameter(Mandatory = $true)][int]$Port)
  return [bool](netstat -ano | Select-String "0\.0\.0\.0:$Port\s+0\.0\.0\.0:0\s+LISTENING")
}

function Start-DetachedNextOnPort {
  param([Parameter(Mandatory = $true)][int]$Port)
  if (-not (Test-Path $Node)) {
    Write-Log "node.exe not found: $Node"
    return $false
  }
  if (-not (Test-Path $Next)) {
    Write-Log "next CLI not found: $Next"
    return $false
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = "`"$Next`" start -p $Port"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables["NODE_ENV"] = "production"
  $proc = [System.Diagnostics.Process]::Start($psi)
  if ($proc) {
    $proc.Id | Out-File -FilePath $PidFile -Encoding ascii -Force
    Start-Sleep -Seconds 10
    return (Test-PortListening -Port $Port)
  }
  return $false
}

if (Test-PortListening -Port $WebPort) {
  exit 0
}

Write-Log "port $WebPort not listening, starting maxin-web..."

Set-Location $Root
$env:Path = "C:\Program Files\nodejs;C:\Users\Administrator\AppData\Roaming\npm;$env:Path"
$env:NODE_ENV = "production"
$env:PM2_HOME = "C:\Users\Administrator\.pm2"

$started = $false

# 交互式管理员会话可尝试 pm2；计划任务 SYSTEM 下 pm2 常不可用
if ((Get-Command pm2 -ErrorAction SilentlyContinue) -and (Test-Path $EcosystemPath)) {
  pm2 resurrect 2>&1 | Out-Null
  Start-Sleep -Seconds 4
  if (-not (Test-PortListening -Port $WebPort)) {
    pm2 start $EcosystemPath --only maxin-web --update-env 2>&1 | Out-Null
    Start-Sleep -Seconds 10
  }
  if (Test-PortListening -Port $WebPort) {
    pm2 save --force 2>&1 | Out-Null
    $started = $true
  }
}

if (-not $started) {
  if (Start-DetachedNextOnPort -Port $WebPort) {
    Write-Log "maxin-web started via detached next"
    exit 0
  }
  Write-Log "failed to start maxin-web"
  exit 1
}

Write-Log "maxin-web started via pm2"
exit 0
