$d = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$mihomo = "C:\Program Files\Clash Verge\verge-mihomo.exe"
Get-ChildItem $d -Filter "clash-verge.yaml.bak-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 8 | ForEach-Object {
  & $mihomo -t -f $_.FullName 2>&1 | Out-Null
  Write-Host "$($_.Name) exit=$LASTEXITCODE"
}
