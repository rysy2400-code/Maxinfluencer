# Periodic IPWEB SID rotation for the TikTok browser (port 9222 -> mihomo 7896).
# Keeps the browser on a fresh residential IP so a single IP does not get burned.
$Root = "C:\maxinfluencer"
$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) { $node = "node" }
$log = Join-Path $Root "logs\ipweb-rotate.log"
Set-Location $Root
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] rotate start" | Out-File -FilePath $log -Append -Encoding UTF8
& $node --experimental-default-type=module (Join-Path $Root "scripts\rotate-103-ipweb-sid.mjs") 2>&1 |
  Out-File -FilePath $log -Append -Encoding UTF8
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] rotate exit=$LASTEXITCODE" | Out-File -FilePath $log -Append -Encoding UTF8
