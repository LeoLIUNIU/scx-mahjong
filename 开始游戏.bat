@echo off
chcp 65001 >nul
cd /d %~dp0
echo 恶搞四川麻将服务器启动中...
..\nodejs\node.exe server.js
pause
