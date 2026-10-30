# 湛卢 PDF · 首版视觉系统与设计交接

[打开 Figma 设计文件](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6)。`06 · 现行交互改版` 是首版开发的界面基线。`03 · 核心界面（历史参考·非开发基线）`、`04 · MVP 完整场景（历史参考·非开发基线）` 保留作历史场景参考，旧画板也已逐一标记。现行改版画板由可编辑文字与图层构成，沿用现有配色与视觉气质。设计描述目标产品，不暗示现有代码已经达到发布标准。

## 2026-10-27 顶部全局操作

查找功能、任务、设置使用有边界的统一按钮，提高默认状态下的辨识度。见 [124 · 1280 px](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=260-4009)、[125 · 840 px](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=260-4136)、[126 · 独立状态](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=260-4247)和 [127 · 840 px 多标签及两位数任务](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=262-4370)；完整行为、布局及验收见[开发交接词](../../../.handoff/global-actions-design-2026-10-27.md)。本轮仅完成设计与文档，尚未实现；107–123 等既有基线继续有效。

## 2026-10-27 界面精简与源文件同目录

全应用删除重复的流程解释，以清晰控件、必要状态和就近操作表达；保留输出核对、真实错误、OCR 引导及远程发送确认。当前 PDF 转换、独立转换、图片转 PDF 和合并增加“与源文件同目录”；多文件按当前列表第一项确定目录，该选项下同名自动编号且不覆盖。行为、实现边界及验收见[设计与开发交接词](../../../.handoff/concise-ui-source-directory-design-2026-10-27.md)。本轮仅设计与文档，未实现功能；其他保存位置的重名规则不变。2026-10-30 更新：拆分已实现同目录选项与同名自动编号，见交互说明同条目。

| 场景 | 1280 px | 840 px／状态 |
| --- | --- | --- |
| 阅读内转换 | [107 同目录与编号预览](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3488) · [109 位置选择框展开](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3606) | [108 同目录与编号预览](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3555) |
| 合并 | [110](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3673) | [111](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3722) |
| 独立转换／图片转 PDF | [112 独立转换](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3771) · [113 图片转 PDF](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3823) | [122 独立转换](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-4470) · [123 图片转 PDF](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-4522) |
| 异常 | [114 已选同目录：源目录不可用](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3875) | [115 已选目录不可写](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3942) |
| 文案精简示例 | [116 首页](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-3993) · [117 阅读](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-4052) · [118 页面](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-4120) | [119 拆分](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-4259) · [120 设置](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-4351) · [121 AI](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=251-4401) |

## 2026-10-27 多工作标签方案（待选择）

**右键菜单补充：** [104 非当前标签](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=248-3303)、[105 840 px](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=248-3413)、[106 空白处](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=248-3499)，操作包括关闭标签、其他、左侧、右侧和全部；右键目标可不是当前项。完整边界见[开发交接词](../../../.handoff/workspace-tab-context-menu-design-2026-10-27.md)。

针对顶部横向滚动条，新增两种候选设计：[99 自适应宽度 1280 px](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=247-2994)、[100 自适应宽度 840 px](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=247-3096)、[101 下拉入口](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=247-3174)、[102 下拉展开](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=247-3274)、[103 窄窗口下拉展开](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=247-3388)。建议自适应缩窄与溢出下拉结合，具体规则见[方案与交接](../../../.handoff/workspace-tabs-options-2026-10-27.md)。**尚待用户选定；71–72 的现行固定宽度规则暂未被候选稿覆盖。**

## 2026-10-27 湛卢剑形进度

推荐固定剑柄、剑身逐渐填充；剑尖随进度前行作为备选。正式主标保持原规范，横向剑为进度专用衍生图形。视觉仅响应真实任务进度；未知总量不伪造百分比，处理 100% 后仍以任务完成状态为准。详见[剑形进度开发交接词](../../../.handoff/sword-progress-design-2026-10-27.md)。

| 场景 | 画板 |
| --- | --- |
| 两种方案与 0／25／71／100／未知 | [89 方案比较](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=242-2445) |
| 1280／840 px 实际转换界面 | [90 转换进行中](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=242-2638) · [91 840 px](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=242-2842) |
| 任务、AI 与异常状态 | [92 使用场景](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=242-3021) · [93 状态边界](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=242-3079) |
| 手动动态对比 | [94–98 演示入口](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=244-2876) |

