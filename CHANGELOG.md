# Changelog

## 0.5.1

### 修复

- lo_render 的输出会打出 排版 undefineds：它没有 	imings.build，而渲染函数硬拼了三段计时。现在按实际存在的阶段拼接（连接 / 打开 / 排版 / 导出），没有就不打。
- lo_render 还会打出一行空的 主题 - · 比例 -（这两个字段只有 lo_build 有），现在不再输出。
- lo_convert 按文件名前缀找产物，把目录里同名的旧文件也列进 iles（实测把 .pptx 和 -01.png 当成"一次转出的三个文件"）。现在要求扩展名匹配目标格式、且 mtime 不早于本次开始时间。
- 	est/render-output.test.mjs（7 项）守着上面三条。

## 0.5.0
## 0.5.0

### 新增

- **斜杠命令**（你在输入框敲，不经过模型、不消耗 token）：
  - `/ppt-config` —— 查看配置；`theme=swiss autoFit=off` 这样改；`reset` 恢复出厂
  - `/ppt-status` —— 探测 LibreOffice 与 UNO 桥是否可用
- `lib/commands.js`：命令注册与 `key=value` 解析（支持引号包住带空格的值、逗号数组）。
- `test/commands.test.mjs`（19 项）：解析器边界、注册去重、写盘行为、非法值拒绝、disposer 注销。

### 变更

- `inject` 从 `['tools']` 改成 `{ required: ['tools'], optional: ['commands'] }` —— 老宿主没有命令面时插件照旧工作，只是没有斜杠命令。

### 修复

- **插件曾整体加载失败**：inject 一度写成 { required: ['tools'], optional: ['commands'] }，而 cordis 只认数组或「服务名→拦截配置」映射，于是它去等两个名叫 equired/optional 的服务，日志报 pending (waiting for services: required, optional)，工具和命令都没注册上。改回 inject = ['tools'] + 子上下文挂命令。

## 0.4.0

### 新增

- **`lo_config` 工具**：查看 / 修改 / 重置插件配置。`action=show` 看当前值，`action=set` 改一项或多项，`action=reset` 恢复出厂。改完当场生效，并把非默认值写进 profile 的 `cordis.patch.yml`（重启后依然有效）。
- `lib/store.js`：配置的持久化层 —— 解析 / 渲染 / 替换 patch 里的本插件条目，字段校验与范围钳制。
- `test/store.test.mjs`（14 项）：YAML 条目解析、渲染、替换、往返一致性、字段校验、以及「本插件不在 patch 里时是新增而非替换」。

### 变更

- **修正一个错误认知**：DSH 桌面端（0.1.7）**不会**把第三方插件的 `Config` schema 渲染成设置表单。`dsh-settings` 自己写着「autoGenerate … 目前没有已发布的客户端这样做」，而侧边栏里像「演示文稿」那样的是 `dsh-ppt` 自己注册 React 组件做的。`Config` 保留下来只用于装载时校验与字段清单；改配置的通道是 `lo_config`。
- 工具数从 4 个变成 5 个，相关测试断言同步更新。

### 修复

- soffice / python 归一化后曾是 undefined，导致 lo_config 的返回值被 DSH 判为 `value is not lossless JSON`。现在保留空字符串（语义即「自动探测」），并在工具出口统一 scrub() 掉 undefined。
- lo_config reset 的改动列表曾渲染成 [object Object]。

## 0.3.0

### 新增

- **自动排版**（`autoFit` / `minFontSize` 设置项）：用 LibreOffice 自己的排版引擎量出文字在给定宽度下所需的高度，放不下就二分缩小字号。默认 `shrink`，`off` 可关闭。`lo_build` 结果新增 `autoFit` / `fitAdjusted` / `fitOverflow` 三个字段。
- `test/autofit.test.mjs`（12 项）：验证短内容不缩、中等内容真的缩（17pt→13.9pt）、超量内容计入溢出、关掉时完全不干预、常驻 worker 路径同样可用。

