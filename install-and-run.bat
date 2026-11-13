@echo off
title Svarmo
cd /d "%~dp0"

REM Mirror for the Electron binary - GitHub often drops the connection.
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set npm_config_fetch_timeout=600000

REM Tell node-pty to download a prebuilt binary for our Electron target
REM instead of compiling. No Python / Visual Studio needed.
set npm_config_runtime=electron
set npm_config_target=29.4.6
set npm_config_disturl=https://electronjs.org/headers

where node >nul 2>nul
if errorlevel 1 goto no_node

if exist "node_modules" goto run

echo === First run: installing dependencies, prebuilt binaries, no compiler ===
echo     Downloading Electron ~90 MB, may take a couple of minutes...
echo.
call npm install
if errorlevel 1 goto install_failed

:run
echo === Starting Svarmo ===
call npm start
pause
exit /b 0

:no_node
echo.
echo [!] Node.js not found.
echo     Install the LTS build from https://nodejs.org and run this file again.
echo.
pause
exit /b 1

:install_failed
echo.
echo [!] Install failed. Most likely the network dropped the download -
echo     ECONNRESET / ETIMEDOUT in the log above.
echo     Just run this file again, it resumes where it stopped.
echo     If it keeps failing, turn on a VPN and retry.
echo.
pause
exit /b 1
