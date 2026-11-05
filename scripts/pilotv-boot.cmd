@echo off
REM PilotV login-autostart fallback (ASCII-only + CRLF is mandatory:
REM cmd.exe mis-parses LF-only batch files and loops on truncated commands).
REM The scheduled task "PilotV-Startup" is the single owner of the four
REM services. This script is only a manual/fallback entry; it stays idempotent
REM so having both entries can never start a second copy of anything.
cd /d "%~dp0.."
if not exist ".run" mkdir ".run"
REM Keep the log bounded even if a launcher ever misbehaves again.
for %%F in (".run\autostart.log") do if %%~zF GTR 5242880 move /y ".run\autostart.log" ".run\autostart.prev.log" >nul 2>&1
echo ================ %DATE% %TIME% login autostart ================ >> ".run\autostart.log"

set "READY=1"
for %%P in (8799 18789 3001 5186) do (
  netstat -ano | findstr /C:":%%P " | findstr /C:"LISTENING" >nul 2>&1
  if errorlevel 1 set "READY=0"
)
if "%READY%"=="1" (
  echo ---- all four services already listening; nothing to do ---- >> ".run\autostart.log"
  exit /b 0
)

echo ---- one or more services down; invoking start-windows.ps1 ---- >> ".run\autostart.log"
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0..\start-windows.ps1" >> ".run\autostart.log" 2>&1
echo ---- launcher exited with %ERRORLEVEL% ---- >> ".run\autostart.log"
exit /b 0
