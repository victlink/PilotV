@echo off
REM PilotV launcher wrapper: bypass the PowerShell execution policy.
REM Usage: start-windows.cmd [-Status|-Stop]
REM ASCII-only + CRLF is mandatory (cmd.exe mis-parses LF-only batch files).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1" %*
