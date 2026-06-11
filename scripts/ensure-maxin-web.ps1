# 确保 maxin-web 在 80 端口监听；供 Windows 计划任务定期/开机执行（SYSTEM 账户）
$ErrorActionPreference = "SilentlyContinue"

$Root = "C:\maxinfluencer"
$LogDir = Join-Path $Root "logs"
$Log = Join-Path $LogDir "ensure-maxin-web.log"
$PidFile = Join-Path $LogDir "maxin-web.pid"
$Node = "C:\Program Files\nodejs\node.exe"
$Next = Join-Path $Root "node_modules\next\dist\bin\next"
$EcosystemPath = Join-Path $Root "ecosystem.web.config.cjs"

$null = New-Item -ItemType Directory -Force -Path $LogDir

function Write-Log($msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  Add-Content -Path $Log -Value $line
}

function Test-Port80Listening {
  return [bool](netstat -ano | Select-String "0\.0\.0\.0:80\s+0\.0\.0\.0:0\s+LISTENING")
}

function Start-DetachedNextOnPort80 {
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
  $psi.Arguments = "`"$Next`" start -p 80"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables["NODE_ENV"] = "production"
  $proc = [System.Diagnostics.Process]::Start($psi)
  if ($proc) {
    $proc.Id | Out-File -FilePath $PidFile -Encoding ascii -Force
    Start-Sleep -Seconds 10
    return (Test-Port80Listening)
  }
  return $false
}

if (Test-Port80Listening) {
  exit 0
}

Write-Log "port 80 not listening, starting maxin-web..."

Set-Location $Root
$env:Path = "C:\Program Files\nodejs;C:\Users\Administrator\AppData\Roaming\npm;$env:Path"
$env:NODE_ENV = "production"
$env:PM2_HOME = "C:\Users\Administrator\.pm2"

$started = $false

# 交互式管理员会话可尝试 pm2；计划任务 SYSTEM 下 pm2 常不可用
if ((Get-Command pm2 -ErrorAction SilentlyContinue) -and (Test-Path $EcosystemPath)) {
  pm2 resurrect 2>&1 | Out-Null
  Start-Sleep -Seconds 4
  if (-not (Test-Port80Listening)) {
    pm2 start $EcosystemPath --only maxin-web --update-env 2>&1 | Out-Null
    Start-Sleep -Seconds 10
  }
  if (Test-Port80Listening) {
    pm2 save --force 2>&1 | Out-Null
    $started = $true
  }
}

if (-not $started) {
  if (Start-DetachedNextOnPort80) {
    Write-Log "maxin-web started via detached next"
    exit 0
  }
  Write-Log "failed to start maxin-web"
  exit 1
}

Write-Log "maxin-web started via pm2"
exit 0
