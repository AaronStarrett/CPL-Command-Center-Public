@echo off
setlocal
cd /d "%~dp0"

node scripts\repository-boundary.mjs
if errorlevel 1 exit /b %errorlevel%

echo [TEST-ONLY / LEGACY] Stop-BEA-Demo.cmd stops only the historical Demo runtime. Use Stop-BEA-Preview.cmd for the isolated preview runtime.
node scripts\demo-stop.mjs %*
exit /b %errorlevel%
