@echo off
setlocal
cd /d "%~dp0"
echo ==================================================================
echo  Luke Shop Backend v0.10.0 - Store Designer Engine v3
echo ==================================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\START-HERE.ps1"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo SUCCESS: Luke Shop Backend v0.10.0 setup checks finished.
) else (
  echo FAILURE: setup returned exit code %RC%.
)
echo.
echo Next: start PostgreSQL, run npm run migrate, then run the required live database suites for your environment.
echo Press any key to close this window...
pause >nul
exit /b %RC%
