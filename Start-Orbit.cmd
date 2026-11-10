@echo off
setlocal

rem Project folder

cd /d "%~dp0"
set "ORBIT_NODE="

rem Current PATH

for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined ORBIT_NODE set "ORBIT_NODE=%%I"

rem Local Node

if not defined ORBIT_NODE if exist "%LOCALAPPDATA%\Programs\ai-agent-node\node-v24.22.1-win-x64\node.exe" set "ORBIT_NODE=%LOCALAPPDATA%\Programs\ai-agent-node\node-v24.22.1-win-x64\node.exe"

rem Codex Node

if not defined ORBIT_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "ORBIT_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

rem Local server

if not defined ORBIT_NODE (
  echo Node.js 22.18 or newer is required
  echo Install Node.js, then open Start-Orbit.cmd again
  pause
  exit /b 1
)

"%ORBIT_NODE%" "%~dp0scripts\dev.mjs"

if errorlevel 1 pause

endlocal
