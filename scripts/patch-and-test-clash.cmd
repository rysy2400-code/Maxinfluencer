powershell -NoProfile -ExecutionPolicy Bypass -File C:\maxinfluencer\scripts\patch-clash-qg-us.ps1
timeout /t 3 /nobreak >nul
tasklist /FI "IMAGENAME eq verge-mihomo.exe"
netstat -an | findstr "7897.*LISTENING"
curl.exe -s -o nul -w "clash_tt=%%{http_code}\n" --max-time 25 --http1.1 -x http://127.0.0.1:7897 https://www.tiktok.com/
curl.exe -s -o nul -w "clash_ig=%%{http_code}\n" --max-time 25 --http1.1 -x http://127.0.0.1:7897 https://www.instagram.com/
curl.exe -s -o nul -w "clash_yt=%%{http_code}\n" --max-time 25 --http1.1 -x http://127.0.0.1:7897 https://www.youtube.com/
curl.exe -s --max-time 15 -x http://127.0.0.1:7897 https://api.ipify.org
echo.
