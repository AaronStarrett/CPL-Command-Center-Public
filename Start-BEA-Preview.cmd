@echo off
setlocal
cd /d "%~dp0"

set "BEA_NODE=%LOCALAPPDATA%\BEA\CommandCenter\toolchain\node-v24.19.0-win-x64\node.exe"
if not exist "%BEA_NODE%" (
  echo BEA_PREVIEW_START=BLOCKED ^(canonical BEA Node 24.19.0 is unavailable^)
  exit /b 1
)

"%BEA_NODE%" scripts\repository-boundary.mjs
if errorlevel 1 exit /b %errorlevel%

"%BEA_NODE%" scripts\preview-start.mjs %*
exit /b %errorlevel%
