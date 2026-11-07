@echo off
REM ================================================================
REM  PilotV Agent Gateway (18789) - resident launcher
REM  Usage: double-click this file. Keep the minimized window open.
REM  Why: the gateway runs inside its OWN console, so it cannot be
REM       dragged down by CTRL_CLOSE when another launcher exits, and
REM       it restarts automatically (3s) after a crash, which is what
REM       prevents "page opens but the project never loads".
REM  Stop: close this window, or press Ctrl+C twice inside it.
REM  NOTE: this file must stay CRLF + pure ASCII. cmd.exe mis-parses
REM       LF-only batch files and fell into an infinite restart loop
REM       (autostart.log grew to 1.82 GB). See verify_windows.ps1 #3.
REM ================================================================
title PilotV Agent Gateway 18789 -- DO NOT CLOSE THIS WINDOW
setlocal

set "NODE=C:\Users\music\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "UPDIR=C:\Users\music\projects\pilotv\pilotdeck-mobile\upstream-official"
set "LOGFILE=C:\Users\music\projects\pilotv\.run\agent.log"

if not exist "%NODE%" (
  echo [ERROR] node not found: %NODE%
  pause
  exit /b 1
)
if not exist "%UPDIR%\src\cli\pilotdeck.ts" (
  echo [ERROR] upstream dir not found: %UPDIR%
  pause
  exit /b 1
)

REM Skip when an instance already owns the port (do not fight for 18789).
netstat -ano | findstr /C:"127.0.0.1:18789" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [SKIP] 18789 already listening - another gateway instance is running.
  echo        Nothing to do. Close this window.
  timeout /t 8 >nul
  exit /b 0
)

cd /d "%UPDIR%"

:loop
echo.
echo [%date% %time%] starting PilotDeck gateway on 18789 ...
"%NODE%" --import tsx src\cli\pilotdeck.ts server --port 18789
echo [%date% %time%] gateway exited (code=%ERRORLEVEL%), restarting in 3s ...
timeout /t 3 /nobreak >nul
goto loop
