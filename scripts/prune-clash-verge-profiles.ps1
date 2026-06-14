# 可选：爬虫机移除 Clash Verge 多余订阅，避免自动刷新覆盖 QG 分流。
# 默认仅输出建议；加 -Apply 才会改 profiles.yaml（备份后保留 QgTunnelMerge）。
param(
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$ConfigDir = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$ProfilesPath = Join-Path $ConfigDir "profiles.yaml"

if (-not (Test-Path $ProfilesPath)) {
  Write-Host "[prune] profiles.yaml not found; nothing to do"
  exit 0
}

$raw = Get-Content $ProfilesPath -Raw
Write-Host "[prune] current profiles.yaml (first 40 lines):"
Get-Content $ProfilesPath | Select-Object -First 40 | ForEach-Object { Write-Host "  $_" }

Write-Host ""
Write-Host "[prune] recommendation:"
Write-Host "  - Crawler VMs should use scripts/ensure-clash-qg-tiktok.ps1 (standalone mihomo + crawler-clash.yaml)."
Write-Host "  - Clash Verge GUI + remote subscriptions (Clash_1764907913 / 山海等) are NOT required on crawlers."
Write-Host "  - If Verge is kept for RDP debugging, disable auto-update on subscriptions and keep merge: QgTunnelMerge."
Write-Host "  - Safer: uninstall/disable Verge autostart; rely only on ensure-clash-qg-tiktok.ps1."

if (-not $Apply) {
  Write-Host "[prune] dry-run only (pass -Apply to disable auto-update on remote subscription items)"
  exit 0
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $ProfilesPath "$ProfilesPath.bak-$stamp" -Force
$content = $raw
$content = $content -replace "allow_auto_update: true", "allow_auto_update: false"
$content = $content -replace "update_interval: \d+", "update_interval: 0"
Set-Content -Path $ProfilesPath -Value $content -Encoding UTF8
Write-Host "[prune] applied: disabled auto-update on profiles (backup: profiles.yaml.bak-$stamp)"
