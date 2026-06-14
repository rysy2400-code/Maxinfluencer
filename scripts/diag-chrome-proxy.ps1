$ErrorActionPreference = "Continue"
& "C:\maxinfluencer\scripts\ensure-mihomo-running.ps1" | Out-Host

Write-Host "--- TCP 7897 ---"
Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -WarningAction SilentlyContinue | Select-Object TcpTestSucceeded | Format-List

Write-Host "--- Chrome main ---"
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "chrome.exe" -and $_.CommandLine -like "*chrome-cdp-9222*" -and $_.CommandLine -like "*--remote-debugging-port=9222*"
} | ForEach-Object { Write-Host $_.CommandLine }

Write-Host "--- curl proxy ---"
curl.exe -sI --max-time 15 -x http://127.0.0.1:7897 https://www.instagram.com/ 2>&1 | Select-Object -First 3

Write-Host "--- node reload ---"
Push-Location C:\maxinfluencer
node --experimental-default-type=module scripts/reload-ig-cdp-tab.mjs 2>&1
Pop-Location

Write-Host "--- mihomo after ---"
Get-Process verge-mihomo -EA SilentlyContinue | Select-Object Id
