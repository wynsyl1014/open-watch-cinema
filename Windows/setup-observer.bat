@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul || (
  echo Install Node.js 24+ using your usual setup or winget install --id OpenJS.NodeJS.LTS -e
  pause
  exit /b 1
)
node scripts/preparation/setup.mjs observer %*
set RESULT=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %RESULT%
