@echo off
set DIRECT=http://O9QJT6VG:76B9A79198D4@overseas-us.tunnel.qg.net:16364
set CLASH=http://127.0.0.1:7897

echo === DIRECT %DIRECT% ===
curl.exe -s -o nul -w "google=%%{http_code}\n" --max-time 35 --http1.1 -x %DIRECT% https://www.google.com/
curl.exe -s -o nul -w "instagram=%%{http_code}\n" --max-time 35 --http1.1 -x %DIRECT% https://www.instagram.com/
curl.exe -s -o nul -w "tiktok=%%{http_code}\n" --max-time 35 --http1.1 -x %DIRECT% https://www.tiktok.com/
curl.exe -s -o nul -w "youtube=%%{http_code}\n" --max-time 35 --http1.1 -x %DIRECT% https://www.youtube.com/
echo ipify:
curl.exe -s --max-time 20 -x %DIRECT% https://api.ipify.org
echo.

echo === CLASH %CLASH% ===
netstat -an | findstr "7897.*LISTENING"
curl.exe -s -o nul -w "google=%%{http_code}\n" --max-time 35 --http1.1 -x %CLASH% https://www.google.com/
curl.exe -s -o nul -w "instagram=%%{http_code}\n" --max-time 35 --http1.1 -x %CLASH% https://www.instagram.com/
curl.exe -s -o nul -w "tiktok=%%{http_code}\n" --max-time 35 --http1.1 -x %CLASH% https://www.tiktok.com/
curl.exe -s -o nul -w "youtube=%%{http_code}\n" --max-time 35 --http1.1 -x %CLASH% https://www.youtube.com/
echo ipify:
curl.exe -s --max-time 20 -x %CLASH% https://api.ipify.org
echo.
