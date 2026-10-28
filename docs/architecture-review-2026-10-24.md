# 湛卢架构评审（2026-10-24）

> 评审时点记录。现行目录、技术边界和发布门槛见 [MVP 技术架构](architecture/mvp-v1.md)；文件登记簿并发写入问题已在本次目录调整中修复。

## 结论

**方向合理，当前实现适合本机 MVP，不宜按现状打包分发。** React + pdf.js 负责阅读，Python 将 PDF/OFD/Office 转换能力放在独立进程，Tauri 管窗口和生命周期，这个分工能隔离依赖，也便于先做 Windows 版本。非破坏式输出和文件 ID 登记也值得保留。

## 按优先级处理

| 优先级 | 发现 | 依据 | 建议 |
| --- | --- | --- | --- |
| P0 | 本地 HTTP 服务没有请求身份验证，也没有校验 Origin/Host；API 可以按路径登记本机任意文件，并提供原文读取和 AI 配置操作。仅监听 `127.0.0.1` 不等于只允许本应用访问。 | `engine/zhanlu/server.py` 的 `Handler`、`api_files_open_path`、`api_file_raw` | 分发前增加会话令牌和 Origin/Host 校验；Tauri 启动引擎后以随机令牌建立会话。路径登记能力由桌面文件选择器触发，避免向普通网页直接开放。 |
| P0 | AI Key 是基于设备地址异或后 Base64 编码，属于混淆，不是加密；README 的“密钥本机混淆存储”表述准确，功能清单中的“加密存储”不准确。 | `engine/zhanlu/core/ai.py` 的 `obfuscate` / `deobfuscate` | Windows 用 DPAPI 或系统凭据库保存密钥；在实现前保持明确的“混淆”说明。 |
| P1 | 桌面壳通过扫描端口推测引擎地址，并以“端口可连接”判断引擎已经就绪；可能连接到别的服务。发布包还依赖仓库里的 `engine/.venv`，没有独立 sidecar 布局。 | `apps/desktop/src-tauri/src/lib.rs` 的 `engine_port`、`ensure_engine`、`find_repo_root` | 由桌面壳选择端口和令牌，启动打包的 sidecar，再校验 `/api/app-info` 的实例标识；加入启动失败界面。 |
| P1 | 上传、原文件和静态资源都一次性读进内存。缩略图请求直接在 HTTP 线程渲染，缺少并发与尺寸限制。实际打开演示 PDF 时，多个缩略图请求使 PDFium 抛出异常，预览服务退出。 | `server.py` 的 `_body`、`api_file_raw`、`_static`、`api_file_thumb`；本次实测 | 流式上传和文件响应；限制体积、DPI、并发缩略图数，增加缩略图缓存；隔离不可信文档解析，避免一个文件拖垮服务。 |
| P1 | 文件登记簿会被 HTTP 多线程和后台任务同时改写，但 `Store` 没有同步控制；并发时可能覆盖最近文件记录。 | `server.py` 的 `ThreadingHTTPServer`，`tasks.py` 的线程池，`store.py` 的 `_reg` / `_save` | 给登记簿读改写加锁，或换 SQLite 单库事务；文件数量上来后后者更稳。 |
| P2 | 当前文档状态集中在 `App` Context，页面按路由重新挂载，阅读位置及操作上下文不易保留；大文档阅读只渲染当前页，搜索最多 300 页、缩略图最多 200 页。 | `apps/web/src/app/App.jsx`、`apps/web/src/features/reader/Reader.jsx` | 保留文件会话和每个文档的视图状态；需要完整阅读体验时再做虚拟列表、增量搜索和缓存。 |

## 产品承诺与实现的差距

- OFD 目前主要是信息、目录、文本提取与文本重建转换；阅读页没有 OFD 页面渲染。不要在交付说明里称为完整 OFD 查看器。
- README 把多标签页、全文搜索高亮、图片模式等与现有功能并列，其中有些仍是简化实现或未接入。发布前用自动化验收表逐项核对。
- 当前 UI 已改为浅色、顶部文字导航、文件列表与文档画布，主要沿用 WPS PDF 的“顶部操作、左侧导航、中央页面”布局关系；功能入口没有删除。

## 建议的下一步顺序

1. 先封住本地 API 访问边界和密钥保存。
2. 固定 Tauri sidecar 启动与握手，再设计可安装包。
3. 处理流式 I/O、缩略图隔离和并发登记簿。
4. 按真实 P0 能力收窄产品文案，之后补全 OFD 阅读与大文档体验。
