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

$CrawlerProcessName = if ($env:CRAWLER_PM2_NAME) { $env:CRAWLER_PM2_NAME } else { "maxin-crawler" }
$CrawlerScript = if ($env:CRAWLER_ENTRY_SCRIPT) { $env:CRAWLER_ENTRY_SCRIPT } else { ".\scripts\worker-influencer-search.js" }

Write-Host "[deploy-crawler] Fetch + pull main..."
git fetch origin
git checkout main
git pull origin main

Write-Host "[deploy-crawler] npm ci..."
npm ci

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Host "[deploy-crawler] pm2 missing, installing globally..."
  npm install -g pm2
}

Write-Host "[deploy-crawler] pm2 restart $CrawlerProcessName..."
pm2 restart $CrawlerProcessName
if (-not $?) {
  pm2 delete $CrawlerProcessName 2>$null
  pm2 start $CrawlerScript --name $CrawlerProcessName
}

pm2 save
Write-Host "[deploy-crawler] Done."
