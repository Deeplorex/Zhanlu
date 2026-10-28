@echo off
rem 构建引擎 sidecar；按插件化要求剔除内置 OCR 模型与视频解码库（OCR 不需要）
cd /d %~dp0
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onedir --name zhanlu-engine ^
  --collect-all rapidocr ^
  --collect-data pypdfium2 ^
  --paths . ^
  --distpath build/dist --workpath build/work --specpath build ^
  run_engine.py
if not exist "build\dist\zhanlu-engine\zhanlu-engine.exe" (
  echo [FATAL] sidecar 产物缺失，停止后续打包
  exit /b 1
)
.venv\Scripts\python.exe -c "from pathlib import Path; d = Path(r'build/dist/zhanlu-engine/_internal/rapidocr/models'); n = 0; [ (f.unlink(), n := n + 1) for f in d.glob('*.onnx') ] if d.is_dir() else None; print(f'stripped {n} bundled OCR models'); v = Path(r'build/dist/zhanlu-engine/_internal/cv2'); m = 0; [ (f.unlink(), m := m + 1) for f in v.glob('opencv_videoio_ffmpeg*.dll') ] if v.is_dir() else None; print(f'stripped {m} ffmpeg dlls')"
