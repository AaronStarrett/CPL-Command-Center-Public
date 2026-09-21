@echo off
setlocal
cd /d "%~dp0"

call "%~dp0Ensure-BEA-Toolchain.cmd" --check
if errorlevel 1 exit /b %errorlevel%

set "BEA_NODE=%LOCALAPPDATA%\BEA\CommandCenter\toolchain\node-v24.19.0-win-x64\node.exe"
"%BEA_NODE%" scripts\repository-boundary.mjs
if errorlevel 1 exit /b %errorlevel%

"%BEA_NODE%" scripts\phase134\production-start.mjs %*
exit /b %errorlevel%