### 说明

- 没有采用 LibreOffice 的 `TextFitToSize`：实测 `PROPORTIONAL` 会把文字放大到填满文本框，`AUTOFIT` 依赖对方渲染器解释 `<a:normAutofit>`，都不可控。
- 也没有搬 ppt-master 的 `svg_text_metrics.py`：它依赖 Pillow，而 LibreOffice 自带的 python 没有 Pillow；用 UNO 自己量更准，且零新增依赖。

## 0.2.0

### 新增

- **设置面板**：导出 `Config`（`lib/config.js`），DSH 自动生成表单。可改 `soffice` / `python` 路径、默认主题、比例、导出格式、PNG 宽度、页脚、页码、超时、常驻开关与空闲回收时间。只有标了 `.volatile()` 的字段上表单，改完即时生效，不用重启。
- **常驻进程**（`lib/worker.js` + `python/lo_bridge.py --serve`）：python 桥保持长连接，复用同一个无头 soffice。同一进程内第二次 build 从 2.4 秒降到 **0.26 秒**。串行排队、空闲回收（`idleMs`）、崩溃自动重起。
- **取消支持**：四个工具都接 DSH 的 abort signal；中断时杀整棵子进程树（`taskkill /T /F`），不留孤儿 soffice。

### 变更

- 默认值不再写死在 `tools.js`：主题 / 比例 / 格式 / PNG 宽度 / 页脚 / 页码 / 超时全部来自配置（单次调用仍可用参数覆盖）。
- `python` 路径可配置，`DSH_LO_SOFFICE` / `DSH_LO_PYTHON` 环境变量仍然有效。
- 仓库对外名称改为 **office-ppt**；npm 包名与插件 id 仍是 `dsh-lo-office`。
- 页脚出厂默认文字改为 `office-ppt · 由本机 LibreOffice 生成`。
- 新增直接依赖 `@deepseek-ai/schemastery`（取不到时自动降级：没有设置面板，其它功能照常）。

### 测试

- 新增 `test/config.test.mjs`（14 项）：schema 校验、非法值兜底、`{get()}` volatile 容器、工具默认值继承。

## 0.1.0

首个可用版本。

### 工具

- `lo_probe` —— 探测 soffice 路径 / 版本、自带 Python、`uno` 可导入性，并实际打开一份无头 Impress 文档；可传 `soffice` 覆盖自动探测。
- `lo_build` —— 由结构化 slides 生成 deck，导出 PPTX / ODP / PDF / 逐页 PNG。
- `lo_render` —— 把已有 PPTX/PPT/ODP 渲染成 PDF / 逐页 PNG。
- `lo_convert` —— 任意文档格式互转，走 `soffice --convert-to`。

### 能力

- 10 种版式：`cover` / `section` / `bullets` / `statement` / `quote` / `table` / `image` / `image-left` / `image-right` / `closing`。
- 5 套主题：`light` / `dark` / `slate` / `warm` / `swiss`；`16:9` 与 `4:3`。
- 表格（表头、斑马纹、描边、垂直居中）、图片（等比居中）、讲者备注、页脚与页码。

### 已验证

- LibreOffice **26.8.1.1** + 自带 Python 3.13.15（Windows）。
- 7 页 deck（pptx + pdf + 7 张 png）约 **2.4–2.6 秒**；首次运行多约 10 秒建独立用户配置目录。
- 产物核验：PPTX 内 `ppt/slides/slideN.xml`、`ppt/media/image1.png`、`ppt/notesSlides/notesSlide1.xml` 均正确落包。

### 已知边界

- 切页动画导出成 `<p:transition>`，但 LibreOffice 自身回读 `TransitionType` 为 0。
- 空 OLE2Shape（无数据图表）导出后会丢形状，图表需要真实数据。
- LibreOffice 26.8 无 SWF 导出过滤器。
- 备注页在 26.8 没有 `com.sun.star.presentation.NotesShape` 服务名，按备注页上的 Text 形状写入。
