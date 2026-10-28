# 湛卢 Zhanlu

本地优先的 PDF 工作台。首版聚焦**阅读、页面、转换、AI** 四个模式，断网可用；范围见[首版产品定义](docs/product/mvp-v1/README.md)，视觉以 [Figma `06 · 现行交互改版`](docs/design/mvp-v1/README.md) 为准，发布标准见[逐项验收](docs/product/mvp-v1/acceptance.md)，当前执行状态见[验收记录](docs/product/mvp-v1/acceptance-record.md)。

## 首版能力

- **阅读**：pdf.js 多标签、每文档位置恢复、缩略图/目录/全文搜索（命中高亮）、文字层选区复制、视图旋转、密码打开（错误可重试）、打印当前标签。
- **页面**：拆分（单页/第 N 页后/每 N 页/自定义范围，预览与产物同名同页数）、合并（排序+逐份取页）、阅读内页面整理（重排/旋转/删除一个计划成文）。全部另存新文件。
- **转换**：PDF→PNG/JPEG（96/150/300 DPI、按原页码命名）、PDF→TXT（页分隔标记）、多图→PDF（缩略图序号即页序，排序/删除后核对再生成）。
- **AI**：AI 能力优先走用户配置的大模型 API（逐文档确认），本地模型插件为离线备选（Ollama 运行时，确认后装到数据目录）；离线 OCR 用百度 PP-OCR 系列模型（RapidOCR/ONNX），模型为插件——标准档约 30 MB、高级档约 165 MB，用户确认后下载到数据目录，删除即卸载，安装包不含任何模型。
- **安全**：本地 API 会话令牌 + Host/Origin 校验（未授权网页不能读写文件）；密钥 Windows DPAPI 加密；任务可取消/重试/重启恢复；输出冲突绝不静默覆盖。

## 目录

```text
apps/web/           React 19 + TypeScript (TSX)；app、features、shared、styles
apps/desktop/       Tauri 2 桌面壳（sidecar 握手 + NSIS 安装包）
engine/             Python 3.13 本地引擎（pdfops/jobs/tasks/ocrpdf/localai/server）
engine/build/dist/  PyInstaller sidecar 产物（打包资源）
test-files/         验收用真实测试文件（生成脚本见验收记录）
docs/product/mvp-v1/  首版范围、流程与验收【现行】
docs/design/mvp-v1/   Figma 索引【现行】
docs/architecture/    结构与安全边界【现行】
assets/               品牌与图标
```

## 本地开发

```bat
setup.bat            &rem Python 3.13 venv + 依赖 + 前端构建
start-zhanlu.bat     &rem 浏览器模式（引擎静态服务 + API）
```

前端单独热更开发：`cd apps\web && npm run dev`（另开终端以 `--dev` 启动引擎）。

## 验证

```bat
cd apps\web && npm run build && npm run typecheck

cd ..\..\engine
.venv\Scripts\python.exe -m unittest discover -s tests
```

引擎测试含本地 API 鉴权（S01）、拆分预览/冲突、AI 远程确认等冒烟场景。

## 桌面打包

```bat
cd apps\desktop
npm install
npx tauri build     &rem 先决：engine sidecar 已由 setup/PyInstaller 生成
```

安装包输出在 `apps\desktop\src-tauri\target\release\bundle\nsis\`。桌面壳选择空闲端口并生成会话令牌，以握手确认引擎后加载界面；关窗带走 sidecar。

## 数据与隐私

数据目录 `%LOCALAPPDATA%\Zhanlu`（inbox/ 上传副本、out/ 默认输出、tasks/ 任务登记、plugins/ 用户确认后安装的运行时与模型，整目录删除即卸载）。AI 能力优先走用户配置的大模型 API（逐文档确认后发送）；本地模型插件为断网/隐私备选，其文字只发往 127.0.0.1。后续方向：接入 ACP 协议的 CLI Agent（本期不实现）。

## 许可证

以 [Apache-2.0](LICENSE) 发布。Copyright © 2026 Deeplorex.
