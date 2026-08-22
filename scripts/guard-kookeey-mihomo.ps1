# kookeey 专用 mihomo 守护：只监控 4 个 kookeey 混合端口(7897-7900)，
# 任一端口掉线即用 start-kookeey-mihomo.ps1 重启全部 4 个 kookeey 实例。
# 不复用任何旧订阅/CLASH_SUB_URL，避免回退到失效的 tk-ip/xss1 配置。
$ErrorActionPreference = "SilentlyContinue"
$RestartScript = "C:\maxinfluencer\config\start-kookeey-mihomo.ps1"
$Ports = 7897, 7898, 7899, 7900

function Test-PortListening {
  param([int]$Port)
  try {
    $c = New-Object Net.Sockets.TcpClient
    $t = $c.ConnectAsync("127.0.0.1", $Port)
    if (-not $t.Wait(1200)) { $c.Dispose(); return $false }
    if ($c.Connected) { $c.Close(); return $true }
    $c.Dispose(); return $false
  } catch { return $false }
}

$lastRestart = $null
while ($true) {
  $down = @($Ports | Where-Object { -not (Test-PortListening -Port $_) })
  if ($down.Count -gt 0) {
    $now = Get-Date
    if (-not $lastRestart -or (($now - $lastRestart).TotalSeconds -ge 60)) {
      Write-Host ("[guard-kookeey-mihomo] ports down: " + ($down -join ",") + " -> restart")
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RestartScript
      $lastRestart = Get-Date
    }
  }
  Start-Sleep -Seconds 10
}
