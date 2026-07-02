$ErrorActionPreference = "Continue"
$Root = "C:\maxinfluencer"

Write-Host "=== CDP health ==="
foreach ($port in @(9222, 9223)) {
  try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 5
    Write-Host "port $port OK Browser=$($v.Browser)"
  } catch {
    Write-Host "port $port FAIL $($_.Exception.Message)"
  }
}

Write-Host "`n=== Profile dirs ==="
foreach ($dir in @(
  "C:\maxinfluencer\.chrome-cdp-9222",
  "C:\maxinfluencer\.chrome-cdp-9223",
  "C:\maxinfluencer\.tiktok-user-data",
  "C:\maxinfluencer\.tiktok-user-data-enrich"
)) {
  if (Test-Path $dir) {
    $size = (Get-ChildItem $dir -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $cookies = Join-Path $dir "Default\Cookies"
    $ckInfo = if (Test-Path $cookies) {
      $i = Get-Item $cookies
      "Cookies=$([math]::Round($i.Length/1KB,1))KB mtime=$($i.LastWriteTime)"
    } else { "Cookies=MISSING" }
    Write-Host "$dir size=$([math]::Round($size/1MB,1))MB $ckInfo"
  } else {
    Write-Host "$dir MISSING"
  }
}

Write-Host "`n=== Chrome processes (9222/9223) ==="
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match "chrome" -and $_.CommandLine -match "remote-debugging-port=922" } |
  ForEach-Object {
    $cl = $_.CommandLine
    if ($cl.Length -gt 220) { $cl = $cl.Substring(0, 220) + "..." }
    Write-Host "pid=$($_.ProcessId) $cl"
  }

Write-Host "`n=== run-guard-chrome-9222.ps1 (generated) ==="
$g9222 = Join-Path $Root "scripts\run-guard-chrome-9222.ps1"
if (Test-Path $g9222) { Get-Content $g9222 | Select-String "CHROME_9222|launch|URL|USER_DATA" }

Write-Host "`n=== .env CHROME / CDP keys ==="
foreach ($f in @(".env", ".env.local")) {
  $p = Join-Path $Root $f
  if (Test-Path $p) {
    Write-Host "-- $f --"
    Get-Content $p | Select-String "CHROME|CDP|9222|9223|INSTAGRAM|TIKTOK|SCRAPER|SEARCH_WORKER"
  }
}

Write-Host "`n=== Scheduled tasks ==="
foreach ($tn in @("maxin-guard-chrome-9222", "maxin-guard-chrome-9223", "maxin-guard-crawler-search")) {
  schtasks.exe /Query /TN $tn /FO LIST 2>$null | Select-String "TaskName|Status|Last Run|Last Result"
}

Write-Host "`n=== Login probe via CDP (requires playwright on machine - skip if missing) ==="
$node = "C:\Program Files\nodejs\node.exe"
$probeJs = @'
import { chromium } from "playwright";
async function probe(endpoint, url, checks) {
  try {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 8000 });
    const ctx = browser.contexts()[0] || await browser.newContext();
    let page = ctx.pages().find(p => p.url().includes(new URL(url).hostname)) || ctx.pages()[0];
    if (!page) page = await ctx.newPage();
    if (!page.url().includes(new URL(url).hostname)) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const cookies = await ctx.cookies([url]);
    const names = cookies.map(c => c.name).slice(0, 20);
    const body = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasLoginBtn: !!document.querySelector('[data-e2e="top-login-button"], a[href*="/login"]'),
      snippet: (document.body?.innerText || "").slice(0, 200),
    }));
    console.log(JSON.stringify({ endpoint, url, cookieCount: cookies.length, cookieNames: names, ...body }));
    await browser.close();
  } catch (e) {
    console.log(JSON.stringify({ endpoint, url, error: e.message }));
  }
}
await probe("http://127.0.0.1:9222", "https://www.tiktok.com/", "tiktok");
await probe("http://127.0.0.1:9222", "https://www.instagram.com/", "instagram");
'@
$probePath = Join-Path $Root "logs\login-probe-tmp.mjs"
Set-Content -Path $probePath -Value $probeJs -Encoding UTF8
if (Test-Path $node) {
  Push-Location $Root
  & $node --experimental-default-type=module $probePath 2>&1
  Pop-Location
}
