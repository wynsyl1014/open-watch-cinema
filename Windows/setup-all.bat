@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul && goto install
echo Complete setup needs Node.js 24+. You can use an existing installation on PATH.
for %%A in (%*) do if /i "%%~A"=="--plan" goto bootstrapPlan
where winget >nul 2>nul || goto missingNode
for %%A in (%*) do if /i "%%~A"=="--yes" goto getNode
choice /M "Install Node.js LTS with winget"
if errorlevel 2 exit /b 0
:getNode
winget install --id OpenJS.NodeJS.LTS -e
if errorlevel 1 exit /b 1
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs"
where node >nul 2>nul && goto install
:missingNode
echo Make Node.js 24+ available, reopen the terminal, and rerun setup.
if "%~1"=="" pause
exit /b 1
:bootstrapPlan
echo Missing Node.js. You can run winget install --id OpenJS.NodeJS.LTS -e or use your preferred Node manager.
echo After adding Node, rerun --plan to inspect Python and FFmpeg.
exit /b 0
:install
node scripts/preparation/setup.mjs all %*
set RESULT=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %RESULT%
