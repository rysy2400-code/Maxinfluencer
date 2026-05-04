param(
  [Parameter(Mandatory = $true)]
  [string]$RedisUrl
)
$ErrorActionPreference = "Stop"
$env:CRAWLER_REDIS_URL = $RedisUrl
Set-Location "C:\maxinfluencer"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\maxinfluencer\deploy-crawler.ps1"
exit $LASTEXITCODE
