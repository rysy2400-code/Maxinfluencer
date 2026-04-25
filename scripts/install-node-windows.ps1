$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$url = "https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi"
$out = Join-Path $env:TEMP "node-lts.msi"
Write-Host "Downloading Node from $url ..."
Invoke-WebRequest -Uri $url -OutFile $out
Write-Host "Installing Node silently..."
Start-Process msiexec.exe -ArgumentList "/i", $out, "/quiet", "/norestart" -Wait
$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) { throw "Node install finished but $node not found." }
& $node --version
Write-Host "Done."
