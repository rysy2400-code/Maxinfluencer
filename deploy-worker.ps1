$ErrorActionPreference = "Stop"

$Root = "C:\maxinfluencer"
if (-not (Test-Path $Root)) {
  throw "Deploy root not found: $Root"
}
Set-Location $Root

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git not found. Install Git for Windows and ensure git.exe is in PATH."
}

$nodeDir = "C:\Program Files\nodejs"
if (Test-Path $nodeDir) {
  $env:Path = "$nodeDir;$env:Path"
}

$WorkerProcessName = if ($env:WORKER_PM2_NAME) { $env:WORKER_PM2_NAME } else { "maxin-worker" }
$WorkerScript = if ($env:WORKER_ENTRY_SCRIPT) { $env:WORKER_ENTRY_SCRIPT } else { ".\scripts\worker-influencer-search.js" }

Write-Host "[deploy-worker] Fetch + pull main..."
git fetch origin
git checkout main
git pull origin main

Write-Host "[deploy-worker] npm ci..."
npm ci

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Host "[deploy-worker] pm2 missing, installing globally..."
  npm install -g pm2
}

Write-Host "[deploy-worker] pm2 restart $WorkerProcessName..."
pm2 restart $WorkerProcessName
if (-not $?) {
  pm2 delete $WorkerProcessName 2>$null
  pm2 start $WorkerScript --name $WorkerProcessName
}

pm2 save
Write-Host "[deploy-worker] Done."
