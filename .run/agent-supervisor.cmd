@echo off
REM PilotV agent gateway supervisor - thin wrapper (ASCII-only + CRLF).
REM The real supervisor is agent-supervisor.mjs. It spawns the gateway as a
REM DETACHED process, so recycling this cmd console can no longer send
REM CTRL_CLOSE to node and silently kill the gateway.
REM Kept as .cmd because the gateway-keeper plugin (3001) launches this path.
setlocal
set "NODE="
for /f "delims=" %%D in ('dir /b /ad /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
  if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\node.exe"
)
if not defined NODE set "NODE=node"
"%NODE%" "%~dp0agent-supervisor.mjs" >> "%~dp0supervisor.wrapper.log" 2>&1
REM Pass through node's real exit code. The old "exit /b 0" disguised a crash
REM as a clean exit, so keeper could not tell a healthy stop from a fatal error.
exit /b %ERRORLEVEL%
