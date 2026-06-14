$ErrorActionPreference = "Continue"
Write-Host "=== profile-inventory ==="

$root = "C:\maxinfluencer"
Get-ChildItem $root -Directory | Where-Object { $_.Name -match "chrome" } | ForEach-Object {
  $size = (Get-ChildItem $_.FullName -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  Write-Host "$($_.Name) size=$size mtime=$($_.LastWriteTime)"
}

$current = Join-Path $root ".chrome-cdp-9222"
$bakDirs = @(Get-ChildItem $root -Directory | Where-Object { $_.Name -like ".chrome-cdp-9222.bak-*" } | Sort-Object LastWriteTime -Descending)
Write-Host "backup_count=$($bakDirs.Count)"
foreach ($b in $bakDirs | Select-Object -First 3) {
  Write-Host "  bak=$($b.Name) size=$((Get-ChildItem $b.FullName -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)"
}

function Test-ProfileCookies($profilePath) {
  $cookies = Join-Path $profilePath "Default\Network\Cookies"
  $cookiesOld = Join-Path $profilePath "Default\Cookies"
  Write-Host "  cookies_network=$(Test-Path $cookies) size=$((Get-Item $cookies -ErrorAction SilentlyContinue).Length)"
  Write-Host "  cookies_legacy=$(Test-Path $cookiesOld) size=$((Get-Item $cookiesOld -ErrorAction SilentlyContinue).Length)"
}

Write-Host "--- current profile ---"
if (Test-Path $current) { Test-ProfileCookies $current }
Write-Host "--- latest backup ---"
if ($bakDirs.Count -gt 0) { Test-ProfileCookies $bakDirs[0].FullName }

Write-Host "--- CDP ---"
try {
  Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3 | Out-Null
  Write-Host "CDP=OK"
} catch { Write-Host "CDP=FAIL" }
