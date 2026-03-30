# One-time on Web VM: install Git for Windows (silent).
# If GitHub API fails (e.g. CRL/offline), uses curl.exe -k to download the installer.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$installer = Join-Path $env:TEMP "Git-for-Windows-64-bit.exe"
$directUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"

try {
  $api = Invoke-RestMethod -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ "User-Agent" = "Maxinfluencer-deploy" }
  $asset = $api.assets | Where-Object { $_.name -match "Git-.*-64-bit\.exe$" } | Select-Object -First 1
  if ($asset) {
    Write-Host "Downloading $($asset.name) ..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
  } else {
    throw "No asset"
  }
} catch {
  Write-Host "API download failed ($($_.Exception.Message)), trying curl -k ..."
  & curl.exe -L -k -o $installer -m 300 $directUrl
  if (-not (Test-Path $installer)) { throw "Download failed." }
}

Write-Host "Installing silently..."
Start-Process -FilePath $installer -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/CLOSEAPPLICATIONS" -Wait
$gitExe = "C:\Program Files\Git\cmd\git.exe"
if (-not (Test-Path $gitExe)) { throw "Git install finished but $gitExe not found." }
& $gitExe --version
Write-Host "Done. You may need to open a new shell for PATH to include git."
