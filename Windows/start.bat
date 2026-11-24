@echo off
setlocal
cd /d "%~dp0.."

echo.
echo ========================================
echo        Open Watch Cinema
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 24 or newer, then run this file again.
  echo.
  pause
  exit /b 1
)

where ffprobe >nul 2>nul
if errorlevel 1 (
  echo FFprobe was not found.
  echo Install FFmpeg and make sure ffmpeg.exe and ffprobe.exe are on PATH.
  echo.
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo FFmpeg was not found.
  echo Install FFmpeg and make sure ffmpeg.exe and ffprobe.exe are on PATH.
  echo.
  pause
  exit /b 1
)

node server.mjs --default-browser
set EXIT_CODE=%ERRORLEVEL%

echo.
if not "%EXIT_CODE%"=="0" (
  echo The cinema stopped with exit code %EXIT_CODE%.
  echo Copy this terminal output when asking your AI for help.
) else (
  echo The cinema has stopped.
)
echo.
pause
exit /b %EXIT_CODE%
