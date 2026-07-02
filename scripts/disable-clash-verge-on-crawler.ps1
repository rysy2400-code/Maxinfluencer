# 爬虫机：停用 Clash Verge GUI/订阅，仅保留 ensure-clash-qg-tiktok + guard-clash-mihomo
param(
  [string]$ProjectRoot = "C:\maxinfluencer",
  [switch]$SkipEnsureClash
)

$ErrorActionPreference = "Continue"
$ConfigDir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$VergeYaml = Join-Path $ConfigDir "verge.yaml"
$ProfilesYaml = Join-Path $ConfigDir "profiles.yaml"
$ProfilesDir = Join-Path $ConfigDir "profiles"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "[disable-verge] stopping Clash Verge GUI..."
Get-Process clash-verge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "[disable-verge] stopping stale clash fix scripts..."
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "powershell.exe" -or $_.Name -eq "cmd.exe") -and
  $_.CommandLine -match "fix-clash-qg-yaml|restore-clash-qg-us|patch-clash-qg|test-proxy-sites\.cmd|configure-qg-tunnel-proxy"
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}

function Remove-RunKeyValue {
  param([string]$HivePath, [string]$NamePattern)
  try {
    $run = Get-ItemProperty -Path $HivePath -ErrorAction Stop
    $run.PSObject.Properties | Where-Object {
      $_.Name -notmatch '^PS' -and $_.Value -match $NamePattern
    } | ForEach-Object {
      Remove-ItemProperty -Path $HivePath -Name $_.Name -Force -ErrorAction SilentlyContinue
      Write-Host "[disable-verge] removed Run key: $($_.Name)"
    }
  } catch {}
}

Remove-RunKeyValue -HivePath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -NamePattern "clash|verge"
Remove-RunKeyValue -HivePath "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run" -NamePattern "clash|verge"

$startupDir = [Environment]::GetFolderPath("Startup")
Get-ChildItem $startupDir -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match "clash|verge"
} | ForEach-Object {
  try {
    Remove-Item $_.FullName -Force -ErrorAction Stop
    Write-Host "[disable-verge] removed startup shortcut: $($_.Name)"
  } catch {}
}

if (Test-Path $VergeYaml) {
  Copy-Item $VergeYaml "$VergeYaml.bak-$stamp" -Force
  $vy = Get-Content $VergeYaml -Raw
  $vy = $vy -replace "(?m)^enable_auto_launch:\s*true\s*$", "enable_auto_launch: false"
  $vy = $vy -replace "(?m)^enable_silent_start:\s*true\s*$", "enable_silent_start: false"
  $vy = $vy -replace "(?m)^enable_system_proxy:\s*true\s*$", "enable_system_proxy: false"
  $vy = $vy -replace "(?m)^enable_tun_mode:\s*true\s*$", "enable_tun_mode: false"
  $vy = $vy -replace "(?m)^enable_proxy_guard:\s*true\s*$", "enable_proxy_guard: false"
  if ($vy -notmatch "(?m)^enable_auto_launch:") { $vy += "`r`nenable_auto_launch: false" }
  if ($vy -notmatch "(?m)^enable_silent_start:") { $vy += "`r`nenable_silent_start: false" }
  Set-Content -Path $VergeYaml -Value $vy -Encoding UTF8
  Write-Host "[disable-verge] verge.yaml patched (auto_launch/system_proxy/tun off)"
}

if (Test-Path $ProfilesYaml) {
  Copy-Item $ProfilesYaml "$ProfilesYaml.bak-$stamp" -Force
  $minimalProfiles = @"
# Crawler VM: no commercial VPN subscriptions. Proxy via C:\maxinfluencer\config\crawler-clash.yaml
current: null
items: []
"@
  Set-Content -Path $ProfilesYaml -Value $minimalProfiles -Encoding UTF8
  Write-Host "[disable-verge] profiles.yaml cleared (removed remote subscriptions)"
}

if (Test-Path $ProfilesDir) {
  Get-ChildItem $ProfilesDir -File -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '\.yaml$|\.yml$' -and $_.Name -notmatch '^Merge\.yaml$|^Script\.js$'
  } | ForEach-Object {
    $bak = Join-Path $ProfilesDir ("_bak-$stamp-" + $_.Name)
    try {
      Move-Item $_.FullName $bak -Force
      Write-Host "[disable-verge] archived profile: $($_.Name)"
    } catch {}
  }
}

if (-not $SkipEnsureClash) {
  foreach ($name in @(".env", ".env.local")) {
    $path = Join-Path $ProjectRoot $name
    if (-not (Test-Path -LiteralPath $path)) { continue }
    Get-Content -LiteralPath $path | ForEach-Object {
      $line = $_.Trim()
      if (-not $line -or $line.StartsWith("#")) { return }
      $idx = $line.IndexOf("=")
      if ($idx -lt 1) { return }
      $key = $line.Substring(0, $idx).Trim()
      $val = $line.Substring($idx + 1).Trim()
      if ($key) { Set-Item -Path "Env:$key" -Value $val }
    }
  }
  $ensure = if ($env:CLASH_SUB_URL -and (Test-Path (Join-Path $ProjectRoot "scripts\ensure-clash-sub-tiktok.ps1"))) {
    Join-Path $ProjectRoot "scripts\ensure-clash-sub-tiktok.ps1"
  } else {
    Join-Path $ProjectRoot "scripts\ensure-clash-qg-tiktok.ps1"
  }
  if (Test-Path $ensure) {
    Write-Host "[disable-verge] starting crawler mihomo via $(Split-Path $ensure -Leaf)..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ensure -ProjectRoot $ProjectRoot
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}

Write-Host "[disable-verge] done (use maxin-guard-clash-mihomo for persistence)"
exit 0
