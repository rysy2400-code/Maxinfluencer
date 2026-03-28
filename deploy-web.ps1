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

Write-Host "[deploy-web] Fetch + pull main..."
git fetch origin
git checkout main
git pull origin main

Write-Host "[deploy-web] npm ci..."
npm ci

Write-Host "[deploy-web] npm run build..."
npm run build

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Host "[deploy-web] pm2 missing, installing globally..."
  npm install -g pm2
}

Write-Host "[deploy-web] pm2 restart maxin-web..."
pm2 restart maxin-web
if (-not $?) {
  pm2 delete maxin-web 2>$null
  pm2 start node --name maxin-web -- .\node_modules\next\dist\bin\next start -H 0.0.0.0 -p 3000
}

pm2 save
Write-Host "[deploy-web] Done."
