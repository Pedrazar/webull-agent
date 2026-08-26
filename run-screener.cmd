@echo off
cd /d "C:\Users\pedra\projects\webull-agent"
set LOGFILE=screener-run-%date:~-4,4%-%date:~-10,2%-%date:~-7,2%_%time:~0,2%%time:~3,2%.log
set LOGFILE=%LOGFILE: =0%
powershell -NoProfile -ExecutionPolicy Bypass -File check-battery.ps1 >> "%LOGFILE%" 2>&1
if errorlevel 1 exit /b 0
npx tsx stockScreener.ts >> "%LOGFILE%" 2>&1
