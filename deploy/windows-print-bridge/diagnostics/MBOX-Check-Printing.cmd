@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1"
set "MBOX_CHECK_EXIT=%errorlevel%"
echo.
echo Check finished. Send the MBOX-Check-Result ZIP from this folder to Codex.
pause
exit /b %MBOX_CHECK_EXIT%
