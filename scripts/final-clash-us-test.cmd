@echo off
set D=%APPDATA%\io.github.clash-verge-rev.clash-verge-rev
copy /Y "%D%\clash-verge.yaml.bak-20260615-022306" "%D%\clash-verge.yaml" >nul
powershell -NoProfile -Command "(Get-Content '%D%\clash-verge.yaml') -replace 'overseas.tunnel.qg.net','overseas-us.tunnel.qg.net' -replace 'port: 15561','port: 16364' | Set-Content '%D%\clash-verge.yaml' -Encoding UTF8"
"C:\Program Files\Clash Verge\verge-mihomo.exe" -t -f "%D%\clash-verge.yaml"
if errorlevel 1 (echo YAML_INVALID & exit /b 1)
echo YAML_OK

taskkill /F /IM verge-mihomo.exe 2>nul
taskkill /F /IM clash-verge.exe 2>nul
timeout /t 2 /nobreak >nul
start "" /B "C:\Program Files\Clash Verge\verge-mihomo.exe" -f "%D%\clash-verge.yaml" -d "%D%"
timeout /t 8 /nobreak >nul

call C:\maxinfluencer\scripts\test-proxy-sites.cmd
