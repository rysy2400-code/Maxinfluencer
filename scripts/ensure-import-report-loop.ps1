# 在控制面（152.32.216.107）上以 PM2 常驻唯一的导入完成汇报循环。
# 幂等：先按名删除再启动，确保只存在一条 maxin-import-report；pm2 save 以便开机恢复。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure-import-report-loop.ps1

$ErrorActionPreference = "Stop"

$Root = "C:\maxinfluencer"
if (-not (Test-Path $Root)) { throw "Deploy root not found: $Root" }
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node not found in PATH. Install Node.js LTS."
}
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  throw "pm2 not found in PATH. Install: npm i -g pm2"
}

$name = "maxin-import-report"
$script = Join-Path $Root "scripts\run-import-report-loop.mjs"
if (-not (Test-Path $script)) { throw "missing $script" }

Write-Host "[ensure-import-report-loop] pm2 delete $name (best-effort, ensure single instance)..."
try { & pm2 delete $name | Out-Null } catch {}

Write-Host "[ensure-import-report-loop] pm2 start $name via node (ESM flags as args)..."
& pm2 start node --name $name --cwd $Root -- --experimental-default-type=module $script
& pm2 save

Write-Host "[ensure-import-report-loop] pm2 list:"
& pm2 list

Write-Host "[ensure-import-report-loop] Done."
