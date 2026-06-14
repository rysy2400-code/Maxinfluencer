$ErrorActionPreference = "Continue"
$Root = if ($env:MAXINFLUENCER_ROOT) { $env:MAXINFLUENCER_ROOT } else { "C:\maxinfluencer" }
$Ensure = Join-Path $Root "scripts\ensure-clash-qg-tiktok.ps1"
if (Test-Path $Ensure) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ensure -ProjectRoot $Root
  exit $LASTEXITCODE
}

Write-Host "MIHOMO_ENSURE_SCRIPT_MISSING=$Ensure"
exit 1
