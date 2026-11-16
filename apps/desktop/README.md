# 湛卢桌面壳（Tauri 2）

安装包注册 `.pdf` 文件关联。安装/更新后，在 Windows「设置 → 应用 → 默认应用」中搜索 `.pdf` 并选择 Zhanlu（湛卢）；卸载 WPS 不会自动把默认应用改成湛卢。双击 PDF 会打开湛卢，已有窗口时在原窗口建立或激活文档标签。文件路径经桌面壳私有输入通道交给引擎，网页接口不接受任意本机路径。

PDF 文件使用折角纸张和「PDF」字样的专用图标，保留剑形品牌；应用启动器仍使用原剑标。安装包把文件图标放入 `icons/pdf-document.ico`，在默认关联注册后更新 `Zhanlu.PDF/DefaultIcon` 并通知 Windows 刷新。

阅读页的「打印」和 `Ctrl+P` 在湛卢内渲染当前文档，再打开系统打印窗口；支持已解锁的加密 PDF，遵守文件打印权限，不调用 WPS 或其他默认 PDF 软件。打印预览按原页尺寸输出，实际纸张、份数与打印机由系统打印窗口选择。取消不会修改源文件。

启动时先显示居中的 640 × 400 独立启动窗，没有标题栏、关闭按钮或缩放操作。品牌图直接复用 `assets/brand/raster/github-social.png`，编译时嵌入；底部使用与应用一致的固定剑柄进度图形。启动总量未知，仅显示实际加载阶段与不定游光，遵循系统减少动态效果设置，不编造百分比。

桌面壳从安装资源中的 `engine/zhanlu-engine.exe` 启动引擎，选择本机空闲端口，用操作系统随机源生成会话令牌并完成握手，再在隐藏的主窗口加载 `web-dist` 页面。应用信息、最近文件、能力检测、首屏资源与字体就绪后，前端通过仅限当前引擎地址的回执显示主窗口并销毁启动窗。启动失败显示原因并自动重试；界面加载超时会重新拉起。启动期间重复打开的文件仍交给原实例，不提前显示主窗口。主窗口关闭时结束它启动的引擎进程。发布版不依赖开发仓库或 Python 虚拟环境。

```bat
cd apps\web
npm run build
cd ..\..\engine
build_sidecar.bat
cd ..\apps\desktop\src-tauri
..\node_modules\.bin\tauri.cmd build --ci
```

`engine/build_sidecar.bat` 从主安装包中剔除 OCR 模型。若要提供可断网安装的 OCR 标准档能力包，在已有完整 RapidOCR 模型的构建环境运行 `engine\.venv\Scripts\python.exe engine\build_ocr_offline_pack.py`，得到 `output\Zhanlu-OCR-standard-offline.zip`。将 ZIP 复制到目标电脑，按包内 `README.txt` 安装；程序重启后会检测标准档。用户也可在联网时于设置中确认下载模型。打包产物与离线能力包仍须在干净、断网、普通权限的 Windows 环境完成 [首版发布验收](../../docs/product/mvp-v1/acceptance.md)。
