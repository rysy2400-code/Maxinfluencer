#Requires -RunAsAdministrator
<#
  Bootstrap Windows crawler VM: Git 2.47.1, Node 20.18.1, clone/pull C:\maxinfluencer, run deploy-crawler.ps1.

  Usage:
    .\bootstrap-crawler-windows-vm.ps1 -RedisUrl 'redis://host:6379'
    .\bootstrap-crawler-windows-vm.ps1 -SkipDeploy

  Optional env: MAXIN_GIT_URL (default HTTPS clone of Maxinfluencer public repo)
#>
param(
  [string]$RedisUrl = "",
  [switch]$SkipDeploy
)

$ErrorActionPreference = "Stop"

if (-not [string]::IsNullOrWhiteSpace($RedisUrl)) {
  $env:CRAWLER_REDIS_URL = $RedisUrl
}

$GitInstallerUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"
$NodeMsiUrl = "https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi"
$Root = "C:\maxinfluencer"
$GitExe = "C:\Program Files\Git\cmd\git.exe"
$NodeDir = "C:\Program Files\nodejs"

$RepoUrl = if ($env:MAXIN_GIT_URL) { "$($env:MAXIN_GIT_URL)" } else { "https://github.com/rysy2400-code/Maxinfluencer.git" }

if (-not $SkipDeploy) {
  if ([string]::IsNullOrWhiteSpace($env:CRAWLER_REDIS_URL) -and [string]::IsNullOrWhiteSpace($env:REDIS_URL)) {
    throw "Set -RedisUrl or env CRAWLER_REDIS_URL / REDIS_URL, or use -SkipDeploy for install+clone only."
  }
}

function Get-GitVersion {
  if (-not (Test-Path $GitExe)) { return $null }
  $line = & $GitExe --version 2>$null
  if ($line -match "(\d+\.\d+\.\d+)") {
    try { return [version]$matches[1] } catch { return $null }
  }
  return $null
}

function Test-GitVersionOk {
  $ver = Get-GitVersion
  if ($null -eq $ver) { return $false }
  return ($ver -ge [version]"2.47.1")
}

function Test-NodeVersionOk {
  $nodeExe = Join-Path $NodeDir "node.exe"
  if (-not (Test-Path $nodeExe)) { return $false }
  $v = & $nodeExe --version 2>$null
  return ($v -eq "v20.18.1")
}

$temp = Join-Path $env:TEMP "maxin-bootstrap"
if (-not (Test-Path $temp)) { New-Item -ItemType Directory -Path $temp | Out-Null }

if (-not (Test-GitVersionOk)) {
  Write-Host "[bootstrap] Installing Git 2.47.1 ..."
  $gitSetup = Join-Path $temp "Git-2.47.1-64-bit.exe"
  Invoke-WebRequest -Uri $GitInstallerUrl -OutFile $gitSetup -UseBasicParsing
  $p = Start-Process -FilePath $gitSetup -ArgumentList "/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES" -Wait -PassThru
  if ($null -ne $p.ExitCode -and $p.ExitCode -ne 0) {
    Write-Warning "Git installer exit code: $($p.ExitCode)"
  }
  if (-not (Test-Path $GitExe)) {
    throw "Git install failed: $GitExe not found"
  }
  $env:Path = "C:\Program Files\Git\cmd;C:\Program Files\Git\bin;" + $env:Path
} else {
  Write-Host "[bootstrap] Git already present (need >= 2.47.1): $(Get-GitVersion)"
  $env:Path = "C:\Program Files\Git\cmd;C:\Program Files\Git\bin;" + $env:Path
}

if (-not (Test-NodeVersionOk)) {
  Write-Host "[bootstrap] Installing Node.js v20.18.1 ..."
  $nodeMsi = Join-Path $temp "node-v20.18.1-x64.msi"
  Invoke-WebRequest -Uri $NodeMsiUrl -OutFile $nodeMsi -UseBasicParsing
  $p = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", $nodeMsi, "/quiet", "/norestart" -Wait -PassThru
  if ($p.ExitCode -ne 0) {
    throw "Node MSI install failed, exit=$($p.ExitCode)"
  }
  $env:Path = $NodeDir + ";" + $env:Path
} else {
  Write-Host "[bootstrap] Node v20.18.1 already present"
  $env:Path = $NodeDir + ";" + $env:Path
}

Write-Host "[bootstrap] git version: $(& $GitExe --version)"
Write-Host "[bootstrap] node version: $(& $(Join-Path $NodeDir 'node.exe') --version)"

function Invoke-GitWithRetry {
  param([string[]]$Arguments, [int]$Attempts = 4)
  $last = ""
  for ($i = 1; $i -le $Attempts; $i++) {
    & $GitExe @Arguments
    if ($LASTEXITCODE -eq 0) { return }
    $last = "exit code $LASTEXITCODE"
    Write-Warning "[bootstrap] git attempt $i/$Attempts failed ($last); sleeping ${i}s"
    Start-Sleep -Seconds $i
  }
  throw "git failed after $Attempts attempts: $last"
}

if (-not (Test-Path $Root)) {
  Write-Host "[bootstrap] git clone -> $Root"
  Invoke-GitWithRetry -Arguments @("clone", $RepoUrl, $Root)
} else {
  Write-Host "[bootstrap] git fetch/pull -> $Root"
  Invoke-GitWithRetry -Arguments @("-C", $Root, "fetch", "origin", "--prune")
  & $GitExe -C $Root checkout main
  Invoke-GitWithRetry -Arguments @("-C", $Root, "pull", "origin", "main")
}

$deploy = Join-Path $Root "deploy-crawler.ps1"
if (-not (Test-Path $deploy)) {
  throw "deploy-crawler.ps1 not found: $deploy"
}

if ($SkipDeploy) {
  Write-Host "[bootstrap] SkipDeploy: set CRAWLER_REDIS_URL then run:"
  Write-Host "  cd $Root; powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-crawler.ps1"
  exit 0
}

Write-Host "[bootstrap] Running deploy-crawler.ps1 ..."
Set-Location $Root
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $deploy
exit $LASTEXITCODE