本轮仅更新 Figma 与文档，不代表进度条已经在应用中实现。

## 2026-10-27 转换上下文与补充图标

转换工具更新为 **转换为图片 → 转换为 Markdown → 提取 TXT → 扫描页先 OCR**。右栏随具体入口展示专属目标；图片只选 PNG/JPEG，Markdown／TXT 不再混列图片或其他文字格式。61、66 已同步，详细映射、状态与验收见[本轮开发交接词](../../../.handoff/conversion-context-icons-design-2026-10-27.md)。本轮仅更新设计、SVG 资产和文档。

| 场景 | 1280 px | 840 px |
| --- | --- | --- |
| 图片 | [82 图片专属右栏](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=234-1974) | [85 图片](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=234-2638) |
| Markdown | [83 Markdown 专属右栏](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=234-2194) | [86 Markdown](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=234-2847) |
| TXT | [84 TXT 专属右栏](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=234-2416) | [87 TXT](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=234-3048) |
| 图标 | [88 Markdown、全部清理与使用位置](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=234-3275) | SVG 源文件见 assets/icons |

## 2026-10-26 工具栏与 AI Chat 新基线

**模型入口最新基线是 78–81：** [78 点击前](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=223-1632)、[79 点击后](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=223-1790)、[80 840 px 点击前](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=223-1948)、[81 840 px 点击后](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=223-2095)。单个“模型名＋当前思考强度＋箭头”入口紧邻发送按钮左侧 8 px，同一菜单内选择模型与强度滑轨。59–67 已同步；旧 74–77 分离菜单已标为历史参考。详见[最新开发交接词](../../../.handoff/combined-model-strength-design-2026-10-26.md)。

最新补充见[固定标签、细轨滚动条与 AI 选择菜单交接词](../../../.handoff/tab-scrollbar-model-menu-design-2026-10-26.md)。59–67 已同步更新，补充画板如下；PDF 文件标签固定 208×38 px，全部应用内滚动条为 6 px、两端无箭头，Chat 模型与思考级别采用 GPT 式圆角按钮和上拉菜单。

| 新画板 | 用途 |
| --- | --- |
| [71 多 PDF 固定标签](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=213-750) · [72 840 px 标签横向滚动](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=213-873) | 长短文件名等宽、固定关闭热区、列表溢出滚动。 |
| [73 标签与滚动条规范](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=213-1019) | 横纵细轨、默认／悬停／拖动、不显示端部箭头。 |
| [74 模型菜单](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=213-1076) · [75 思考级别菜单](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=213-1255) | 自定义上拉、当前勾选、配置说明与两档实际能力。 |
| [76 840 px 模型菜单](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=213-1434) · [77 840 px 思考级别](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=213-1602) | 窄窗口菜单边界和触发器布局。 |

本轮只更新设计与交接文档。以下 **59–67** 覆盖共享骨架、工具栏和 AI 入口；33–58 中的旧顶栏、四个文档模式和 AI 侧栏占位布局不再作为实现依据，未变更的正文、搜索、任务、设置及远程确认内容继续沿用。详细尺寸、避让、焦点与运行规则见[本轮开发交接词](../../../.handoff/toolbar-ai-chat-design-2026-10-26.md)。

| 场景 | 1280 px | 840 px |
| --- | --- | --- |
| 阅读 | [59 居中工具与双 AI 入口](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=196-27) | [63 阅读](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=196-722) |
| 页面 | [60 页面与打印](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=196-177) | [65 页面](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=196-1007) |
| 转换 | [61 居中转换工具](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=196-390) | [66 转换](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=196-1242) |
| AI Chat | [62 右侧聊天浮层](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=196-545) | [64 AI Chat](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=196-851) |
| 首页 | [67 全局湛卢气泡与三项任务入口](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=196-1377) | 沿用气泡边距与先选 PDF 规则 |

