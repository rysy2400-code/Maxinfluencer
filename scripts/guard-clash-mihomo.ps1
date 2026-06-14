# 守护爬虫专用 mihomo（crawler-clash.yaml），防止 Clash Verge GUI / 旧脚本抢回订阅配置。
$ErrorActionPreference = "SilentlyContinue"
$Root = if ($env:MAXINFLUENCER_ROOT) { $env:MAXINFLUENCER_ROOT } else { "C:\maxinfluencer" }
$EnsureScript = Join-Path $Root "scripts\ensure-clash-qg-tiktok.ps1"
$CrawlerConfig = Join-Path $Root "config\crawler-clash.yaml"
$MixedPort = if ($env:CLASH_MIXED_PORT) { [int]$env:CLASH_MIXED_PORT } else { 7897 }
$ProbeEvery = if ($env:CLASH_GUARD_TT_PROBE_EVERY) { [int]$env:CLASH_GUARD_TT_PROBE_EVERY } else { 12 }
$cycle = 0

function Import-DotEnv {
  param([string]$ProjectRoot)
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
      if ($val.Length -ge 2) {
        $q0 = $val[0]; $qn = $val[$val.Length - 1]
        if (($q0 -eq [char]34 -and $qn -eq [char]34) -or ($q0 -eq [char]39 -and $qn -eq [char]39)) {
          $val = $val.Substring(1, $val.Length - 2)
        }
      }
      if ($key) { Set-Item -Path "Env:$key" -Value $val }
    }
  }
}

Import-DotEnv -ProjectRoot $Root

function Test-PortListening {
  param([int]$Port)
  return [bool](netstat -an | Select-String "127.0.0.1:$Port\s+.*LISTENING")
}

function Stop-VergeGui {
  Get-Process clash-verge -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Stop-WrongMihomo {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "verge-mihomo.exe" -and $_.CommandLine -and $_.CommandLine -notmatch [regex]::Escape($CrawlerConfig)
  } | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Stop-StaleClashFixScripts {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "powershell.exe" -or $_.Name -eq "cmd.exe") -and
    $_.CommandLine -match "fix-clash-qg-yaml|restore-clash-qg-us|patch-clash-qg|test-proxy-sites\.cmd"
  } | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
}

while ($true) {
  $cycle++
  Stop-StaleClashFixScripts
  Stop-VergeGui
  Stop-WrongMihomo

  $needEnsure = -not (Test-PortListening -Port $MixedPort)
  if (-not $needEnsure) {
    $mihomo = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq "verge-mihomo.exe" -and $_.CommandLine -match [regex]::Escape($CrawlerConfig)
    } | Select-Object -First 1
    if (-not $mihomo) { $needEnsure = $true }
  }

  if ($needEnsure -and (Test-Path $EnsureScript)) {
    $skipProbe = ($cycle % $ProbeEvery -ne 0)
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $EnsureScript, "-ProjectRoot", $Root)
    if ($skipProbe) { $argList += "-SkipTikTokProbe" }
    & powershell.exe @argList
  }

  Start-Sleep -Seconds 15
}
