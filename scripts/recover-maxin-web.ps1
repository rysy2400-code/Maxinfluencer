# One-shot recovery: ensure maxin-web listens on port 80
$ErrorActionPreference = "SilentlyContinue"
$Root = "C:\maxinfluencer"
$ensureScript = Join-Path $Root "scripts\ensure-maxin-web.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ensureScript
exit $LASTEXITCODE
