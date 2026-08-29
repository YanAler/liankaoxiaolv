@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 联招择校 - 局域网分享

echo.
echo ========================================
echo   联招择校 · 局域网分享模式
echo ========================================
echo.
echo 同一 WiFi / 同一局域网内的朋友可访问：
echo.

for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do (
  echo   http://%%i:8765/
)

echo.
echo 本机访问: http://127.0.0.1:8765/
echo.
echo 若无法访问，请在 Windows 防火墙中允许 Python 通过专用网络。
echo 按 Ctrl+C 停止服务。
echo.

python -m http.server 8765 --bind 0.0.0.0
