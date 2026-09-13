@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore.ps1"
set "MBOX_RECOVERY_EXIT=%errorlevel%"
echo.
echo Recovery finished. Read the Chinese result window for the actual status.
echo Keep MBOX-Recovery-Diagnostics.json for support. Do not re-run the upgrade.
pause
exit /b %MBOX_RECOVERY_EXIT%
