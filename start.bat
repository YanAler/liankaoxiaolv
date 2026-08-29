@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动联招择校本地预览...
echo 本机访问: http://127.0.0.1:8765/
echo 局域网分享请改用 share.bat
echo.
python -m http.server 8765
