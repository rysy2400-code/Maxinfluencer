$ErrorActionPreference = "Continue"
Write-Host "=== profile-status ==="
$root = "C:\maxinfluencer"
Get-ChildItem $root -Directory | Where-Object { $_.Name -like ".chrome-cdp-9222*" } | ForEach-Object {
  $size = (Get-ChildItem $_.FullName -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  Write-Host "$($_.Name) size=$size mtime=$($_.LastWriteTime)"
}
$cookies = Join-Path $root ".chrome-cdp-9222\Default\Network\Cookies"
if (Test-Path $cookies) { Write-Host "cookies_size=$((Get-Item $cookies).Length)" } else { Write-Host "cookies_missing" }
try {
  Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 5 | Out-Null
  Write-Host "CDP_OK"
} catch {
  Write-Host "CDP_FAIL"
}
