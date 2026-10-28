@echo off
rem 湛卢 Zhanlu — 启动器（浏览器模式；桌面模式用 tauri build 的安装包）
chcp 65001 > nul
setlocal
cd /d "%~dp0engine"
".venv\Scripts\python.exe" -m zhanlu
endlocal
pause