文档模式只保留阅读、页面、转换；模式行仍靠左，其下的整组工具居中。AI 阅读改在查找文字右侧和右下气泡中打开同一份当前 PDF 对话；不新增工作标签、不改变原模式或缩放。打印进入阅读与页面工具组，由竖线分隔。首页不再重复放置 AI 快捷卡片。68–70 是原型弹层资源，不是新工作区。

图标审计确认：应用已使用品牌剑标，12 枚功能 SVG 尚未接入。本轮设计复用它们，并在 `02 · 组件` 补齐打印矢量、上下文操作、气泡与聊天组件；下一轮实施按交接词接入。

## 既有画板与未变更状态（共享骨架按 59–67 覆盖）

| 画板 | 决策 |
| --- | --- |
| [33 首页](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=52-3) · [34 阅读](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=52-4) | 顶部只显示已打开的首页、文件和任务标签；阅读页固定底部页码、翻页、缩放与适应宽度。 |
| [35 合并](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=52-5) · [36 转换](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=52-6) | 从首页建立独立任务标签，在任务内核对输入、规则、预览与保存位置。 |
| [37 AI 侧栏](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=52-7) | 保留当前 PDF 标签和原文；右侧可收起侧栏展示快捷操作、对话、来源、模型与回答深度。 |
| [38 模型设置](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=52-8) · [39 文字识别设置](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=52-9) | 按当前状态和下一步操作组织设置，安装与远程配置按需进入。 |
| [40 阅读内转换](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=61-10) | 与阅读页共用顶部和底部；右侧核对 PNG、JPEG、TXT、页范围、数量、名称与位置。 |
| [41 搜索定位](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=69-2) · [47 待定位结果](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=72-2) | 左栏列出数量和片段；选择结果后在原页高亮。 |
| [48 查找功能筛选](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=75-2) | 在当前 PDF 中输入“转换”后的命令筛选；PDF 内文字结果仍留在阅读左栏。 |
| [42 页面网格](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=69-85) · [43 拆分任务](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=69-258) | 页面多选后就地操作；拆分在独立任务标签中预览第 3 页后生成的 3＋21 页。 |
| [44 扫描页 OCR](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=69-461) · [46 任务状态](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=69-681) | 无文字层时就地引导离线识别；覆盖密码、进度、失败、冲突和完成状态。 |
| [45 窄窗口](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=69-611) | 840 px 下左栏收成图标轨道，文档、模式、搜索、页码与缩放仍可见。 |
| [49 窄窗口 AI 侧栏](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=86-47) | 840 px 下 AI 临时覆盖文档右侧；关闭后恢复完整阅读宽度，不新增顶部标签。 |
| [50 添加远程模型](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=105-2) · [51 已保存与连接检测](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=106-2) | 沿用设置页网格填写名称、协议、服务地址、模型 ID 和密钥；先本机保存，再测试连接与选择默认模型。 |
| [52 首次发送确认](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=108-2) | 在当前 PDF 的 AI 侧栏上确认目标服务、本次操作与拟发送文字范围；取消后不发送文档。 |
| [53 840 px 添加配置](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=111-2) · [54 840 px 已保存](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=112-2) | 窄窗口中设置分类改为横向，表单仍保留等宽字段和完整操作按钮。 |
| [55 840 px 发送确认](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=111-120) | 确认层覆盖当前 PDF 与 AI 侧栏，目标、范围、取消与确认仍在同一视野。 |
| [56 查找功能初始态](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=120-2) · [57 无结果](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=122-2) | 全局命令与最近文件分组，弹层尺寸固定，结果列表内部滚动；无匹配时可清除输入。 |
| [58 840 px 查找功能](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=123-2) | 当前 PDF 操作先于应用命令，窄窗口保持搜索框、列表选择与关闭入口可见。 |

[阅读交互说明与原型路径](./interaction-2026-10.md)记录入口、点击路径、状态、键盘顺序和验收口径。本轮仅更新 Figma 与交互文档，没有修改程序或公开 API。

## 设计语言

「湛卢墨色」取深而清的黑为主：墨黑 `#2B2622` 表示稳定和聚焦，暖白 `#F4F1EB` 承载工作区，白色留给文档与操作面，铜色 `#9A6549` 只用于选中、位置和少量引导。色值是文化意象的设计转译，不声称是古剑的实物取色。

