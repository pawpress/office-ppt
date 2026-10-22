#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""dsh-lo-office UNO 桥。

两种跑法：

  一次性（默认）：从 stdin 读一个 JSON 请求，向 stdout 写一个 JSON 响应。
  常驻（--serve）：从 stdin 逐行读 JSON，逐行写 JSON；soffice 与 uno 连接都留着复用，
                   省掉每次约 0.5 秒的冷启动。响应里带请求的 id 便于配对。

命令：
    probe    探测 LibreOffice / python / UNO 是否可用
    build    JSON 幻灯片规格 -> ODP / PPTX / PDF / 逐页 PNG
    render   已有 PPT/PPTX/ODP -> PDF / 逐页 PNG
    convert  任意格式互转（走 soffice --convert-to）

设计约定：
  * 绝不使用用户正在使用的 LibreOffice 配置目录，一律用独立的 UserInstallation，
    避免抢用户的窗口或把用户的 Impress 关掉。
  * 所有文件 URL 都经过 uno.systemPathToFileUrl()，Windows 原生路径直接传会报
    0x81a(Error Area:Io Class:Parameter Code:26)。
"""

import atexit
import contextlib
import json
import os
import random
import subprocess
import sys
import time
import traceback

# ---------------------------------------------------------------- 常量

# com.sun.star.drawing.FillStyle / LineStyle / TextVerticalAdjust / ParaAdjust
FILL_NONE, FILL_SOLID = 0, 1
LINE_NONE, LINE_SOLID = 0, 1
ANCHOR_TOP, ANCHOR_CENTER, ANCHOR_BOTTOM = 0, 1, 2
ADJUST_LEFT, ADJUST_RIGHT, ADJUST_BLOCK, ADJUST_CENTER = 0, 1, 2, 3

ALIGN = {
    "left": ADJUST_LEFT,
    "right": ADJUST_RIGHT,
    "center": ADJUST_CENTER,
    "justify": ADJUST_BLOCK,
}
ANCHOR = {"top": ANCHOR_TOP, "center": ANCHOR_CENTER, "bottom": ANCHOR_BOTTOM}

# 导出过滤器
FILTER_PPTX = "Impress MS PowerPoint 2007 XML"
FILTER_ODP = "impress8"
FILTER_PDF = "impress_pdf_Export"
FILTER_PNG = "impress_png_Export"

# 16:9 / 4:3 画布尺寸，单位 1/100 mm
RATIOS = {"16:9": (33867, 19050), "4:3": (28000, 21000)}

THEMES = {
    "light": {"bg": "#FFFFFF", "fg": "#111827", "muted": "#6B7280", "accent": "#2563EB", "panel": "#F3F4F6"},
    "dark": {"bg": "#0B1220", "fg": "#E5E7EB", "muted": "#94A3B8", "accent": "#38BDF8", "panel": "#111C31"},
    "slate": {"bg": "#1E293B", "fg": "#F1F5F9", "muted": "#94A3B8", "accent": "#FBBF24", "panel": "#273549"},
    "warm": {"bg": "#FFFBF5", "fg": "#3F2D20", "muted": "#8B7355", "accent": "#C2410C", "panel": "#F6EBDA"},
    "swiss": {"bg": "#F8FAFC", "fg": "#0F172A", "muted": "#64748B", "accent": "#DC2626", "panel": "#E2E8F0"},
}


# ---------------------------------------------------------------- 基础工具


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def hexcolor(value, default=0x000000):
    if isinstance(value, int):
        return value & 0xFFFFFF
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    try:
        return int(text, 16) & 0xFFFFFF
    except Exception:
        return default


def find_soffice(explicit=None):
    if explicit and os.path.isfile(explicit):
        return explicit
    for env in ("DSH_LO_SOFFICE", "LO_SOFFICE"):
        value = os.environ.get(env)
        if value and os.path.isfile(value):
            return value
    try:
        import winreg

        for key in (
            r"SOFTWARE\LibreOffice\UNO\InstallPath",
            r"SOFTWARE\WOW6432Node\LibreOffice\UNO\InstallPath",
        ):
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key) as handle:
                    base, _ = winreg.QueryValueEx(handle, "")
                candidate = os.path.join(base, "soffice.exe")
                if os.path.isfile(candidate):
                    return candidate
            except OSError:
                continue
    except ImportError:
        pass
    for candidate in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/usr/bin/soffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def profile_dir(tag="main"):
    base = os.path.join(
        os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or "/tmp",
        "dsh-lo-office",
    )
    path = os.path.join(base, "profile-" + tag)
    os.makedirs(path, exist_ok=True)
    return path


def start_soffice(soffice, port, tag="main", extra=()):
    url = "file:///" + profile_dir(tag).replace("\\", "/")
    args = [
        soffice,
        "--headless",
        "--invisible",
        "--norestore",
        "--nologo",
        "--nodefault",
        "--nolockcheck",
        "--nofirststartwizard",
        "-env:UserInstallation=" + url,
        "--accept=socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext" % port,
    ]
    args.extend(extra)
    return subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def connect(port, timeout=60.0):
    import uno

    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local
    )
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            return resolver.resolve(
                "uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext" % port
            )
        except Exception as error:  # 服务还没起来
            last = error
            time.sleep(0.25)
    raise RuntimeError("无法连接 LibreOffice（端口 %d）：%s" % (port, last))


class Session:
    """一次调用独占一个 soffice 进程 + 独立配置目录，退出时必清理。"""

    def __init__(self, soffice=None, timeout=60.0):
        self.soffice = find_soffice(soffice)
        if not self.soffice:
            raise RuntimeError(
                "找不到 soffice.exe：请安装 LibreOffice，或设置 DSH_LO_SOFFICE 环境变量指向 soffice.exe"
            )
        self.timeout = timeout
        self.proc = None
        self.ctx = None
        self.port = random.randint(2300, 2899)

    def __enter__(self):
        self.proc = start_soffice(self.soffice, self.port, "main")
        try:
            self.ctx = connect(self.port, self.timeout)
        except Exception:
            self._kill()
            # 配置目录可能被上一次残留进程占着，换个槽位再试一次
            self.port = random.randint(2900, 3200)
            self.proc = start_soffice(self.soffice, self.port, "alt")
            self.ctx = connect(self.port, self.timeout)
        self.smgr = self.ctx.ServiceManager
        self.desktop = self.smgr.createInstanceWithContext(
            "com.sun.star.frame.Desktop", self.ctx
        )
        return self

    def __exit__(self, *_exc):
        self._kill()
        return False

    def _kill(self):
        if self.proc is None:
            return
        try:
            self.proc.terminate()
            self.proc.wait(timeout=20)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None

    # -------------------------------------------------------- 文档操作

    def new_presentation(self):
        return self.desktop.loadComponentFromURL(
            "private:factory/simpress", "_blank", 0, ()
        )

    def open(self, path):
        import uno

        return self.desktop.loadComponentFromURL(
            uno.systemPathToFileUrl(os.path.abspath(path)), "_blank", 0, ()
        )

    def export(self, doc, path, filter_name, filter_data=None):
        import uno
        from com.sun.star.beans import PropertyValue

        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        props = []
        name = PropertyValue()
        name.Name, name.Value = "FilterName", filter_name
        props.append(name)
        if filter_data:
            data = PropertyValue()
            data.Name = "FilterData"
            data.Value = tuple(filter_data)
            props.append(data)
        doc.storeToURL(uno.systemPathToFileUrl(os.path.abspath(path)), tuple(props))
        return os.path.abspath(path)


def pv(name, value):
    from com.sun.star.beans import PropertyValue

    item = PropertyValue()
    item.Name, item.Value = name, value
    return item


# ---------------------------------------------------------------- 绘图积木


def clear_page(page):
    while page.getCount() > 0:
        page.remove(page.getByIndex(0))


def add_rect(doc, page, x, y, w, h, fill, line=None, radius=0):
    from com.sun.star.awt import Point, Size

    shape = doc.createInstance("com.sun.star.drawing.RectangleShape")
    shape.setPosition(Point(int(x), int(y)))
    shape.setSize(Size(int(w), int(h)))
    shape.FillStyle = FILL_SOLID
    shape.FillColor = fill
    if line is None:
        shape.LineStyle = LINE_NONE
    else:
        shape.LineStyle = LINE_SOLID
        shape.LineColor = line
        shape.LineWidth = 20
    if radius:
        try:
            shape.CornerRadius = int(radius)
        except Exception:
            pass
    page.add(shape)
    return shape


# ---------------------------------------------------------------- 自动排版
#
# 思路：不靠 PIL 估字宽，而是让 LibreOffice 自己排版一次——把 TextAutoGrowHeight
# 打开、把宽度固定、把高度设成极小值，再读回 shape.Size.Height，就得到这段文字
# 在给定宽度下需要多高。确认放不下后用二分法缩小字号重新量，直到塞进框里。
#
# 注意 TextFitToSize 那条路是错的：PROPORTIONAL / AUTOFIT 会把文字放大到填满
# 文本框（实测小框里出现一个字半页大的字形），只能用来「填充」，不能用来「适配」。
_FIT = {"mode": "off", "min": 12.0, "hits": 0}


def set_fit(mode, min_size):
    """由 build 请求里的 autoFit / minFontSize 设置本进程的排版策略。"""
    _FIT["mode"] = "shrink" if str(mode or "").strip().lower() == "shrink" else "off"
    try:
        value = float(min_size)
    except (TypeError, ValueError):
        value = 12.0
    _FIT["min"] = max(6.0, min(72.0, value))
    _FIT["hits"] = 0
    _FIT["overflow"] = 0


def _set_char_height(shape, size):
    """把整段文字的字号改成 size（含中文字号）。"""
    try:
        cursor = shape.createTextCursor()
        cursor.gotoStart(False)
        cursor.gotoEnd(True)
        cursor.CharHeight = float(size)
        cursor.CharHeightAsian = float(size)
    except Exception:
        pass


def _needed_height(shape, w):
    """量这段文字在宽度 w 下需要多高；量不出来返回 None。"""
    from com.sun.star.awt import Size

    try:
        shape.TextAutoGrowHeight = True
        # 关键：设完文字之后必须重设一次尺寸，否则读到的是上一次排版的结果。
        shape.setSize(Size(int(w), 100))
        return int(shape.Size.Height)
    except Exception:
        return None


def fit_text(shape, w, h, size, min_size):
    """二分出能塞进 (w, h) 的最大字号。

    返回 (最终字号, 状态)，状态三选一：
      ok       —— 原字号就放得下，没动过
      shrunk   —— 缩小后才放下
      overflow —— 缩到下限仍然放不下
    """
    needed = _needed_height(shape, w)
    if needed is None or needed <= h:
        return float(size), "ok"

    low, high = float(min_size), float(size)
    best = None
    for _ in range(7):
        mid = (low + high) / 2.0
        _set_char_height(shape, mid)
        needed = _needed_height(shape, w)
        if needed is None:
            _set_char_height(shape, size)
            return float(size), "ok"
        if needed <= h:
            best = mid
            low = mid
        else:
            high = mid
        if high - low < 0.5:
            break

    if best is None:
        _set_char_height(shape, min_size)
        return float(min_size), "overflow"
    _set_char_height(shape, best)
    return best, "shrunk"


def add_text(
    doc,
    page,
    x,
    y,
    w,
    h,
    text,
    size=18,
    color=0x111827,
    bold=False,
    font="Microsoft YaHei",
    align="left",
    anchor="top",
    spacing=0,
    margin=0,
    italic=False,
    fit=True,
):
    from com.sun.star.awt import Point, Size

    shape = doc.createInstance("com.sun.star.drawing.TextShape")
    shape.setPosition(Point(int(x), int(y)))
    shape.setSize(Size(int(w), int(h)))
    page.add(shape)

    for attr, value in (
        ("TextAutoGrowHeight", False),
        ("TextAutoGrowWidth", False),
        ("TextWordWrap", True),
        ("TextLeftDistance", int(margin)),
        ("TextRightDistance", int(margin)),
        ("TextUpperDistance", int(margin)),
        ("TextLowerDistance", int(margin)),
        ("TextVerticalAdjust", ANCHOR.get(anchor, ANCHOR_TOP)),
    ):
        try:
            setattr(shape, attr, value)
        except Exception:
            pass

    shape.setString(text or "")
    cursor = shape.createTextCursor()
    cursor.gotoStart(False)
    cursor.gotoEnd(True)
    for attr, value in (
        ("CharHeight", float(size)),
        ("CharHeightAsian", float(size)),
        ("CharWeight", 150.0 if bold else 100.0),
        ("CharWeightAsian", 150.0 if bold else 100.0),
        ("CharPosture", 2 if italic else 0),
        ("CharFontName", font),
        ("CharFontNameAsian", font),
        ("CharColor", color),
        ("ParaAdjust", ALIGN.get(align, ADJUST_LEFT)),
    ):
        try:
            setattr(cursor, attr, value)
        except Exception:
            pass
    if spacing:
        try:
            cursor.ParaBottomMargin = int(spacing)
        except Exception:
            pass

    # 自动排版：放不下就缩字号（量测与二分见 fit_text 上方注释）。
    if fit and _FIT["mode"] == "shrink" and (text or "").strip():
        _, status = fit_text(shape, w, h, size, _FIT["min"])
        if status == "shrunk":
            _FIT["hits"] += 1
        elif status == "overflow":
            _FIT["overflow"] += 1
    try:
        shape.TextAutoGrowHeight = False
        from com.sun.star.awt import Size as _Size

        shape.setSize(_Size(int(w), int(h)))
    except Exception:
        pass
    return shape


def add_image(doc, session, page, x, y, w, h, path):
    import uno

    if not path or not os.path.isfile(path):
        raise RuntimeError("图片不存在：%s" % path)
    provider = session.smgr.createInstanceWithContext(
        "com.sun.star.graphic.GraphicProvider", session.ctx
    )
    graphic = provider.queryGraphic((pv("URL", uno.systemPathToFileUrl(os.path.abspath(path))),))
    shape = doc.createInstance("com.sun.star.drawing.GraphicObjectShape")
    shape.Graphic = graphic
    page.add(shape)

    # 等比缩放后居中放进 (x,y,w,h) 的框里
    natural = graphic.getSize()
    nw, nh = natural.Width, natural.Height
    if nw > 0 and nh > 0:
        scale = min(float(w) / nw, float(h) / nh)
        tw, th = int(nw * scale), int(nh * scale)
    else:
        tw, th = int(w), int(h)
    ox, oy = int(x + (w - tw) / 2), int(y + (h - th) / 2)
    from com.sun.star.awt import Point, Size

    shape.setPosition(Point(ox, oy))
    shape.setSize(Size(tw, th))
    return shape


def add_table(doc, page, x, y, w, h, rows, size=14, font="Microsoft YaHei",
              fg=0x111827, header_bg=None, header_fg=None, line=0xD1D5DB, panel=0xF9FAFB,
              pad=280):
    from com.sun.star.awt import Point, Size

    shape = doc.createInstance("com.sun.star.drawing.TableShape")
    shape.setPosition(Point(int(x), int(y)))
    shape.setSize(Size(int(w), int(h)))
    page.add(shape)
    table = shape.Model

    nrows = len(rows)
    ncols = max(len(row) for row in rows)
    if nrows > 1:
        table.Rows.insertByIndex(table.Rows.Count, nrows - 1)
    if ncols > 1:
        table.Columns.insertByIndex(table.Columns.Count, ncols - 1)

    col_w = int(w / ncols)
    for index in range(ncols):
        try:
            table.Columns.getByIndex(index).Width = col_w
        except Exception:
            pass
    row_h = min(int(h / nrows), 2400)
    try:
        shape.setSize(Size(int(w), row_h * nrows))
    except Exception:
        pass
    for index in range(nrows):
        try:
            table.Rows.getByIndex(index).Height = row_h
        except Exception:
            pass

    for r in range(nrows):
        for c in range(ncols):
            cell = table.getCellByPosition(c, r)
            value = rows[r][c] if c < len(rows[r]) else ""
            cell.setString(str(value))
            is_head = r == 0
            # 单元格内边距 + 垂直居中：不设的话文字会贴着格子左上角，表头像被切掉一半
            for attr, val in (
                ("TextLeftDistance", int(pad)),
                ("TextRightDistance", int(pad / 2)),
                ("TextUpperDistance", int(pad / 2)),
                ("TextLowerDistance", int(pad / 2)),
                ("TextVerticalAdjust", ANCHOR_CENTER),
            ):
                try:
                    cell.setPropertyValue(attr, val)
                except Exception:
                    pass
            try:
                if is_head and header_bg is not None:
                    cell.FillStyle = FILL_SOLID
                    cell.FillColor = header_bg
                elif not is_head and panel is not None:
                    cell.FillStyle = FILL_SOLID
                    cell.FillColor = 0xFFFFFF if r % 2 else panel
            except Exception:
                pass
            if line is not None:
                for attr in ("TopBorder", "BottomBorder", "LeftBorder", "RightBorder"):
                    try:
                        border = cell.getPropertyValue(attr)
                        border.Color = line
                        border.LineWidth = 10
                        cell.setPropertyValue(attr, border)
                    except Exception:
                        pass
            try:
                cursor = cell.createTextCursor()
                cursor.gotoStart(False)
                cursor.gotoEnd(True)
                cursor.CharHeight = float(size)
                cursor.CharHeightAsian = float(size)
                cursor.CharWeight = 150.0 if is_head else 100.0
                cursor.CharWeightAsian = 150.0 if is_head else 100.0
                cursor.CharFontName = font
                cursor.CharFontNameAsian = font
                cursor.CharColor = (header_fg if (is_head and header_fg is not None) else fg)
            except Exception:
                pass
    return shape


def set_notes(page, text):
    if not text:
        return
    notes = page.getNotesPage()
    for index in range(notes.getCount()):
        shape = notes.getByIndex(index)
        try:
            if shape.supportsService("com.sun.star.drawing.Text"):
                shape.setString(str(text))
                return
        except Exception:
            continue


# ---------------------------------------------------------------- build


def layout_slide(doc, session, page, slide, spec, palette, geom, index, total):
    W, H = geom
    M = int(min(W, H) * 0.075)          # 页边距
    font = spec.get("font") or "Microsoft YaHei"
    bg = hexcolor(palette["bg"])
    fg = hexcolor(palette["fg"])
    muted = hexcolor(palette["muted"])
    accent = hexcolor(palette["accent"])
    panel = hexcolor(palette["panel"])

    clear_page(page)
    add_rect(doc, page, 0, 0, W, H, bg)

    layout = (slide.get("layout") or "bullets").strip()
    title = slide.get("title") or ""
    subtitle = slide.get("subtitle") or ""
    kicker = slide.get("kicker") or ""
    body = slide.get("text") or ""
    bullets = [str(item) for item in (slide.get("bullets") or []) if str(item).strip()]
    caption = slide.get("caption") or ""
    rows = slide.get("rows") or []
    image = slide.get("image")
    if isinstance(image, dict):
        image = image.get("src")
    side = (slide.get("imageSide") or ("right" if layout == "image-right" else "left")).lower()

    def footer():
        if spec.get("footer"):
            add_text(doc, page, M, H - M - 900, W - 2 * M - 1600, 800,
                     spec["footer"], size=11, color=muted, font=font, fit=False)
        if spec.get("pageNumbers", True):
            add_text(doc, page, W - M - 1400, H - M - 900, 1400, 800,
                     str(index), size=11, color=muted, font=font, align="right", fit=False)

    if layout == "cover":
        add_rect(doc, page, 0, 0, int(W * 0.012), H, accent)
        if kicker:
            add_text(doc, page, M, int(H * 0.26), W - 2 * M, 900, kicker,
                     size=15, color=accent, bold=True, font=font)
        add_text(doc, page, M, int(H * 0.32), int(W * 0.74), int(H * 0.24), title,
                 size=spec.get("titleSize", 44), color=fg, bold=True, font=font)
        if subtitle:
            add_text(doc, page, M, int(H * 0.58), int(W * 0.7), int(H * 0.18), subtitle,
                     size=20, color=muted, font=font)
        footer()

    elif layout == "section":
        add_rect(doc, page, 0, 0, W, H, panel)
        add_rect(doc, page, M, int(H * 0.44), 1800, 120, accent)
        add_text(doc, page, M, int(H * 0.48), W - 2 * M, int(H * 0.2), title,
                 size=38, color=fg, bold=True, font=font)
        if subtitle:
            add_text(doc, page, M, int(H * 0.68), W - 2 * M, int(H * 0.12), subtitle,
                     size=16, color=muted, font=font)
        footer()

    elif layout == "statement":
        add_text(doc, page, M, int(H * 0.3), W - 2 * M, int(H * 0.4),
                 body or title, size=34, color=fg, bold=True, font=font,
                 align="center", anchor="center")
        if subtitle:
            add_text(doc, page, M, int(H * 0.72), W - 2 * M, int(H * 0.1), subtitle,
                     size=16, color=muted, font=font, align="center")
        footer()

    elif layout == "quote":
        # 竖条高度跟着内容走：原来固定 0.44H，单行引文时竖条比文字长一截，看着错位。
        quote_top = int(H * 0.30)
        quote_h = int(H * 0.28)
        attr_h = 900
        attr_y = quote_top + quote_h + 300
        bar_top = quote_top - 240
        content_bottom = (attr_y + attr_h) if subtitle else (quote_top + quote_h)
        add_rect(doc, page, M, bar_top, 1400, content_bottom - bar_top + 240, accent)
        add_text(doc, page, M + 2600, quote_top, W - 2 * M - 2600, quote_h,
                 body or title, size=28, color=fg, font=font, anchor="center")
        if subtitle:
            add_text(doc, page, M + 2600, attr_y, W - 2 * M - 2600, attr_h,
                     subtitle, size=15, color=muted, font=font)
        footer()

    elif layout == "closing":
        add_rect(doc, page, 0, 0, W, H, panel)
        add_text(doc, page, M, int(H * 0.34), W - 2 * M, int(H * 0.2), title or "谢谢",
                 size=42, color=fg, bold=True, font=font, align="center")
        if subtitle:
            add_text(doc, page, M, int(H * 0.56), W - 2 * M, int(H * 0.12), subtitle,
                     size=18, color=muted, font=font, align="center")
        footer()

    elif layout == "table":
        add_text(doc, page, M, M, W - 2 * M, 1600, title, size=28, color=fg, bold=True, font=font)
        add_rect(doc, page, M, M + 1750, 1600, 100, accent)
        table_top = M + 2600
        if rows:
            add_table(doc, page, M, table_top, W - 2 * M, H - table_top - M - 1200, rows,
                      size=spec.get("tableSize", 13), font=font, fg=fg,
                      header_bg=accent, header_fg=hexcolor(palette["bg"]), panel=panel)
        footer()

    elif layout in ("image", "image-left", "image-right"):
        has_text = bool(bullets or body)
        if layout == "image" or not has_text:
            add_text(doc, page, M, M, W - 2 * M, 1500, title, size=26, color=fg, bold=True, font=font)
            box_top = M + 2000
            add_image(doc, session, page, M, box_top, W - 2 * M, H - box_top - M - 1400, image)
            if caption:
                add_text(doc, page, M, H - M - 1000, W - 2 * M, 800, caption,
                         size=11, color=muted, font=font, align="center")
        else:
            gap = int(W * 0.04)
            text_w = int(W * 0.42)
            img_w = W - 2 * M - text_w - gap
            img_x = M if side == "left" else M + text_w + gap
            text_x = M + img_w + gap if side == "left" else M
            add_image(doc, session, page, img_x, M + 900, img_w, H - 2 * M - 1800, image)
            add_text(doc, page, text_x, M, text_w, 1500, title, size=26, color=fg, bold=True, font=font)
            if bullets:
                add_text(doc, page, text_x, M + 2000, text_w, H - 2 * M - 2600,
                         "\n".join("\u2022  " + item for item in bullets),
                         size=16, color=fg, font=font, spacing=600)
            elif body:
                add_text(doc, page, text_x, M + 2000, text_w, H - 2 * M - 2600, body,
                         size=16, color=fg, font=font)
        footer()

    else:  # bullets 及未知布局
        if kicker:
            add_text(doc, page, M, M - 200, W - 2 * M, 900, kicker,
                     size=12, color=accent, bold=True, font=font)
        add_text(doc, page, M, M + 500, W - 2 * M, 1600, title, size=28, color=fg, bold=True, font=font)
        add_rect(doc, page, M, M + 2300, 1600, 100, accent)
        content_top = M + 3000
        content_h = H - content_top - M - 1200
        if bullets:
            add_text(doc, page, M, content_top, W - 2 * M, content_h,
                     "\n".join("\u2022  " + item for item in bullets),
                     size=spec.get("bulletSize", 17), color=fg, font=font, spacing=900)
        elif body:
            add_text(doc, page, M, content_top, W - 2 * M, content_h, body,
                     size=spec.get("bulletSize", 17), color=fg, font=font)
        footer()

    set_notes(page, slide.get("notes"))
    transition = spec.get("transition")
    if transition:
        try:
            page.TransitionType = int(transition)
        except Exception:
            pass


def export_png_pages(session, doc, out_dir, base, count, geom, png_width=None):
    """逐页导出 PNG。

    坑：无头模式下 FilterData.PageNumber 会被忽略，必须先用 controller.setCurrentPage()
    把当前页切过去，否则导出的每一页都是第 1 页（字节完全相同）。
    """
    width, height = geom
    controller = None
    try:
        controller = doc.getCurrentController()
    except Exception:
        controller = None
    pages = doc.getDrawPages()
    paths = []
    for number in range(1, count + 1):
        if controller is not None:
            try:
                controller.setCurrentPage(pages.getByIndex(number - 1))
            except Exception:
                pass
        data = [pv("PageNumber", number)]
        if png_width:
            data.append(pv("PixelWidth", int(png_width)))
            data.append(pv("PixelHeight", int(int(png_width) * height / width)))
        path = os.path.join(out_dir, "%s-%02d.png" % (base, number))
        paths.append(session.export(doc, path, FILTER_PNG, data))
    return paths


def cmd_build(req):
    spec = req.get("spec") or {}
    slides = spec.get("slides") or []
    if not slides:
        raise RuntimeError("spec.slides 为空：没有可生成的幻灯片")

    set_fit(req.get("autoFit"), req.get("minFontSize"))

    theme = spec.get("theme") or "light"
    palette = dict(THEMES.get(theme, THEMES["light"]))
    for key, value in (spec.get("colors") or {}).items():
        if key in palette and value:
            palette[key] = value

    geom = RATIOS.get(spec.get("ratio") or "16:9", RATIOS["16:9"])
    if spec.get("width") and spec.get("height"):
        geom = (int(spec["width"]), int(spec["height"]))

    out_dir = os.path.abspath(req.get("outDir") or ".")
    base = req.get("baseName") or "deck"
    formats = req.get("formats") or ["pptx"]
    png_width = req.get("pngWidth")

    timings = {}
    started = time.time()
    files = {}

    with session_scope(req) as session:
        timings["connect"] = round(time.time() - started, 2)
        doc = session.new_presentation()
        try:
            pages = doc.getDrawPages()
            while pages.getCount() < len(slides):
                pages.insertNewByIndex(pages.getCount())
            while pages.getCount() > len(slides):
                pages.remove(pages.getByIndex(pages.getCount() - 1))

            # 关键：private:factory/simpress 的默认页是 28000x15750，
            # 不显式改成目标尺寸，按 16:9 画布算出来的坐标会整条掉到页面外被裁掉。
            for index in range(pages.getCount()):
                page = pages.getByIndex(index)
                try:
                    page.Width = int(geom[0])
                    page.Height = int(geom[1])
                except Exception:
                    pass

            for index in range(len(slides)):
                layout_slide(doc, session, pages.getByIndex(index), slides[index],
                             spec, palette, geom, index + 1, len(slides))
            timings["build"] = round(time.time() - started, 2)

            if "odp" in formats:
                files["odp"] = session.export(doc, os.path.join(out_dir, base + ".odp"), FILTER_ODP)
            if "pptx" in formats:
                files["pptx"] = session.export(doc, os.path.join(out_dir, base + ".pptx"), FILTER_PPTX)
            if "pdf" in formats:
                files["pdf"] = session.export(doc, os.path.join(out_dir, base + ".pdf"), FILTER_PDF)
            if "png" in formats:
                files["png"] = export_png_pages(session, doc, out_dir, base, len(slides), geom, png_width)
            timings["export"] = round(time.time() - started, 2)
        finally:
            try:
                doc.close(True)
            except Exception:
                pass

    sizes = {}
    for key, value in files.items():
        if isinstance(value, list):
            sizes[key] = [os.path.getsize(item) for item in value]
        else:
            sizes[key] = os.path.getsize(value)

    return {
        "ok": True,
        "command": "build",
        "slideCount": len(slides),
        "soffice": session.soffice,
        "theme": theme,
        "ratio": spec.get("ratio") or "16:9",
        "autoFit": _FIT["mode"],
        "fitAdjusted": _FIT["hits"],
        "fitOverflow": _FIT.get("overflow", 0),
        "files": files,
        "bytes": sizes,
        "timings": timings,
        "totalSeconds": round(time.time() - started, 2),
    }


# ---------------------------------------------------------------- render / convert


def cmd_render(req):
    source = req.get("source")
    if not source or not os.path.isfile(source):
        raise RuntimeError("找不到要渲染的文件：%s" % source)
    source = os.path.abspath(source)
    out_dir = os.path.abspath(req.get("outDir") or os.path.dirname(source))
    os.makedirs(out_dir, exist_ok=True)
    base = req.get("baseName") or os.path.splitext(os.path.basename(source))[0]
    formats = req.get("formats") or ["pdf"]
    png_width = req.get("pngWidth")
    started = time.time()
    files = {}
    timings = {}

    with session_scope(req) as session:
        timings["connect"] = round(time.time() - started, 2)
        doc = session.open(source)
        try:
            pages = doc.getDrawPages()
            count = pages.getCount()
            width, height = 33867, 19050
            try:
                page = pages.getByIndex(0)
                width, height = page.Width, page.Height
            except Exception:
                pass
            timings["open"] = round(time.time() - started, 2)

            if "pdf" in formats:
                files["pdf"] = session.export(doc, os.path.join(out_dir, base + ".pdf"), FILTER_PDF)
            if "png" in formats:
                files["png"] = export_png_pages(
                    session, doc, out_dir, base, count, (width, height), png_width
                )
            if "pptx" in formats:
                files["pptx"] = session.export(doc, os.path.join(out_dir, base + ".pptx"), FILTER_PPTX)
            if "odp" in formats:
                files["odp"] = session.export(doc, os.path.join(out_dir, base + ".odp"), FILTER_ODP)
            timings["export"] = round(time.time() - started, 2)
        finally:
            try:
                doc.close(True)
            except Exception:
                pass

    sizes = {}
    for key, value in files.items():
        sizes[key] = [os.path.getsize(item) for item in value] if isinstance(value, list) else os.path.getsize(value)

    return {
        "ok": True,
        "command": "render",
        "source": source,
        "slideCount": count,
        "files": files,
        "bytes": sizes,
        "timings": timings,
        "totalSeconds": round(time.time() - started, 2),
    }


def cmd_convert(req):
    source = req.get("source")
    if not source or not os.path.isfile(source):
        raise RuntimeError("找不到要转换的文件：%s" % source)
    soffice = find_soffice(req.get("soffice"))
    if not soffice:
        raise RuntimeError("找不到 soffice.exe")
    target = req.get("to") or "pdf"
    out_dir = os.path.abspath(req.get("outDir") or os.path.dirname(os.path.abspath(source)))
    os.makedirs(out_dir, exist_ok=True)
    started = time.time()
    url = "file:///" + profile_dir("convert").replace("\\", "/")
    args = [soffice, "--headless", "--norestore", "--nologo", "--nolockcheck",
            "-env:UserInstallation=" + url,
            "--convert-to", target, "--outdir", out_dir, os.path.abspath(source)]
    proc = subprocess.run(args, capture_output=True, text=True, timeout=float(req.get("timeout") or 180),
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    stem = os.path.splitext(os.path.basename(source))[0]
    produced = []
    for name in os.listdir(out_dir):
        if name.startswith(stem) and os.path.isfile(os.path.join(out_dir, name)):
            produced.append(os.path.join(out_dir, name))
    ok = proc.returncode == 0 and produced
    return {
        "ok": bool(ok),
        "command": "convert",
        "source": os.path.abspath(source),
        "target": target,
        "files": produced,
        "bytes": [os.path.getsize(item) for item in produced],
        "stderr": (proc.stderr or "")[-800:],
        "totalSeconds": round(time.time() - started, 2),
    }


# ---------------------------------------------------------------- probe


def detect_version(soffice, timeout=15):
    """读 soffice 版本号。

    坑：soffice.exe 是 GUI 子系统程序，stdout 不接管道，直接 capture_output 会挂死
    （实测 60 秒超时）。同目录的 soffice.com 是控制台包装器，能正常吐 stdout，
    所以优先用它；两个都失败就返回 None，绝不阻塞探测。
    """
    program = os.path.dirname(soffice)
    for candidate in (os.path.join(program, "soffice.com"), soffice):
        if not os.path.isfile(candidate):
            continue
        try:
            proc = subprocess.run(
                [candidate, "--version"],
                capture_output=True,
                text=True,
                timeout=timeout,
                stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            for line in ((proc.stdout or "") + (proc.stderr or "")).splitlines():
                line = line.strip()
                if line and not line.startswith(("Could not find", "javaldx")):
                    return line
        except Exception:
            continue
    return None


def cmd_probe(req):
    soffice = find_soffice(req.get("soffice"))
    info = {
        "ok": bool(soffice),
        "command": "probe",
        "soffice": soffice,
        "python": sys.executable,
        "pythonVersion": sys.version.split()[0],
        "platform": sys.platform,
        "uno": False,
    }
    if soffice:
        info["programDir"] = os.path.dirname(soffice)
        bundled = os.path.join(os.path.dirname(soffice), "python.exe")
        info["bundledPython"] = bundled if os.path.isfile(bundled) else None
        info["version"] = detect_version(soffice) or "unknown"
    try:
        import uno  # noqa: F401

        info["uno"] = True
    except Exception as error:
        info["unoError"] = str(error)

    if info["uno"] and soffice and req.get("deep", True):
        started = time.time()
        try:
            with Session(soffice, 60) as session:
                doc = session.new_presentation()
                info["live"] = True
                info["livePages"] = doc.getDrawPages().getCount()
                try:
                    doc.close(True)
                except Exception:
                    pass
            info["connectSeconds"] = round(time.time() - started, 2)
        except Exception as error:
            info["live"] = False
            info["liveError"] = str(error)
    return info


# ---------------------------------------------------------------- main

COMMANDS = {
    "probe": cmd_probe,
    "build": cmd_build,
    "render": cmd_render,
    "convert": cmd_convert,
}


# ---------------------------------------------------------------- 常驻模式


_SERVE_SESSION = None


def _serve_session(req):
    """常驻模式共享的 Session：第一次用到才起 soffice。"""
    global _SERVE_SESSION
    if _SERVE_SESSION is None:
        session = Session(req.get("soffice"), float(req.get("timeout") or 120))
        session.__enter__()
        _SERVE_SESSION = session
    return _SERVE_SESSION


def _drop_serve_session():
    """丢掉常驻 Session。UNO 连接一旦出过错就不能再信它。"""
    global _SERVE_SESSION
    session, _SERVE_SESSION = _SERVE_SESSION, None
    if session is not None:
        try:
            session.__exit__(None, None, None)
        except Exception:
            pass


@contextlib.contextmanager
def session_scope(req):
    """常驻模式复用同一个 soffice；一次性模式照旧一次一进程。"""
    if not req.get("_serve"):
        with Session(req.get("soffice"), float(req.get("timeout") or 120)) as session:
            yield session
        return
    yield _serve_session(req)


atexit.register(_drop_serve_session)


def serve():
    """逐行读请求、逐行写响应，直到 stdin 关闭或收到 shutdown。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("请求必须是 JSON 对象")
            req_id = req.get("id")
            command = req.get("command") or "probe"
            if command == "shutdown":
                emit({"id": req_id, "ok": True, "shutdown": True})
                break
            handler = COMMANDS.get(command)
            if handler is None:
                raise ValueError(
                    "未知命令：%s（可用：%s）" % (command, ", ".join(COMMANDS))
                )
            req["_serve"] = True
            result = handler(req)
            if isinstance(result, dict):
                result["id"] = req_id
            emit(result)
        except Exception as error:
            # 出错后不信任这条 UNO 连接，下一轮重建
            _drop_serve_session()
            emit({
                "id": req_id,
                "ok": False,
                "error": "%s: %s" % (type(error).__name__, error),
                "trace": traceback.format_exc()[-2000:],
            })
    _drop_serve_session()


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return

    raw = sys.stdin.read()
    if not raw.strip():
        emit({"ok": False, "error": "stdin 为空：需要一段 JSON 请求"})
        return
    try:
        req = json.loads(raw)
    except Exception as error:
        emit({"ok": False, "error": "请求不是合法 JSON：%s" % error})
        return

    command = req.get("command") or "probe"
    handler = COMMANDS.get(command)
    if handler is None:
        emit({"ok": False, "error": "未知命令：%s（可用：%s）" % (command, ", ".join(COMMANDS))})
        return

    try:
        emit(handler(req))
    except Exception as error:
        emit({
            "ok": False,
            "command": command,
            "error": "%s: %s" % (type(error).__name__, error),
            "trace": traceback.format_exc()[-2000:],
        })


if __name__ == "__main__":
    main()
