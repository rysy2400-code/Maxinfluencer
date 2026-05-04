$ErrorActionPreference = "Stop"

$Root = "C:\maxinfluencer"
if (-not (Test-Path $Root)) {
  throw "Deploy root not found: $Root"
}
Set-Location $Root

$nodeDir = "C:\Program Files\nodejs"
if (Test-Path $nodeDir) {
  $env:Path = "$nodeDir;$env:Path"
}

function Invoke-Npm {
  param([Parameter(Mandatory = $true)][string[]]$NpmArguments)
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npmCmd) { throw "npm not found in PATH. Install Node.js LTS." }
  & $npmCmd.Source @NpmArguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm failed (exit $LASTEXITCODE): npm $($NpmArguments -join ' ')"
  }
}

function Stop-MaxinWebForDeploy {
  # Windows：PM2 子进程会占用 node_modules 下文件，npm ci 删除/覆盖时常见 EPERM / ENOTEMPTY
  Write-Host "[deploy-web] Stopping/removing PM2 app 'maxin-web' to release file locks..."
  try {
    pm2 stop maxin-web 2>$null | Out-Null
  } catch {}
  try {
    pm2 delete maxin-web 2>$null | Out-Null
  } catch {}
  Start-Sleep -Seconds 4
}

function Remove-NodeModulesWithRetry {
  param([string]$ProjectRoot)
  $nm = Join-Path $ProjectRoot "node_modules"
  if (-not (Test-Path $nm)) { return }
  Write-Host "[deploy-web] Removing node_modules (clean slate avoids npm ci ENOTEMPTY/EPERM on Windows)..."
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      Remove-Item -LiteralPath $nm -Recurse -Force -ErrorAction Stop
      Write-Host "[deploy-web] node_modules removed."
      return
    } catch {
      Write-Host "[deploy-web] Remove node_modules attempt $attempt failed: $($_.Exception.Message)"
      if ($attempt -lt 4) {
        Start-Sleep -Seconds 6
      }
    }
  }
  throw "Could not remove $nm after 4 attempts. Reboot the VM or close apps locking files under node_modules, then re-run deploy-web.ps1."
}

function Get-GitExe {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
    return $cmd.Source
  }
  $candidates = @(
    "C:\Program Files\Git\cmd\git.exe",
    "C:\Program Files\Git\bin\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Refresh-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($machine, $user) | Where-Object { $_ }
  if ($parts.Count -gt 0) {
    $env:Path = ($parts -join ";") + ";" + $env:Path
  }
}

function Invoke-GitPullMain {
  param([string]$GitExe)
  $gitDir = Split-Path $GitExe -Parent
  if ($gitDir) {
    $env:Path = "$gitDir;$env:Path"
  }
  if (-not (Test-Path (Join-Path $Root ".git"))) {
    Write-Host "[deploy-web] No .git under $Root — skip pull. To sync from GitHub, clone your repo into this folder (or init + remote + pull). See repo docs."
    return
  }
  Write-Host "[deploy-web] Fetch + pull main..."
  & $GitExe -C $Root fetch origin
  & $GitExe -C $Root checkout main
  & $GitExe -C $Root pull origin main
}

Refresh-PathFromRegistry
$gitExe = Get-GitExe

if ($gitExe) {
  try {
    Invoke-GitPullMain -GitExe $gitExe
  } catch {
    Write-Host "[deploy-web] git pull failed: $($_.Exception.Message)"
    throw
  }
} else {
  Write-Host "[deploy-web] git not found — skip pull. Install Git for Windows: https://git-scm.com/download/win"
  Write-Host "[deploy-web] After install, re-run deploy or restart the machine so PATH is picked up."
}

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Host "[deploy-web] pm2 missing, installing globally..."
  Invoke-Npm @("install", "-g", "pm2")
}

Write-Host "[deploy-web] writing ecosystem file..."
$ecosystemPath = Join-Path $Root "ecosystem.web.config.cjs"
$ecosystemContent = @"
module.exports = {
  apps: [{
    name: "maxin-web",
    cwd: "C:\\maxinfluencer",
    script: ".\\node_modules\\next\\dist\\bin\\next",
    interpreter: "node",
    args: "start -p 80",
    env: {
      NODE_ENV: "production"
    }
  }]
};
"@
Set-Content -Path $ecosystemPath -Value $ecosystemContent -Encoding ASCII

Stop-MaxinWebForDeploy
Remove-NodeModulesWithRetry -ProjectRoot $Root

Write-Host "[deploy-web] npm ci..."
try {
  Invoke-Npm @("ci")
} catch {
  Write-Host "[deploy-web] npm ci failed: $($_.Exception.Message)"
  Write-Host "[deploy-web] If EPERM persists: close RDP editors touching the repo, pause antivirus scan on $Root, or reboot then re-run."
  throw
}

Write-Host "[deploy-web] next build (node --max-old-space-size + NODE_OPTIONS for workers)..."
$prevNodeOpts = $env:NODE_OPTIONS
$heap = "--max-old-space-size=12288"
$env:NODE_OPTIONS = $heap
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$nextCli = Join-Path $Root "node_modules\next\dist\bin\next"
if (-not (Test-Path $nextCli)) {
  throw "next CLI not found: $nextCli (npm ci incomplete?)"
}
try {
  & $nodeExe $heap $nextCli "build"
  if ($LASTEXITCODE -ne 0) {
    throw "next build failed (exit $LASTEXITCODE)"
  }
} finally {
  $env:NODE_OPTIONS = $prevNodeOpts
}

Write-Host "[deploy-web] pm2 start maxin-web via ecosystem..."
pm2 start $ecosystemPath --only maxin-web --update-env
if ($LASTEXITCODE -ne 0) {
  throw "pm2 start failed (exit $LASTEXITCODE). Try: pm2 kill  (stops PM2 daemon) then re-run deploy-web.ps1"
}

pm2 save
Write-Host "[deploy-web] Done."
