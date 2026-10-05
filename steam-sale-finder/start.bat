@echo off
cd /d "%~dp0"
echo ===================================================
echo   Steam Sale Gems Finder を起動しています...
echo   ブラウザで http://localhost:3456 を開きます
echo ===================================================
start http://localhost:3456
node server.js
pause
