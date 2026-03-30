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

Write-Host "[deploy-web] npm ci..."
npm ci

Write-Host "[deploy-web] npm run build..."
npm run build

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Host "[deploy-web] pm2 missing, installing globally..."
  npm install -g pm2
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

Write-Host "[deploy-web] pm2 start/reload maxin-web via ecosystem..."
pm2 start $ecosystemPath --only maxin-web --update-env

pm2 save
Write-Host "[deploy-web] Done."
