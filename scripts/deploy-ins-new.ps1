# New INS Windows machine bootstrap: npm ci + env + Chrome + mihomo US proxy +
# start-worker + ig-worker(disabled) + 9222/9223 interactive guards + watchdog + pagefile + reboot
param(
  [string]$EnvB64 = "",
  [string]$EnvLocalB64 = ""
)

# Self-reload guard: this script is loaded from disk by the runner BEFORE
# git checkout. Re-invoke ourselves from the freshly checked-out file so the
# latest script body (mihomo tasks etc.) actually executes.
if ($env:INSDEPLOY_SELF -ne "1") {
  & "C:\Program Files\Git\cmd\git.exe" -C C:\maxinfluencer fetch origin --prune 2>&1 | Out-Null
  & "C:\Program Files\Git\cmd\git.exe" -C C:\maxinfluencer checkout --detach --force origin/main 2>&1 | Out-Null
  $env:INSDEPLOY_SELF = "1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @PSBoundParameters
  exit $LASTEXITCODE
}

$ErrorActionPreference = "Continue"
$log = "C:\Windows\Temp\insdeploy7.log"
function Log($m) {
  try { Add-Content $log ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $m) } catch {}
}

Log "=== start ==="
Set-Location C:\maxinfluencer
Log ("HEAD=" + (& "C:\Program Files\Git\cmd\git.exe" rev-parse --short HEAD))

& "C:\Program Files\nodejs\npm.cmd" ci --no-audit --no-fund 2>&1 | Out-Null
Log ("npm ci done node_modules=" + (Test-Path C:\maxinfluencer\node_modules))

if ($EnvB64) { [IO.File]::WriteAllBytes("C:\maxinfluencer\.env", [Convert]::FromBase64String($EnvB64)); Log ".env written" }
if ($EnvLocalB64) { [IO.File]::WriteAllBytes("C:\maxinfluencer\.env.local", [Convert]::FromBase64String($EnvLocalB64)); Log ".env.local written" }

if (-not (Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe")) {
  try {
    Invoke-WebRequest -Uri "https://dl.google.com/tag/s/dl/chrome/install/googlechromestandaloneenterprise64.msi" -OutFile "C:\Windows\Temp\ChromeEnt.msi" -UseBasicParsing -TimeoutSec 300
    Start-Process msiexec.exe -ArgumentList "/i","C:\Windows\Temp\ChromeEnt.msi","/qn","/norestart" -Wait
  } catch { Log ("chrome install err: " + $_.Exception.Message) }
  Log ("chrome installed: " + (Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe"))
} else { Log "chrome present" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\maxinfluencer\scripts\ensure-ig-us-proxy.ps1 2>&1 | Out-Null
Log "mihomo proxy ensured"

@"
@echo off
cd /d C:\maxinfluencer
set PATH=C:\nodejs;C:\Program Files\nodejs;%PATH%
:loop
node --experimental-default-type=module scripts\worker-influencer-search.js >> C:\maxinfluencer\worker-task.out.log 2>&1
echo [%date% %time%] worker exited, restarting in 10s >> C:\maxinfluencer\worker-task.out.log
timeout /t 10 /nobreak >nul
goto loop
"@ | Set-Content -Path C:\maxinfluencer\start-worker.cmd -Encoding ASCII

schtasks /Create /TN ig-worker /TR "C:\maxinfluencer\start-worker.cmd" /SC ONSTART /RU SYSTEM /RL HIGHEST /F 2>&1 | Out-Null
schtasks /Change /TN ig-worker /DISABLE 2>&1 | Out-Null
Log "ig-worker task created + disabled"

foreach ($port in @(9222,9223)) {
  $tn = "ig-chrome-guard-user-" + $port
  schtasks /Delete /TN $tn /F 2>&1 | Out-Null
  schtasks /Create /TN $tn /TR ("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\maxinfluencer\scripts\run-guard-ig-" + $port + ".ps1") /SC ONLOGON /RU administrator /RP Dzj119020007. /IT /F 2>&1 | Out-Null
}
Log "chrome guards created"

schtasks /Create /TN ig-guard-watchdog /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\maxinfluencer\scripts\guard-ig-watchdog.ps1" /SC MINUTE /MO 5 /RU SYSTEM /RL HIGHEST /F 2>&1 | Out-Null
Log "watchdog created"

# mihomo keep-alive: autostart at boot + 10-minute guard (mirrors ig-proxy-guard on the existing 3 machines)
schtasks /Create /TN ig-proxy-start /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\maxinfluencer\scripts\ensure-ig-us-proxy.ps1" /SC ONSTART /RU SYSTEM /RL HIGHEST /F 2>&1 | Out-Null
schtasks /Create /TN ig-proxy-guard /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\maxinfluencer\scripts\ensure-ig-us-proxy.ps1" /SC MINUTE /MO 10 /RU SYSTEM /RL HIGHEST /F 2>&1 | Out-Null
Log "mihomo autostart + guard tasks created"

# Clean up leftover bootstrap task (never delete insdeploy7 itself mid-run)
schtasks /Delete /TN bootstrap7 /F 2>&1 | Out-Null
Log "bootstrap/insdeploy tasks cleaned"

& wmic computersystem where "name='%computername%'" set AutomaticManagedPagefile=False 2>&1 | Out-Null
$pf = Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue
if (-not $pf) { & wmic pagefileset create name="C:\pagefile.sys" 2>&1 | Out-Null }
& wmic pagefileset where "name='C:\\pagefile.sys'" set InitialSize=4096,MaximumSize=4096 2>&1 | Out-Null
Log "pagefile configured"

shutdown /r /t 20 /f 2>&1 | Out-Null
Log "reboot scheduled"
