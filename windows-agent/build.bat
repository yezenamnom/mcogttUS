@echo off
setlocal
cd /d "%~dp0"
title GPT US Desktop Bridge v0.8 - Build
echo ==========================================
echo   GPT US Desktop Bridge v0.8 - BUILD
echo ==========================================
echo.

where dotnet >nul 2>&1
if errorlevel 1 (
  echo [ERROR] .NET SDK was not found.
  echo Install .NET 8 SDK, then run this file again.
  echo.
  pause
  exit /b 1
)

echo [1/3] Cleaning old build...
if exist "bin\Release\net8.0-windows\win-x64\publish" rmdir /s /q "bin\Release\net8.0-windows\win-x64\publish"

echo [2/3] Building v0.8...
dotnet publish "%~dp0ChatGPTDesktopBridge.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. The error is shown above.
  echo.
  pause
  exit /b 1
)

set "EXE=%~dp0bin\Release\net8.0-windows\win-x64\publish\ChatGPTDesktopBridge.exe"
if not exist "%EXE%" (
  echo.
  echo [ERROR] Build reported success but EXE was not found.
  pause
  exit /b 1
)

echo [3/3] Build completed successfully.
echo.
echo EXE:
echo %EXE%
echo.
explorer /select,"%EXE%"
pause
