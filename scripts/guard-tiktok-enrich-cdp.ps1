$ErrorActionPreference = "SilentlyContinue"
$ChromeExe = if ($env:CHROME_EXE) { $env:CHROME_EXE } else { "C:\Program Files\Google\Chrome\Application\chrome.exe" }
$Port = [int]$env:TT_ENRICH_CDP_PORT
$ProfileDir = $env:TT_ENRICH_CHROME_PROFILE
$ProxyServer = $env:TT_ENRICH_PROXY_SERVER
$LaunchUrl = if ($env:TT_ENRICH_CHROME_URL) { $env:TT_ENRICH_CHROME_URL } else { "https://www.tiktok.com" }
$SignalFile = if ($env:TT_ENRICH_RESTART_SIGNAL_FILE) { $env:TT_ENRICH_RESTART_SIGNAL_FILE } else { "C:\maxinfluencer\signals\restart-chrome-$Port.flag" }
$VisibleRaw = if ($env:TT_ENRICH_CHROME_VISIBLE) { $env:TT_ENRICH_CHROME_VISIBLE.ToLowerInvariant() } else { "1" }
$Visible = ($VisibleRaw -eq "1" -or $VisibleRaw -eq "true" -or $VisibleRaw -eq "yes")
if (-not (Test-Path (Split-Path $SignalFile -Parent))) { New-Item -ItemType Directory -Path (Split-Path $SignalFile -Parent) -Force | Out-Null }
if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null }
$ChromeArgs = @("--disable-quic", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$Port", "--user-data-dir=$ProfileDir", "--proxy-server=$ProxyServer", "--no-first-run", "--no-default-browser-check", "--blink-settings=imagesEnabled=false", "--autoplay-policy=user-gesture-required", $LaunchUrl)
if ($Visible) { $ChromeArgs = @("--disable-gpu") + $ChromeArgs } else { $ChromeArgs = @("--headless=new", "--disable-gpu") + $ChromeArgs }
$ProfilePattern = [Regex]::Escape($ProfileDir)
function Test-CdpHealthy {
  try { return ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3).StatusCode -eq 200) } catch { return $false }
}
function Get-ChromeProcesses {
  Get-CimInstance Win32_Process | Where-Object { ($_.Name -match "chrome|msedge") -and $_.CommandLine -and ($_.CommandLine -match $ProfilePattern -or $_.CommandLine -match "remote-debugging-port=$Port") }
}
function Stop-Chrome { Get-ChromeProcesses | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} } }
function Start-Chrome { if (Test-Path $ChromeExe) { Start-Process -FilePath $ChromeExe -ArgumentList $ChromeArgs -WorkingDirectory (Split-Path $ChromeExe -Parent) -WindowStyle Hidden | Out-Null } }
function Ensure-SingleTikTokTab {
  try {
    $pages = @((Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 5) | Where-Object { $_.type -eq "page" })
    if ($pages.Count -eq 0) {
      Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$Port/json/new?$([uri]::EscapeDataString($LaunchUrl))" -TimeoutSec 5 | Out-Null
      return
    }
    $keeper = $pages | Sort-Object @{ Expression = { if ([string]$_.url -match "tiktok\.com") { 0 } else { 1 } } }, @{ Expression = { [string]$_.url } } | Select-Object -First 1
    foreach ($p in $pages) {
      if ([string]$p.id -ne [string]$keeper.id) {
        try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/close/$($p.id)" -TimeoutSec 5 | Out-Null } catch {}
      }
    }
  } catch {}
}
$lastEnsure = $null
while ($true) {
  if (Test-Path $SignalFile) {
    Remove-Item $SignalFile -Force -ErrorAction SilentlyContinue
    Stop-Chrome
    Start-Sleep -Seconds 2
    Start-Chrome
    Start-Sleep -Seconds 10
    continue
  }
  if (Test-CdpHealthy) {
    if (-not $lastEnsure -or (((Get-Date) - $lastEnsure).TotalSeconds -ge 30)) {
      Ensure-SingleTikTokTab
      $lastEnsure = Get-Date
    }
  } elseif (@(Get-ChromeProcesses).Count -eq 0) {
    Start-Chrome
    Start-Sleep -Seconds 10
  }
  Start-Sleep -Seconds 8
}
