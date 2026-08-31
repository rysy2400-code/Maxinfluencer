$ErrorActionPreference = 'Continue'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -match 'remote-debugging-port=9225' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 4
$chromeArgs = @(
  '--disable-gpu',
  '--disable-quic',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9225',
  '--user-data-dir=C:\maxinfluencer\.chrome-cdp-9225',
  '--proxy-server=http://127.0.0.1:7900',
  '--no-first-run',
  '--no-default-browser-check',
  '--blink-settings=imagesEnabled=false',
  '--autoplay-policy=user-gesture-required',
  'https://www.tiktok.com/@tiktok'
)
Start-Process -FilePath $chrome -ArgumentList $chromeArgs -WindowStyle Hidden
Start-Sleep 15
$v = curl.exe -s -m 8 http://127.0.0.1:9225/json/version
Write-Host ('cdp 9225 ok=' + ($v -match 'Chrome/'))
