$ErrorActionPreference = "Continue"
$proxy = "http://127.0.0.1:7897"
$sites = @(
  @{ name = "instagram"; url = "https://www.instagram.com/" },
  @{ name = "tiktok"; url = "https://www.tiktok.com/" },
  @{ name = "youtube"; url = "https://www.youtube.com/" }
)

Write-Host "=== proxy site test via Clash $proxy ==="
$listen = netstat -an | Select-String "127.0.0.1:7897.*LISTENING"
if (-not $listen) {
  Write-Host "FAIL: 7897 not listening"
  exit 1
}

foreach ($s in $sites) {
  Write-Host ""
  Write-Host "[$($s.name)] HEAD"
  $head = curl.exe -sI --max-time 30 -x $proxy $s.url 2>&1
  Write-Host $head
  $headOk = ($head -match "HTTP/1\.1 200" -or $head -match "HTTP/2 200" -or $head -match "HTTP/1\.1 301" -or $head -match "HTTP/2 301" -or $head -match "HTTP/1\.1 302" -or $head -match "HTTP/2 302")

  Write-Host "[$($s.name)] GET"
  $code = curl.exe -s -o NUL -w "%{http_code}" --max-time 40 --http1.1 -x $proxy $s.url 2>&1
  Write-Host "  http_code=$code"
  $getOk = ($code -eq "200" -or $code -eq "301" -or $code -eq "302" -or $code -eq "403")
  if ($headOk -and $getOk) {
    Write-Host "  RESULT=OK"
  } elseif ($headOk) {
    Write-Host "  RESULT=PARTIAL (CONNECT ok, GET fail)"
  } else {
    Write-Host "  RESULT=FAIL"
  }
}

Write-Host ""
Write-Host "=== exit ip via tunnel ==="
curl.exe -s --max-time 20 -x $proxy https://api.ipify.org
Write-Host ""
Write-Host "=== done ==="
