@echo off
setlocal
set "_CPL_ROOT=%~dp0"
set "_CPL_NODE="
if defined CPL_NODE_PATH (
  if not exist "%CPL_NODE_PATH%" (
    echo CPL_NODE_PATH does not point to an existing Node executable.
    exit /b 1
  )
  set "_CPL_NODE=%CPL_NODE_PATH%"
)
if not defined _CPL_NODE if exist "%_CPL_ROOT%.data\tooling\node\node.exe" set "_CPL_NODE=%_CPL_ROOT%.data\tooling\node\node.exe"
if not defined _CPL_NODE if exist "D:\Cyber Pirate Labs\93_TOOLS_AND_CACHE\gods-eye-view\node-v24.14.0-win-x64\node.exe" set "_CPL_NODE=D:\Cyber Pirate Labs\93_TOOLS_AND_CACHE\gods-eye-view\node-v24.14.0-win-x64\node.exe"
if not defined _CPL_NODE (
  where node.exe >nul 2>&1
  if errorlevel 1 (
    echo Node.js is unavailable. Set CPL_NODE_PATH to an existing Node executable on the verified SSD.
    exit /b 1
  )
  set "_CPL_NODE=node.exe"
)
"%_CPL_NODE%" "%_CPL_ROOT%scripts\cpl-local.mjs" stop
exit /b %ERRORLEVEL%
