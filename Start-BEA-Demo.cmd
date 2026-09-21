@echo off
setlocal
cd /d "%~dp0"

node scripts\repository-boundary.mjs
if errorlevel 1 exit /b %errorlevel%

echo [TEST-ONLY / LEGACY] Start-BEA-Demo.cmd remains available for historical Demo validation. Use Start-BEA-Preview.cmd for the isolated preview runtime.
node scripts\demo-start.mjs %*
exit /b %errorlevel%
