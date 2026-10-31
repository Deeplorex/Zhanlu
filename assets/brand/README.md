# 湛卢 PDF · 品牌资产

[Figma 品牌资产页](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=43-93)包含可编辑主标、横版组合、色票与最初 12 枚功能图标；后续打印、Markdown、全部清理图标补充在 `02 · 组件` 与仓库 SVG 目录。[GitHub Social 画板](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=43-225)为 1280 × 640。

## 设计含义

以抽象剑形作为识别符号：对称剑脊表达清晰、可靠，深墨色承接「湛」的深湛与「卢」的纯黑意象，少量铜色作为剑柄收尾。此处是品牌语言，不代表古剑实物颜色的考据结论。标志在 16 px 应保持轮廓辨识，较大尺寸才显示剑脊细节。

## 文件

| 用途 | 文件 |
| --- | --- |
| 标准主标 | `mark.svg`；单色透明版 `mark-ink.svg`、`mark-inverse.svg` |
| 横版 Logo | `wordmark.svg`、`wordmark-inverse.svg`；对应 `raster/wordmark-light.png`、`raster/wordmark-dark.png` |
| 桌面与启动器 | `raster/app-icon-{16,24,32,48,64,128,256,512,1024}.png`，以及 `raster/app-icon.ico` |
| GitHub Social | `github-social.svg` 是可编辑源稿；上传 `raster/github-social.png`，尺寸 1280 × 640、约 50 KB |
| 功能图标 | `../icons/*.svg` 共 26 枚；阅读、页面、转换、文件、文字、表格、全屏和放映共用同一套矢量规范 |

v0.2.0 Review 补齐 11 枚：`expand`、`play`、`file`、`text`、`word`、`table`、`chevron-left`、`chevron-right`、`plus`、`minus`、`shrink`。已有 `rotate` 接入阅读底栏。Excel 与 CSV 共用表格图标，以文字区分格式；PPT 与放映共用演示图标。前端 `Icon.tsx` 直接读取本目录 SVG，不再另维护一份路径。

2026-10-27 补充 `markdown.svg` 与 `trash.svg`：前者用于 Markdown 转换入口，后者沿用应用已有垃圾桶路径，用于任务记录“全部清理”。尺寸与位置见[88 图标规范](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=234-3275)；清理不会删除已生成文件。

2026-10-27 剑形进度设计见[89 方案比较](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=242-2445)：横向剑为进度专用衍生图形，沿用剑形特征与品牌色，正式主标 SVG 保持原规范。组件与真实进度规则见[开发交接词](../../.handoff/sword-progress-design-2026-10-27.md)。

## 使用规则

- 主标保留四周至少 **1/4 标志边长**的安全空间。低于 24 px 时只用方形主标，不使用横版 Logo。
- 浅底使用标准或墨黑版，深底使用反白版。不要旋转、拉伸、增加阴影或改动剑形比例。
- 主色：墨黑 `#2B2622`、暖白 `#F4F1EB`、铜色 `#9A6549`。铜色是小面积强调色，不铺满整张界面。
- 功能图标统一 **24 × 24 viewBox、1.8 描边、圆角端点**，SVG 通过 `currentColor` 继承界面文字色。应同时提供文字标签，不单靠图标表达操作。
- 横版 SVG 的文字依赖 `Noto Sans SC`，系统缺少字体时可使用 PNG，或在发布流程中将文字转为路径。不要让字体替换改变字距和标志比例。
- GitHub Social 使用提供的 PNG 作为仓库 Settings → Social preview 的上传素材；公开后检查实际分享卡片裁切与文字清晰度。

此目录交付的是设计资产；桌面程序与仓库设置仍需在开发发布阶段接入。产品界面与交互以[首版设计索引](../../docs/design/mvp-v1/README.md)为准。
