$ErrorActionPreference = "SilentlyContinue"
$Root = "C:\maxinfluencer"
$ConfigDir = Join-Path $Root "config"
$StateFile = Join-Path $ConfigDir "endpoint-health-state.json"
$LogFile = Join-Path $Root "logs\endpoint-health.log"
$IntervalSec = 300
$FailThreshold = 2
$RebuildCooldownSec = 600
$NodeExe = "C:\Program Files\nodejs\node.exe"
$RebuildScript = Join-Path $Root "scripts\rebuild-tiktok-endpoint-pool.mjs"

function Write-Log($Msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Msg"
  Add-Content -Path $LogFile -Value $line
}

function Get-EnvValue($Path, $Key) {
  if (-not (Test-Path $Path)) { return "" }
  foreach ($line in (Get-Content $Path)) {
    if ($line -match ("^\s*" + [regex]::Escape($Key) + "\s*=(.*)$")) {
      return $Matches[1].Trim()
    }
  }
  return ""
}

function Get-ProxyPorts {
  $ports = @(7897)
  $map = Get-EnvValue (Join-Path $Root ".env.local") "TT_LITE_ENDPOINT_POOL_MAP"
  if ($map) {
    foreach ($seg in ($map -split ",")) {
      $parts = @($seg -split ":")
      if ($parts.Count -ge 2 -and $parts[1] -match "^\d+$") {
        $ports += [int]$parts[1]
      }
    }
  } else {
    $ports += @(7898, 7899, 7900)
  }
  return @($ports | Sort-Object -Unique)
}

function Test-Endpoint($Port) {
  $code = & curl.exe -s -o NUL -w "%{http_code}" -x "http://127.0.0.1:$Port" --max-time 25 "https://www.tiktok.com/" 2>$null
  return ($code -eq "200")
}

$state = $null
if (Test-Path $StateFile) {
  try { $state = (Get-Content $StateFile -Raw | ConvertFrom-Json) } catch {}
}
$lastRebuild = 0
if ($state -and $state.lastRebuild) { $lastRebuild = [long]$state.lastRebuild }
$fail = @{}
if ($state -and $state.fail) {
  $state.fail.PSObject.Properties | ForEach-Object {
    $fail[[int]$_.Name] = [int]$_.Value
  }
}

Write-Log "guard started interval=$IntervalSec threshold=$FailThreshold"

while ($true) {
  $rebuildNeeded = $false
  foreach ($port in (Get-ProxyPorts)) {
    $ok = Test-Endpoint $port
    if ($ok) {
      $fail[$port] = 0
    } else {
      if ($fail.ContainsKey($port)) { $fail[$port] += 1 } else { $fail[$port] = 1 }
      Write-Log "endpoint :$port FAIL count=$($fail[$port])"
      if ($fail[$port] -ge $FailThreshold) { $rebuildNeeded = $true }
    }
  }

  $nowSec = [long]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  if ($rebuildNeeded -and (($nowSec - $lastRebuild) -ge $RebuildCooldownSec)) {
    Write-Log "rebuild triggered fail=$($fail | ConvertTo-Json -Compress)"
    $out = & $NodeExe --experimental-default-type=module $RebuildScript 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    $trimmed = $out
    if ($trimmed.Length -gt 800) { $trimmed = $trimmed.Substring(0, 800) }
    Write-Log "rebuild exit=$exitCode $trimmed"
    $lastRebuild = [long]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
    foreach ($port in (Get-ProxyPorts)) { $fail[$port] = 0 }
  }

  $state = [ordered]@{ fail = [ordered]@{}; lastRebuild = $lastRebuild }
  foreach ($key in $fail.Keys) { $state.fail["$key"] = $fail[$key] }
  try {
    $state | ConvertTo-Json -Compress | Set-Content -Path $StateFile -Encoding UTF8
  } catch {}
  Start-Sleep -Seconds $IntervalSec
}
