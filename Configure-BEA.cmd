@echo off
setlocal
cd /d "%~dp0"

set "BEA_NODE=%LOCALAPPDATA%\BEA\CommandCenter\toolchain\node-v24.19.0-win-x64\node.exe"
set "BEA_PNPM=%LOCALAPPDATA%\BEA\CommandCenter\toolchain\bin\pnpm.cmd"

if "%~1"=="--check" goto check_only
call "%~dp0Ensure-BEA-Toolchain.cmd"
if errorlevel 1 exit /b %errorlevel%
goto run_configure

:check_only
call "%~dp0Ensure-BEA-Toolchain.cmd" --check
if errorlevel 1 exit /b %errorlevel%

:run_configure
if not exist "%BEA_NODE%" (
  echo BEA_PHASE134_BOOTSTRAP=BLOCKED ^(BEA-owned Node 24.19.0 is unavailable.^)
  exit /b 1
)

"%BEA_NODE%" scripts\repository-boundary.mjs
if errorlevel 1 exit /b %errorlevel%

"%BEA_NODE%" scripts\phase134\configure-production.mjs %*
if errorlevel 1 exit /b %errorlevel%

if "%~1"=="--check" goto activation
call "%BEA_PNPM%" install --frozen-lockfile
if errorlevel 1 (
  echo BEA_PHASE134_ACTIVATION=BLOCKED ^(Frozen dependency installation failed.^)
  exit /b 1
)

:activation
if not exist "node_modules\tsx\dist\cli.mjs" (
  echo BEA_PHASE134_ACTIVATION=SETUP_REQUIRED ^(Repository dependencies are absent.^)
  exit /b 1
)
"%BEA_NODE%" --import=tsx scripts\phase134\production-activation.mjs %*
exit /b %errorlevel%
