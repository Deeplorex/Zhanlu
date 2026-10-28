# 首版目录归属与迁移规则

本文件是**开发交接时的目标结构**。本轮只整理文档，不迁移应用源码、不改运行代码。当前可运行目录仍见仓库根 [README](../../README.md)。

```text
Zhanlu/
├─ apps/
│  ├─ desktop/                 Tauri 宿主：窗口、原生文件授权、sidecar 生命周期
│  ├─ engine/                  Python 可执行 sidecar：本机 API 与 PDF 处理任务
│  │  ├─ zhanlu/
│  │  │  ├─ api/               身份、HTTP 路由和输入校验
│  │  │  ├─ services/          阅读索引、页面、转换、OCR、AI 任务编排
│  │  │  ├─ core/              纯 PDF/图片/文字算法，无 HTTP 依赖
│  │  │  └─ infra/             文件授权、SQLite、任务队列、临时文件
│  │  └─ tests/                合同、集成与回归测试
│  └─ web/
│     ├─ dist/                 Vite 构建生成物，忽略版本控制
│     └─ src/
│        ├─ app/                路由、文档会话、全局任务入口
│        ├─ features/
│        │  ├─ home/           工作台和首页文件选择
│        │  ├─ reader/         阅读、缩略图、目录、搜索
│        │  ├─ pages/          文档内页面整理
│        │  ├─ workflows/      独立拆分与合并任务
│        │  ├─ convert/        PDF/图片转换
│        │  ├─ ai/             OCR、摘要、问答、选区操作
│        │  ├─ settings/       能力包、模型和隐私设置
│        │  └─ legacy/         不在首版导航的旧实现，待逐项清理
│        ├─ shared/            类型、API 客户端、无业务含义基础组件
│        └─ styles/            与 Figma 对应的设计令牌和全局样式
├─ docs/
│  ├─ product/mvp-v1/           首版产品、流程和发布验收【现行】
│  ├─ design/mvp-v1/            Figma 索引与视觉交接【现行】
│  ├─ architecture/             结构、安全、部署与发布门槛【现行】
│  └─ design/zhanlu-*/          早期可点击原型与配色探索【历史】
├─ assets/
│  ├─ brand/                    Logo、应用图标和 GitHub Social 图源文件
│  └─ icons/                    24 px 功能图标 SVG
├─ .handoff/                    开发交接词（本地目录，.gitignore 不入库）
└─ setup.bat / start-zhanlu.bat 开发辅助入口，发布包不依赖它们
```

## 归属规则

1. `features` 只拥有自己的界面与交互；跨模式文档 ID、页码跳转和任务摘要在 `app` 协调。`shared` 不反向依赖业务功能。
2. 引擎的 API 只负责认证、参数验证和任务提交；业务编排在 `services`，可复用算法在 `core`。文件系统、凭据、队列和数据库属于 `infra`。不得让浏览器直接提交任意绝对路径供引擎读取。
3. 阅读器采用文档会话；拆分、合并、转换采用独立任务会话。设计中同名组件共享状态模型，避免每个页面各造一套进度、输出和错误处理。
4. `docs/product/mvp-v1` 是首版功能范围的唯一权威；Figma 画板负责视觉和状态表达；`assets/brand`、`assets/icons` 是品牌图形交付源文件；`docs/architecture` 负责实现边界。历史原型仅供回溯，不覆盖现行范围。
5. 新功能先写清输入、输出、失败和离线行为，再决定其代码目录。生成文件与用户数据放应用数据目录，不写入仓库源码或 `web/`。

## 根目录 `web/` 与 `engine/` 的归位

根目录 `web/` 目前只是 Vite 构建产物，不是另一套前端源码。目标是把输出改到 `apps/web/dist/`，由 Tauri 打包该静态资源；本机 Python sidecar 只提供受认证 API。浏览器开发预览由 Vite 提供页面并代理 API。根目录不再保留一个容易被误认为源码的 `web/`。

`engine/` 当前既有 HTTP 入口又作为桌面 sidecar 独立运行，属于可执行应用，因此目标放在 `apps/engine/`。以后若抽出可在多个应用复用的纯 PDF 算法，再单独放入 `packages/`；不要提前把整个 sidecar 命名为共享包。

这两处属于**开发迁移**：先修改 Vite 输出、Tauri `frontendDist`、Python 静态路径/启动配置、安装脚本、测试和忽略规则，确认构建与预览正常后，再移除根目录 `web/` 并移动 `engine/`。直接删除或移动会使当前启动链路失效。

## 迁移顺序（下一阶段开发）

先为现有模块建立边界和导入约束，再逐步移动代码；每次迁移保持可启动并运行对应验收。顺序建议：统一任务契约与文档会话 → API 身份及文件授权 → 引擎服务/基础设施拆分 → 桌面 sidecar 与凭据库 → 离线 OCR/AI 能力包 → 删除 `legacy` 中未纳入首版的入口。不要只为目录整齐而大规模搬文件。
