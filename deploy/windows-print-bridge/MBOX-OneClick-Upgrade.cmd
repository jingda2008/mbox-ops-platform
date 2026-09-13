@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0upgrade.ps1"
set "MBOX_EXIT=%errorlevel%"

echo.
if "%MBOX_EXIT%"=="0" (
  echo MBOX Print Bridge upgrade finished successfully.
) else (
  echo Upgrade did not complete. Existing printer configuration was preserved.
)
echo Press any key to close this window.
pause >nul
exit /b %MBOX_EXIT%
