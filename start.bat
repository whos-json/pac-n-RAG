@echo off
rem Starts PAC&RAG and opens it in your browser. Close this window to stop it.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
start "" "http://localhost:4747"
node server.js
pause
