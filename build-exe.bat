@echo off
title Svarmo - build installer
cd /d "%~dp0"

REM Mirrors for Electron and electron-builder tools - GitHub often drops the
REM connection. The second one covers nsis / winCodeSign that the build pulls.
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set npm_config_fetch_timeout=600000

REM Prebuilt terminal binary for our Electron target - no compiler needed.
set npm_config_runtime=electron
set npm_config_target=29.4.6
set npm_config_disturl=https://electronjs.org/headers

where node >nul 2>nul
if errorlevel 1 goto no_node

REM Always sync deps so package.json overrides apply, even if node_modules
REM was installed earlier with a different dependency version.
echo === Installing / syncing dependencies (prebuilt binaries, no compiler) ===
call npm install
if errorlevel 1 goto install_failed

echo === Building the Windows installer ===
call npm run dist:win
if errorlevel 1 goto build_failed

echo.
echo === Done. The .exe installer is in the dist folder ===
explorer dist
pause
exit /b 0

:no_node
echo.
echo [!] Node.js not found. Install the LTS from https://nodejs.org and retry.
echo.
pause
exit /b 1

:install_failed
echo.
echo [!] Install failed, likely the network. Run again or turn on a VPN.
echo.
pause
exit /b 1

:build_failed
echo.
echo [!] Build failed. See WINDOWS.md.
echo.
pause
exit /b 1
