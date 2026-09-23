@echo off
setlocal
title CPL Command Center - DEVELOPMENT
set "NODE_OPTIONS="
set "NODE_PATH="
set "_CPL_NODE=D:\Cyber Pirate Labs\93_TOOLS_AND_CACHE\CPL-Command-Center\toolchain\node-v24.19.0-win-x64\node.exe"
if not exist "%_CPL_NODE%" (
  echo The verified CPL Node toolchain is missing from the external SSD.
  echo Reconnect the Extreme SSD. No installation or download was attempted.
  pause
  exit /b 1
)
"%_CPL_NODE%" "%~dp0scripts\cpl-local.mjs" start
set "_CPL_RESULT=%ERRORLEVEL%"
if not "%_CPL_RESULT%"=="0" (
  echo.
  echo CPL could not complete this request. Review the message above.
  echo Your test records have been preserved.
  pause
)
exit /b %_CPL_RESULT%
