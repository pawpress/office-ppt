# Changelog

## 0.1.0

### 新增

- **两套高级排版主题 `atelier` / `noir`**：中文衬线、大留白、巨号数字、满幅出血图、发丝线、字距标签。走 `layout_lux()` 这条独立渲染路径，五个基础主题的版式完全不受影响。
- **四个配合高级主题的版式**：`editorial`（图文主次编排）、`kpi`（大数字指标）、`index`（编号目录）、`hero`（巨号主标题）。版式总数 10 → 14。
- **每页新增两个字段**：`caption`（图片说明，压在图片下方）、`imageSide`（`left` / `right`，图文页图片放哪一侧）。
- **`lo_build` 新增五个参数**：`font`（正文字体族，默认 Microsoft YaHei）、`titleSize`（默认 44）、`bulletSize`（默认 17）、`tableSize`（默认 13）、`transition`（页转场，LibreOffice TransitionType 整数，如 1=无、56=淡入）。三个字号参数被夹进可读区间（标题 12–96、正文 8–48、表格 6–32）——传 5000 不会再把整页撑爆。
- 渐变底色块（`add_grad()`）：线性渐变，取不到渐变 API 时退化成纯色，不让整页构建失败。
- 满幅出血图（`add_image(..., cover=True)`）：铺满框后按比例裁掉溢出部分。

### 变更

- 主题枚举收敛到 `lib/config.js` 一处，`lib/tools.js` 与 `python/lo_bridge.py` 都跟着它走。以前三处各写一份，tools 那侧加了 atelier/noir 而 config 没跟，于是工具声称支持七个主题、`/ppt-config theme=atelier` 却被校验拒掉。

### 修复

- **并发构建互相踩**：以前所有构建共用 `profile-main`，第二个构建进来会抢同一个配置目录和端口，表现为长时间等待后超时。现在每个 session 一个 profile 目录，并回收超龄目录。
- **一张图找不到就毁掉整份 deck**：以前 `add_image()` 直接 raise，19 页里后面 18 页全白做。现在画灰色占位框，把问题写进 `warnings` 随结果返回，构建照常完成。
- **非致命问题对用户完全静默**：`warnings` 以前只到 python 为止，`renderBuild()` 从不读这个字段 —— 缺图时用户看到的只是"这版排版莫名变丑了"。现在 `lo_build` / `lo_render` 都会打出「⚠️ N 处需要留意」加逐条原因。
- **`statement` / `quote` 的垂直居中失效**：`anchor="center"` 在 `setString()` 之前设，被随后的默认样式覆盖回 TOP。现在设完文本再抹回去。
- **图文版式吞掉 `subtitle`**：只给 `subtitle` 的图文页以前退化成「纯居中大图」，因为判断"这页有没有正文"时没把 subtitle 算进去。
- **`image` 版式的图片压住正文**：图底在 `H-M-1400`，而 subtitle 顶在 `H-M-1900`，直接叠进图里 500。
- **侧栏图没给图注留位置**：图底正好压在页脚线上，`caption` 根本没处放，现在给它腾出一块。
- **表格默认样式漏出彩色格线**：四边先一律关掉，再只开需要的那几条。
- **`baseName` 能把文件写出 outDir 之外**：`baseName = "../x/y"` 以前等于给了个任意路径，现在 `safe_base_name()` 只保留安全字符。
- **`overwrite: false` 是哑参数**：schema 里有、Python 侧根本没读，永远覆盖。现在真读，并且会连首张 PNG 一起探，否则旧的逐页图会被悄悄盖掉。
- **`lo_build` 的 `overwrite` 从未传给桥**：`lib/engine.js` 的 `buildDeck()` 漏了这个字段，工具层传了也白传。
- **`hero` 不给图就报「图片不存在（空路径）」**：`layout_lux()` 的 hero 分支无条件调 `add_image()`，没写 `image` 的页会画出「缺图」灰框并附一条警告。hero 的语义是「整页压一句主张」，配图只是背景的一种 —— 现在没图就退化成深色渐变底，不再误报。
- **非高级主题下 `editorial` / `kpi` / `index` / `hero` 静默降级**：这四个版式只在 `layout_lux()` 里实现，`theme: 'light'` 配 `layout: 'hero'` 会掉进 bullets 分支，用户拿到的页面和选中的版式毫无关系却没有任何提示。现在会明确告知「版式 X 只在 atelier / noir 主题下生效」。
