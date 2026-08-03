param(
  [string]$ProjectRoot = $(if ($env:MAXINFLUENCER_ROOT) { $env:MAXINFLUENCER_ROOT } else { "C:\maxinfluencer" }),
  [string]$EndpointMap = $(if ($env:TT_LITE_ENDPOINT_POOL_MAP) { $env:TT_LITE_ENDPOINT_POOL_MAP } else { "9223:7898:9108:f533f9b2-c69a-4dd0-bc63-f2ab94dd-15005,9224:7899:9109:f533f9b2-c69a-4dd0-bc63-f2ab94dd-15003,9225:7900:9110:f533f9b2-c69a-4dd0-bc63-f2ab94dd-15002" }),
  [string]$ChromeVisible = $(if ($env:CHROME_VISIBLE) { $env:CHROME_VISIBLE } else { "1" }),
  [switch]$SkipProbe
)

$ErrorActionPreference = "Stop"

$Root = $ProjectRoot
$ConfigDir = Join-Path $Root "config"
$ScriptsDir = Join-Path $Root "scripts"
$SignalsDir = Join-Path $Root "signals"
$BaseConfig = Join-Path $ConfigDir "crawler-clash.yaml"
$MihomoExe = "C:\Program Files\Clash Verge\verge-mihomo.exe"
$ChromeExe = if ($env:CHROME_EXE) { $env:CHROME_EXE } else { "C:\Program Files\Google\Chrome\Application\chrome.exe" }

function Ensure-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Test-PortListening([int]$Port) {
  return [bool](netstat -an | Select-String "127.0.0.1:$Port\s+.*LISTENING")
}

function Backup-File([string]$Path, [string]$Tag) {
  if (Test-Path -LiteralPath $Path) {
    Copy-Item -LiteralPath $Path -Destination "$Path.bak-$Tag-$(Get-Date -Format yyyyMMddHHmmss)" -Force
  }
}

function Stop-ProcessesByPattern([string]$Pattern) {
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -match $Pattern
  } | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Set-EnvLine([string]$Path, [string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path) }
  $found = $false
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line -match ("^\s*" + [regex]::Escape($Key) + "\s*=")) {
      $out.Add("$Key=$Value")
      $found = $true
    } else {
      $out.Add($line)
    }
  }
  if (-not $found) { $out.Add("$Key=$Value") }
  Set-Content -LiteralPath $Path -Value $out -Encoding UTF8
}

function Resolve-Mappings {
  $items = @()
  foreach ($raw in @($EndpointMap -split ",")) {
    $parts = @($raw.Trim() -split ":", 4)
    if ($parts.Count -ne 4) { continue }
    $items += [pscustomobject]@{
      CdpPort = [int]$parts[0]
      ProxyPort = [int]$parts[1]
      ControllerPort = [int]$parts[2]
      Node = [string]$parts[3]
    }
  }
  if ($items.Count -lt 1) { throw "TT Lite endpoint pool map is empty or invalid: $EndpointMap" }
  return $items
}

function Write-FixedMihomoConfig($Mapping) {
  $content = Get-Content -Raw -LiteralPath $BaseConfig
  $content = [regex]::Replace($content, "(?m)^mixed-port:\s*\d+", "mixed-port: $($Mapping.ProxyPort)")
  $content = [regex]::Replace($content, "(?m)^external-controller:\s*.+$", "external-controller: 127.0.0.1:$($Mapping.ControllerPort)")
  $content = [regex]::Replace($content, "(?ms)^rules:\s*.*$", "rules:`r`n  - MATCH,$($Mapping.Node)")
  $path = Join-Path $ConfigDir "crawler-clash-enrich-$($Mapping.CdpPort).yaml"
  Set-Content -LiteralPath $path -Value $content -Encoding UTF8
  return $path
}

function Patch-MainClashGuard {
  $path = Join-Path $ScriptsDir "guard-clash-mihomo.ps1"
  if (-not (Test-Path -LiteralPath $path)) { return }
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -match "crawler-clash-enrich-") { return }
  Backup-File $path "allow-enrich-mihomo"
  $old = '$_.Name -eq "verge-mihomo.exe" -and $_.CommandLine -and $_.CommandLine -notmatch [regex]::Escape($CrawlerConfig)'
  $new = '$_.Name -eq "verge-mihomo.exe" -and $_.CommandLine -and $_.CommandLine -notmatch [regex]::Escape($CrawlerConfig) -and $_.CommandLine -notmatch "crawler-clash-enrich-"'
  Set-Content -LiteralPath $path -Value ($content.Replace($old, $new)) -Encoding ASCII
}

