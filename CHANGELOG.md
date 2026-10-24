# Changelog

## 0.2.0

### 修复

- **满幅出血图 `cover=True` 从未真正裁切过**：`add_image()` 用 `createUnoStruct("com.sun.star.drawing.RectanglePoint")` 建裁切结构，可 `RectanglePoint` 是枚举，`createUnoStruct` 必然抛异常；异常又被 `except Exception: pass` 吞掉，于是每张「满幅出血图」都静默退化成等比缩放居中——页面上下来两条白边，一个警告都没有。现在改用 `com.sun.star.text.GraphicCrop`（STRUCT，四条边各一个裁切量），并按图片自然尺寸 `Size100thMM` 换算裁切量（原来的注释「单位是 1/1000 百分比、满值 100000」是错的，按它算出来的值要么把图裁空、要么一点没裁）。
- **裁切失败不再静默**：`except` 分支现在走 `warn()`，退回等比缩放的同时把原因写进 `warnings`，随 `lo_build` / `lo_render` 的「⚠️ N 处需要留意」一起报到用户眼前。
- **`atelier` / `noir` 带图版式整页变纯白**：`layout_lux()` 的 `hero` 分支和 `image-left` / `image-right` 分支都没铺主题底色，只有「没给图」的分支才画。结果一份米色底的 deck 里，凡是有图的页都是刺眼的纯白。两处都补上 `add_rect(0, 0, W, H, bg)` 打底。
- **高级主题的副标题压住页脚**：`hero` 的副标题框落在 0.895H、框高 `H*0.09`，底沿到 0.985H，正压在页脚行（0.90H + 420）上，只要写了 `subtitle` 文字就和页码叠在一起。副标题上移到 0.885H、框高压到 650 单位；标题框同步从 0.72H 抬到 0.67H，避免和副标题抢位置。

### 新增

- **`test/cover-crop.test.mjs`：像素级回归测试**（`npm run test:cover`，已接入 `test:all` 与 CI 的 `integration` job）。用例生成一张上红下蓝的 3:1 PNG，分别以 `hero` 和 `image-left` 版式构建，再逐像素解码导出的 PNG 断言：满幅页四角和左右边缘都必须是图片内容（纯白或主题底色一律判失败，直接点名「图没铺到这里」/「图被等比居中，没有裁切出血」），且 `image-left` 未放图那半边必须是主题底色而不是白。这两个 bug 都只在像素上看得出来，`RectanglePoint` 那次甚至没留下任何警告——所以测试跑的是真渲染、真解码。
- 该测试的反向对照已验证：把 `python/lo_bridge.py` 的修复 stash 掉再跑，`hero` 四角与左右边缘、`image-left` 两处底色共 6 条断言转红。

## 0.1.1

### 修复

- **正文行宽没有上限**：以前正文框给到 `W - 2 * M`，16:9 上一条长要点会拉成一百多字的超长行，换行位置全凭运气。现在按页宽 0.74 封顶（`measure = min(W - 2 * M, int(W * 0.74))`），中文大约六十字一行。五个基础主题的 bullets / body 都走这条。
- **内容块整体偏上**：`_distribute` 量高度时把最后一段的段后距也算进了文字高度，而这段留白纸面上看不见。于是 `slack = band_h - needed` 偏小，内容块被顶到上半页，下留白明显大于上留白。现在先减掉 `eff_spacing` 再算 `slack`（`visual = needed - eff_spacing`）。
- **`kpi` 版式整组贴在上半页**：以前固定 `top = int(H * 0.44)`，条目少时下半页整片空着。现在按标题底到页脚之间的可用区垂直居中，大数字 54 → 72 磅，说明文字 12.5 → 13 磅，列间竖线跟着整组高度走。
- **`editorial` 巨号数字与竖线不对齐**：150 磅的字形在框里会往下沉约 90px，数字框仍从 `H * 0.30` 起画时视觉中心明显低于右侧发丝线。数字框移到 `H * 0.245`。

### 变更

- **`bulletSize` 默认值 17 → 20**。1920px 宽的页面上 17 磅正文偏小，投影时后排读不清。`lib/tools.js` 的参数描述同步改成「默认 20」。

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
