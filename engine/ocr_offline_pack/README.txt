湛卢 OCR 标准档离线能力包

1. 在已联网的构建电脑上生成本 ZIP，并将整个 ZIP 复制到目标 Windows 电脑。
2. 目标电脑无需联网、无需管理员权限；先关闭湛卢，再解压 ZIP。
3. 在解压目录打开 PowerShell，运行：
   powershell -ExecutionPolicy Bypass -File .\install.ps1
4. 重新启动湛卢，在“设置 → 文字识别”确认显示“标准档已安装”，然后用中文扫描 PDF 检查搜索和复制。

安装脚本仅将三个 ONNX 模型复制到当前用户的 LocalAppData\Zhanlu\plugins\ocr-models，先后核对 SHA-256，不修改程序目录或系统设置。若使用自定义数据目录，可添加 -DataDir 参数。

模型来源：RapidOCR 3.10.0 随包标准档模型。项目主页：https://github.com/RapidAI/RapidOCR