function Write-MihomoGuard($Mappings) {
  $path = Join-Path $ScriptsDir "guard-tiktok-enrich-mihomo.ps1"
  Backup-File $path "update"
  $entries = ($Mappings | ForEach-Object {
    "  [pscustomobject]@{ Port = $($_.ProxyPort); Config = `"C:\maxinfluencer\config\crawler-clash-enrich-$($_.CdpPort).yaml`"; Runtime = `"C:\maxinfluencer\config\mihomo-enrich-$($_.CdpPort)`" }"
  }) -join ",`r`n"
  $content = @"
`$ErrorActionPreference = "SilentlyContinue"
`$MihomoExe = "$MihomoExe"
`$Items = @(
$entries
)
function Test-PortListening([int]`$Port) {
  return [bool](netstat -an | Select-String "127.0.0.1:`$Port\s+.*LISTENING")
}
while (`$true) {
  foreach (`$item in `$Items) {
    `$proc = Get-CimInstance Win32_Process | Where-Object { `$_.Name -eq "verge-mihomo.exe" -and `$_.CommandLine -and `$_.CommandLine -match [regex]::Escape(`$item.Config) } | Select-Object -First 1
    if ((-not `$proc) -or (-not (Test-PortListening `$item.Port))) {
      Get-CimInstance Win32_Process | Where-Object { `$_.Name -eq "verge-mihomo.exe" -and `$_.CommandLine -and `$_.CommandLine -match [regex]::Escape(`$item.Config) } | ForEach-Object {
        try { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
      }
      if (-not (Test-Path `$item.Runtime)) { New-Item -ItemType Directory -Path `$item.Runtime -Force | Out-Null }
      Start-Process -FilePath `$MihomoExe -ArgumentList @("-f", `$item.Config, "-d", `$item.Runtime) -WorkingDirectory "$Root" -WindowStyle Hidden | Out-Null
      Start-Sleep -Seconds 3
    }
  }
  Start-Sleep -Seconds 15
}
"@
  Set-Content -LiteralPath $path -Value $content -Encoding ASCII
  return $path
}

function Write-ChromeGuard {
  $guardPath = Join-Path $ScriptsDir "guard-tiktok-enrich-cdp.ps1"
  Backup-File $guardPath "update"
  $content = @'
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
$ChromeArgs = @("--disable-quic", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$Port", "--user-data-dir=$ProfileDir", "--proxy-server=$ProxyServer", "--no-first-run", "--no-default-browser-check", $LaunchUrl)
if ($Visible) { $ChromeArgs = @("--disable-gpu") + $ChromeArgs } else { $ChromeArgs = @("--headless=new", "--disable-gpu") + $ChromeArgs }
$ProfilePattern = [Regex]::Escape($ProfileDir)
function Test-CdpHealthy {
  try { return ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3).StatusCode -eq 200) } catch { return $false }
}
function Get-ChromeProcesses {
  Get-CimInstance Win32_Process | Where-Object { ($_.Name -match "chrome|msedge") -and $_.CommandLine -and ($_.CommandLine -match $ProfilePattern -or $_.CommandLine -match "remote-debugging-port=$Port") }
}
function Stop-Chrome { Get-ChromeProcesses | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} } }
function Start-Chrome { if (Test-Path $ChromeExe) { Start-Process -FilePath $ChromeExe -ArgumentList $ChromeArgs -WorkingDirectory (Split-Path $ChromeExe -Parent) | Out-Null } }
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
'@
  Set-Content -LiteralPath $guardPath -Value $content -Encoding ASCII
  return $guardPath
}

function Write-ChromeRunner($Mapping) {
  $path = Join-Path $ScriptsDir "run-guard-tiktok-enrich-$($Mapping.CdpPort).ps1"
  Backup-File $path "update"
  $content = @"
`$ErrorActionPreference = "SilentlyContinue"
`$env:CHROME_EXE = "$ChromeExe"
`$env:TT_ENRICH_CDP_PORT = "$($Mapping.CdpPort)"
`$env:TT_ENRICH_CHROME_PROFILE = "C:\maxinfluencer\.chrome-cdp-$($Mapping.CdpPort)"
`$env:TT_ENRICH_PROXY_SERVER = "http://127.0.0.1:$($Mapping.ProxyPort)"
`$env:TT_ENRICH_CHROME_URL = "https://www.tiktok.com"
`$env:TT_ENRICH_CHROME_VISIBLE = "$ChromeVisible"
`$env:TT_ENRICH_RESTART_SIGNAL_FILE = "C:\maxinfluencer\signals\restart-chrome-$($Mapping.CdpPort).flag"
. "C:\maxinfluencer\scripts\guard-tiktok-enrich-cdp.ps1"
"@
  Set-Content -LiteralPath $path -Value $content -Encoding ASCII
  return $path
}

function Ensure-Task([string]$Name, [string]$ScriptPath) {
  schtasks.exe /Create /TN $Name /SC ONSTART /RL HIGHEST /RU SYSTEM /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`"" /F | Out-Null
  schtasks.exe /Run /TN $Name | Out-Null
}

Ensure-Dir $ConfigDir
Ensure-Dir $ScriptsDir
Ensure-Dir $SignalsDir
if (-not (Test-Path -LiteralPath $BaseConfig)) { throw "missing base config $BaseConfig" }
if (-not (Test-Path -LiteralPath $MihomoExe)) { throw "missing mihomo $MihomoExe" }
if (-not (Test-Path -LiteralPath $ChromeExe)) { throw "missing chrome $ChromeExe" }

$Mappings = @(Resolve-Mappings)
Patch-MainClashGuard
foreach ($m in $Mappings) {
  $cfg = Write-FixedMihomoConfig $m
  Write-Host "[tt-lite-pool] config $($m.ProxyPort) $($m.Node) -> $cfg"
}

$mihomoGuard = Write-MihomoGuard $Mappings
$chromeGuard = Write-ChromeGuard

schtasks.exe /Change /TN "maxin-guard-chrome-9223" /DISABLE 2>$null | Out-Null
Stop-ProcessesByPattern "run-guard-chrome-9223|guard-chrome-9223"

Ensure-Task "maxin-guard-tiktok-enrich-mihomo" $mihomoGuard
Start-Sleep -Seconds 5
foreach ($m in $Mappings) {
  $runner = Write-ChromeRunner $m
  Ensure-Task "maxin-guard-tiktok-enrich-$($m.CdpPort)" $runner
}

$envPath = Join-Path $Root ".env.local"
Set-EnvLine $envPath "CDP_ENDPOINT" "http://127.0.0.1:9222"
Set-EnvLine $envPath "CDP_ENDPOINT_ENRICH" "http://127.0.0.1:$($Mappings[0].CdpPort)"
Set-EnvLine $envPath "TT_LITE_SEARCH_CDP" "http://127.0.0.1:9222"
Set-EnvLine $envPath "TT_LITE_ENRICH_CDP_ENDPOINTS" (($Mappings | ForEach-Object { "http://127.0.0.1:$($_.CdpPort)" }) -join ",")
Set-EnvLine $envPath "TT_LITE_TAB_POOL_SIZE" "$($Mappings.Count)"
Set-EnvLine $envPath "LITE_TT_ENRICH_CONCURRENCY" "$($Mappings.Count)"
Set-EnvLine $envPath "LITE_TT_ENRICH_CONCURRENCY_MAX" "$($Mappings.Count)"
Set-EnvLine $envPath "TT_LITE_ENRICH_HARD_MAX" "$($Mappings.Count)"
Set-EnvLine $envPath "TT_LITE_MAX_VIDEOS" "50"
Set-EnvLine $envPath "TT_LITE_REQUIRE_EMAIL_FOR_ANALYSIS" "1"
$countryMapping = $Mappings | Where-Object { $_.CdpPort -eq 9224 } | Select-Object -First 1
if (-not $countryMapping) { $countryMapping = $Mappings | Select-Object -First 1 }
Set-EnvLine $envPath "TT_LITE_COUNTRY_CDP" "http://127.0.0.1:$($countryMapping.CdpPort)"
Set-EnvLine $envPath "TT_LITE_COUNTRY_CONCURRENCY" "1"
Set-EnvLine $envPath "TT_LITE_COUNTRY_ENDPOINT_HEALTH_SAMPLE_SIZE" "1"
Set-EnvLine $envPath "TT_LITE_PROXY_NODE_PRIORITY" ("US-8041," + (($Mappings | ForEach-Object { $_.Node }) -join ","))

if (-not $SkipProbe) {
  Start-Sleep -Seconds 8
  foreach ($m in $Mappings) {
    $cdpOk = Test-PortListening $m.CdpPort
    $proxyOk = Test-PortListening $m.ProxyPort
    Write-Host "[tt-lite-pool] port cdp=$($m.CdpPort):$cdpOk proxy=$($m.ProxyPort):$proxyOk node=$($m.Node)"
  }
}

Write-Host "[tt-lite-pool] done endpoints=$(($Mappings | ForEach-Object { "http://127.0.0.1:$($_.CdpPort)" }) -join ",")"
