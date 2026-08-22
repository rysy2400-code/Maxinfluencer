param([int]$CdpPort = 0, [switch]$Headless)
$map = @{
  9222 = @{ proxy = 7897; dir = "C:\maxinfluencer\.chrome-cdp-9222" }
  9223 = @{ proxy = 7898; dir = "C:\maxinfluencer\.chrome-cdp-9223" }
  9224 = @{ proxy = 7899; dir = "C:\maxinfluencer\.chrome-cdp-9224" }
  9225 = @{ proxy = 7900; dir = "C:\maxinfluencer\.chrome-cdp-9225" }
}
$ports = if ($CdpPort -gt 0) { @($CdpPort) } else { @(9222, 9223, 9224, 9225) }
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
foreach ($cp in $ports) {
  $cfg = $map[$cp]
  if (-not $cfg) { continue }
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
    $_.CommandLine -match ("remote-debugging-port=" + $cp)
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 3
  if (Test-Path $cfg.dir) {
    Remove-Item $cfg.dir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $args = @(
    "--disable-gpu",
    "--disable-quic",
    if ($Headless) { "--headless=new" },
    "--remote-debugging-address=127.0.0.1",
    ("--remote-debugging-port=" + $cp),
    ("--user-data-dir=" + $cfg.dir),
    ("--proxy-server=http://127.0.0.1:" + $cfg.proxy),
    "--no-first-run",
    "--no-default-browser-check",
    "--blink-settings=imagesEnabled=false",
    "--autoplay-policy=user-gesture-required",
    "about:blank"
  )
  Start-Process -FilePath $chrome -ArgumentList $args -WindowStyle Hidden
  Start-Sleep 16
  $v = curl.exe -s -m 8 ("http://127.0.0.1:" + $cp + "/json/version")
  Write-Output ("fresh cdp " + $cp + " ok=" + ($v -match "Chrome/"))
}
