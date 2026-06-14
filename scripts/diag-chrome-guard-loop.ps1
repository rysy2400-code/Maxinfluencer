# 诊断 Chrome 9222/9223 守护循环
$ErrorActionPreference = "SilentlyContinue"

Write-Host "=== time ===" (Get-Date -Format o)

Write-Host "`n=== Scheduled Tasks ==="
foreach ($tn in @("maxin-guard-chrome-9222", "maxin-guard-chrome-9223", "maxin-guard-crawler-search")) {
  Write-Host "--- $tn ---"
  schtasks /Query /TN $tn /FO LIST /V 2>$null | Select-String "Status|Last Run|Next Run|Task To Run|Running"
}

Write-Host "`n=== Guard PowerShell (guard-chrome) ==="
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -match "guard-chrome-922" } |
  ForEach-Object { Write-Host "pid=$($_.ProcessId) $($_.CommandLine)" }

Write-Host "`n=== All powershell matching maxin/guard ==="
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -match "maxin|guard-chrome|run-guard" } |
  ForEach-Object { Write-Host "pid=$($_.ProcessId) len=$($_.CommandLine.Length)" }

Write-Host "`n=== Chrome CDP processes ==="
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match "chrome" -and $_.CommandLine -match "remote-debugging-port=922" } |
  ForEach-Object {
    $port = if ($_.CommandLine -match "9222") { "9222" } elseif ($_.CommandLine -match "9223") { "9223" } else { "?" }
    Write-Host "[$port] pid=$($_.ProcessId)"
    Write-Host "  $($_.CommandLine.Substring(0, [Math]::Min(220, $_.CommandLine.Length)))"
  }

Write-Host "`n=== CDP + proxy ==="
foreach ($port in @(9222, 9223)) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/json/version" -TimeoutSec 3
    Write-Host "CDP $port OK $($r.StatusCode)"
  } catch {
    Write-Host "CDP $port FAIL $($_.Exception.Message)"
  }
}
try {
  $t = Get-NetTCPConnection -LocalPort 7897 -State Listen -ErrorAction Stop
  Write-Host "proxy 7897 LISTENING"
} catch {
  Write-Host "proxy 7897 NOT LISTENING"
}

Write-Host "`n=== signals dir ==="
if (Test-Path "C:\maxinfluencer\signals") {
  Get-ChildItem "C:\maxinfluencer\signals" | ForEach-Object { Write-Host $_.Name $_.LastWriteTime }
} else {
  Write-Host "signals dir missing"
}

Write-Host "`n=== Profile lock files ==="
foreach ($d in @("C:\maxinfluencer\.chrome-cdp-9222", "C:\maxinfluencer\.chrome-cdp-9223")) {
  $lock = Join-Path $d "SingletonLock"
  $cookie = Join-Path $d "Default\Network\Cookies"
  Write-Host "$d SingletonLock=$(Test-Path $lock) Cookies=$(Test-Path $cookie)"
}

Write-Host "`n=== Chrome Application Error (30m) ==="
Get-WinEvent -FilterHashtable @{
  LogName     = "Application"
  ProviderName = "Application Error"
  StartTime   = (Get-Date).AddMinutes(-30)
} -MaxEvents 8 -ErrorAction SilentlyContinue |
  ForEach-Object {
    $m = $_.Message -replace "`r`n", " "
    if ($m -match "chrome\.exe") {
      Write-Host $_.TimeCreated $m.Substring(0, [Math]::Min(400, $m.Length))
    }
  }

Write-Host "`n=== DONE ==="
