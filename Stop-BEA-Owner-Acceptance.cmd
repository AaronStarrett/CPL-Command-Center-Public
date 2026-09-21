@echo off
setlocal
cd /d "%~dp0"

echo BEA Operations Command Center
echo Owner Evaluation stop
echo.

echo %CD% | find /I "Cyber Pirate Labs Command Center" >nul
if not errorlevel 1 (
  echo BEA_OWNER_EVALUATION=BLOCKED
  echo This launcher was started from the protected sibling path.
  echo No processes were terminated.
  echo.
  pause
  exit /b 1
)

if /I not "%CD%"=="C:\CPL-Dev\BEA-Automation-Command-Center" (
  echo BEA_OWNER_EVALUATION=BLOCKED
  echo Stop only from:
  echo   C:\CPL-Dev\BEA-Automation-Command-Center
  echo Current folder:
  echo   %CD%
  echo No processes were terminated.
  echo.
  pause
  exit /b 1
)

set "BEA_NODE=%LOCALAPPDATA%\BEA\CommandCenter\toolchain\node-v24.19.0-win-x64\node.exe"
if not exist "%BEA_NODE%" (
  echo BEA_OWNER_EVALUATION=BLOCKED
  echo Canonical BEA Node is unavailable. No processes were terminated.
  echo.
  pause
  exit /b 1
)

"%BEA_NODE%" scripts\repository-boundary.mjs
if errorlevel 1 (
  echo BEA_OWNER_EVALUATION=BLOCKED
  echo Repository boundary refused this folder. No processes were terminated.
  echo.
  pause
  exit /b %errorlevel%
)

"%BEA_NODE%" scripts\owner-evaluation-stop.mjs %*
set "BEA_EXIT=%ERRORLEVEL%"
if not "%BEA_EXIT%"=="0" (
  echo.
  echo BEA_OWNER_EVALUATION=BLOCKED
  echo Exact-child stop failed. No broad process termination was used.
  echo.
  pause
  exit /b %BEA_EXIT%
)

echo BEA_OWNER_EVALUATION=STOPPED
exit /b 0
