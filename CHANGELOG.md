# Changelog

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
