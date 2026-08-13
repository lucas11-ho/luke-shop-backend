@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  echo ERROR: .env does not exist. Run START-HERE-WINDOWS.bat first and configure it.
  pause
  exit /b 1
)
node --env-file=.env src/server.js
set "RC=%ERRORLEVEL%"
echo.
echo Server stopped with exit code %RC%.
pause
exit /b %RC%