界面遵循三个层级：全局导航、当前任务、文件内容。顶栏是动态工作标签，只在合并、拆分、独立转换等任务实际打开时出现对应任务标签；AI 阅读始终属于当前 PDF，不占一个新标签。阅读时中央页面始终最清楚；底部固定定位与缩放。左栏在缩略图、目录、查找之间切换；当前 PDF 的转换在右栏核对，AI 使用右侧聊天浮层且不挤压原文。文档模式只保留阅读、页面、转换，工具栏与气泡打开同一 AI 会话。从首页启动合并、拆分、转换时展示独立任务页。一个任务的输入、规则、输出预览与保存位置出现在同一视野，完成后由用户选择是否打开结果。常用动作直接可见，次要操作使用局部菜单。文字、图标、颜色一起表达状态。

Figma 的颜色变量、Noto Sans SC 字阶、间距和圆角在 `01 · 视觉系统`。`02 · 组件` 包含按钮与模式标签变体、文件行、任务行、来源引用、输入框、首页选文件弹窗，以及新增的页面缩略图、图片缩略图、任务状态和输出预览组件。页面/图片排序都有按钮替代拖动；所有错误状态须有原因和下一步。

`05 · 品牌资产`收录[品牌规范板](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=43-93)和[GitHub Social 画板](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=43-225)。可交付的 SVG、PNG、ICO 和图标源文件放在[品牌资产目录](../../../assets/brand/README.md)。远程模型画板中的域名、模型名、页数与密钥掩码均为示例，运行时使用真实配置和当前文档数据。

## 历史逐屏索引（不作为开发基线）

| 画板 | 重点 |
| --- | --- |
| [01 阅读工作台](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=4-35) · [02 阅读内拆分](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=4-158) · [03 阅读内合并](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=4-301) | 文档上下文保留、页面工具就近出现 |
| [04 转换与任务](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=4-445) · [05 AI 回答](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=4-585) · [06 首页快捷任务](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=4-705) | 四模式基础布局和首页先选文件 |
| [07 合并设置](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=10-2) · [08 拆分设置](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=10-53) · [09 合并完成](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=10-110) · [10 拆分完成](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=10-141) | 独立任务和结果页，不预先载入阅读器 |
| [11 多图预览排序](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=16-10) · [12 多图转换完成](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=16-66) | 缩略图序号就是 PDF 页序 |
| [13 开始页](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=24-2) · [14 连续阅读](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=25-2) · [15 搜索与无文本提示](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=25-44) | 空状态、多标签、查找和 OCR 引导 |
| [16 拆分四规则](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=25-83) · [17 合并顺序范围](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=25-131) · [18 PDF 转图片/文本](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=25-172) · [19 图片转 PDF](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=26-3) | 执行前核对页序、数量和输出 |
| [20 AI 隐私选择](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=26-64) · [21 问答与来源](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=26-94) · [22 OCR 任务](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=26-137) | 本地/远程通道、来源定位、扫描件处理 |
| [23 任务状态](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=26-172) · [24 能力设置](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=26-209) · [25 密码错误](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=26-245) | 进行中、失败重试、能力缺失和加密文件 |
| [26 页面整理](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=37-2) · [27 PDF 导出设置](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=37-92) · [28 选区 AI](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=37-135) | 重排/旋转/删除、页范围与文件名、解释/翻译 |
| [29 OCR 可搜索副本](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=38-2) · [30 保存冲突恢复](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=38-46) · [31 窄窗口](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=38-87) · [32 首页选文件](https://www.figma.com/design/LAdU272mtZ2RG2ZnQaGKX6?node-id=38-129) | 结果验证、失败保留设置、响应布局、四入口文件约束 |

## 开发读取顺序

先读[产品定义](../../product/mvp-v1/README.md)和[交互流程](../../product/mvp-v1/flows.md)，再按以上画板查看尺寸、间距、组件和状态。Figma 画板中的例子是说明性内容；页数、文件名和按钮启用状态必须以运行时真实数据为准。设计中“可取消、可重试、离线 AI”等都是发布目标，不能用静态画面代替能力验收。完成后对照[发布验收](../../product/mvp-v1/acceptance.md)逐项核对。
