@echo off
setlocal
set MODE=%~1
if "%MODE%"=="" set MODE=urgent
cd /d "C:\maxinfluencer"
if not exist "logs" mkdir "logs"
node --experimental-default-type=module scripts\process-influencer-agent-events.js --mode=%MODE% >> "logs\process-agent-events-%MODE%.log" 2>&1
exit /b %ERRORLEVEL%
