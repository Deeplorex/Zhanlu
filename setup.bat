@echo off
rem 湛卢 Zhanlu — 一次性环境安装（Python 3.13 引擎 + TSX 前端构建）
chcp 65001 > nul
setlocal
cd /d "%~dp0"

where py > nul 2>&1
if errorlevel 1 (
  echo [湛卢] 未找到 py 启动器，请先安装 Python 3.13+（含 py launcher）。
  pause & exit /b 1
)

echo [1/3] 创建引擎虚拟环境（Python 3.13）……
py -3.13 -m venv engine\.venv

echo [2/3] 安装引擎依赖（含离线 OCR）……
engine\.venv\Scripts\python.exe -m pip install -r engine\requirements.txt -i https://mirrors.aliyun.com/pypi/simple/

echo [3/3] 构建前端（需要 Node 20+）……
where npm > nul 2>&1
if errorlevel 1 (
  echo [湛卢] 未找到 npm，跳过前端构建——沿用 apps\web\dist 下已有产物。
) else (
  pushd apps\web && call npm install && call npm run build && popd
)

echo 完成。运行 start-zhanlu.bat 启动湛卢（浏览器模式）。
pause
endlocal
