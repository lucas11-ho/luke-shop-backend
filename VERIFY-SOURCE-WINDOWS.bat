@echo off
setlocal
cd /d "%~dp0"
echo ==================================================================
echo  Luke Shop Backend v0.5.0 - CS Connector Source Verification
echo ==================================================================
echo.
call npm run verify
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo PASS: Luke Shop Backend v0.5.0 dependency-free verification completed.
) else (
  echo FAILURE: source verification returned exit code %RC%.
)
echo.
echo Press any key to close this window...
pause >nul
exit /b %RC%
