$ErrorActionPreference='Stop'
$p='C:\maxinfluencer\package.json'
$j=Get-Content -Raw -Path $p | ConvertFrom-Json
$j | Add-Member -NotePropertyName type -NotePropertyValue module -Force
$j | ConvertTo-Json -Depth 100 | Set-Content -Path $p -Encoding UTF8
Write-Host 'updated package.json type=module'
