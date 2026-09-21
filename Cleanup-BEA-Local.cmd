@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0" || exit /b 3

if "%~1"=="--dry-run" goto argument_ok
if "%~1"=="--safe" goto argument_ok
echo Usage: Cleanup-BEA-Local.cmd --dry-run^|--safe 1>&2
exit /b 2

:argument_ok
if not "%~2"=="" (
  echo Cleanup accepts exactly one mode argument. 1>&2
  exit /b 2
)

set "BEA_NODE=%LOCALAPPDATA%\BEA\CommandCenter\toolchain\node-v24.19.0-win-x64\node.exe"
if not exist "%BEA_NODE%" (
  echo Pinned BEA Node 24.19.0 is required. 1>&2
  exit /b 3
)

set "BEA_NODE_VERSION="
for /f "usebackq delims=" %%V in (`"%BEA_NODE%" --version`) do set "BEA_NODE_VERSION=%%V"
if not "%BEA_NODE_VERSION%"=="v24.19.0" (
  echo Cleanup blocked: expected Node v24.19.0, received %BEA_NODE_VERSION%. 1>&2
  exit /b 3
)

"%BEA_NODE%" scripts\repository-boundary.mjs
if errorlevel 1 exit /b %errorlevel%

"%BEA_NODE%" scripts\local-storage-audit.mjs %~1
exit /b %errorlevel%
