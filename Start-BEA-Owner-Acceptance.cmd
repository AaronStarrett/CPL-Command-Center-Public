@echo off
setlocal
cd /d "%~dp0"

echo BEA Operations Command Center
echo Owner Evaluation - live OpenAI, synthetic BEA data
echo PostgreSQL is not required for this evaluation runtime.
echo.

echo %CD% | find /I "Cyber Pirate Labs Command Center" >nul
if not errorlevel 1 (
  echo BEA_OWNER_EVALUATION=BLOCKED
  echo This launcher was started from the protected sibling path.
  echo Move the package to C:\CPL-Dev\BEA-Automation-Command-Center.
  echo Do not read or change the protected Cyber Pirate Labs folder.
  echo.
  pause
  exit /b 1
)

if /I not "%CD%"=="C:\CPL-Dev\BEA-Automation-Command-Center" (
  echo BEA_OWNER_EVALUATION=BLOCKED
  echo This package must run from:
  echo   C:\CPL-Dev\BEA-Automation-Command-Center
  echo Current folder:
  echo   %CD%
  echo Extract again to the required path. Nothing was configured.
  echo.
  pause
  exit /b 1
)

set "BEA_NODE=%LOCALAPPDATA%\BEA\CommandCenter\toolchain\node-v24.19.0-win-x64\node.exe"
if not exist "%BEA_NODE%" (
  echo BEA_OWNER_EVALUATION=SETUP_REQUIRED
  echo The BEA-owned Node toolchain is not installed yet.
  echo Double-click Ensure-BEA-Toolchain.cmd
  echo When asked, type:
  echo   INSTALL BEA TOOLCHAIN
  echo Then double-click Start-BEA-Owner-Acceptance.cmd again.
  echo Do not paste an OpenAI key into Command Prompt or a file.
  echo.
  pause
  exit /b 1
)

call "%~dp0Ensure-BEA-Toolchain.cmd" --check
if errorlevel 1 (
  echo BEA_OWNER_EVALUATION=SETUP_REQUIRED
  echo Toolchain check failed. Double-click Ensure-BEA-Toolchain.cmd first.
  echo.
  pause
  exit /b %errorlevel%
)

"%BEA_NODE%" scripts\repository-boundary.mjs
if errorlevel 1 (
  echo BEA_OWNER_EVALUATION=BLOCKED
  echo Repository boundary refused this folder. Nothing was configured.
  echo.
  pause
  exit /b %errorlevel%
)

"%BEA_NODE%" scripts\phase21\owner-acceptance-preflight.mjs
if errorlevel 1 (
  echo.
  echo Owner Evaluation preflight failed. The Command Prompt stays open so you can read the error.
  echo Do not paste an OpenAI key into Command Prompt, PowerShell, Cursor, or .env.local.
  echo.
  pause
  exit /b %errorlevel%
)

echo Starting Owner Evaluation. Paste the OpenAI key inside the application after sign-in.
"%BEA_NODE%" scripts\owner-evaluation-start.mjs %*
set "BEA_EXIT=%ERRORLEVEL%"
if not "%BEA_EXIT%"=="0" (
  echo.
  echo BEA_OWNER_EVALUATION=BLOCKED
  echo Owner Evaluation did not start. The Command Prompt stays open so you can read the error.
  echo.
  pause
)
exit /b %BEA_EXIT%
