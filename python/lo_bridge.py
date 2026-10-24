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
import re
import shutil
import subprocess
import sys
import time
import traceback

# ---------------------------------------------------------------- 常量

# com.sun.star.drawing.FillStyle / LineStyle / TextVerticalAdjust / ParaAdjust
FILL_NONE, FILL_SOLID, FILL_GRADIENT = 0, 1, 2
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
    # ---- 高级版（lux）：走 layout_lux 渲染路径，中文衬线 + 大留白 + 克制用色 ----
    "atelier": {"bg": "#F7F4EE", "fg": "#17130F", "muted": "#8A8074", "accent": "#B0552F",
                "panel": "#EDE7DC", "accent2": "#1C3F38", "lux": True},
    "noir": {"bg": "#0C0C0E", "fg": "#F4F1EA", "muted": "#9A948A", "accent": "#C9A227",
             "panel": "#16161A", "accent2": "#2A2622", "lux": True},
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


def profile_root():
    base = os.path.join(
        os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or "/tmp",
        "dsh-lo-office",
    )
    os.makedirs(base, exist_ok=True)
    return base


def profile_dir(tag="main"):
    path = os.path.join(profile_root(), "profile-" + tag)
    os.makedirs(path, exist_ok=True)
    return path


def drop_profile(tag):
    """删掉某个 session 独占的 profile 目录。

    以前所有构建共用 profile-main，第二个构建进来会抢同一个配置目录和端口，
    表现为长时间等待后超时；改成每个 session 一个目录后必须自己回收，否则
    磁盘上会堆满残留目录。
    """
    for name in ("profile-" + tag, "profile-" + tag + "-alt"):
        shutil.rmtree(os.path.join(profile_root(), name), ignore_errors=True)


def sweep_profiles(max_age=3600):
    """回收被 kill / 崩溃留下的 profile 目录。

    只删够老的：正常构建不会占着一个 profile 一小时，所以活着的 session 不会被误删。
    """
    root = profile_root()
    cutoff = time.time() - max_age
    for name in os.listdir(root):
        if not name.startswith("profile-"):
            continue
        path = os.path.join(root, name)
        try:
            if os.path.getmtime(path) > cutoff:
                continue
        except OSError:
            continue
        shutil.rmtree(path, ignore_errors=True)


_SESSION_SEQ = [0]


def _next_seq():
    """给同一个进程里的多个 Session 发唯一编号，避免 profile 目录撞车。"""
    _SESSION_SEQ[0] += 1
    return _SESSION_SEQ[0]


# 非致命问题（比如缺图）攒在这里，随结果一起返回。以前这类问题直接 raise，
# 一张图没找到就整份 deck 失败，用户拿到的信息量等于零。
_WARN = []


def warn(message):
    text = str(message)
    if len(_WARN) < 200 and text not in _WARN:
        _WARN.append(text)


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
        # 每个 session 独占一个 profile：共用 profile-main 时两个构建会抢同一个
        # 配置目录和端口，表现为长时间等待后超时。tag 里带 pid 便于人工辨认。
        self.tag = "%d-%d" % (os.getpid(), _next_seq())
        self.timing = {}

    def __enter__(self):
        sweep_profiles()
        mark = time.time()
        self.proc = start_soffice(self.soffice, self.port, self.tag)
        self.timing["spawn"] = round(time.time() - mark, 2)
        mark = time.time()
        try:
            self.ctx = connect(self.port, self.timeout)
        except Exception:
            self._kill()
            # 配置目录可能被上一次残留进程占着，换个槽位再试一次
            self.port = random.randint(2900, 3200)
            self.proc = start_soffice(self.soffice, self.port, self.tag + "-alt")
            self.ctx = connect(self.port, self.timeout)
        self.timing["connect"] = round(time.time() - mark, 2)
        self.smgr = self.ctx.ServiceManager
        self.desktop = self.smgr.createInstanceWithContext(
            "com.sun.star.frame.Desktop", self.ctx
        )
        return self

    def __exit__(self, *_exc):
        self._kill()
        drop_profile(self.tag)
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
        # 先写 .tmp 再 os.replace：直接写目标路径时，中途崩溃/取消会留下
        # 一个看着像成品、实际截断的 0 字节文件，下游照样当成功处理。
        target = os.path.abspath(path)
        tmp = target + ".tmp"
        try:
            doc.storeToURL(uno.systemPathToFileUrl(tmp), tuple(props))
            os.replace(tmp, target)
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        return target


def pv(name, value):
    from com.sun.star.beans import PropertyValue

    item = PropertyValue()
    item.Name, item.Value = name, value
    return item


# ---------------------------------------------------------------- 绘图积木


def clear_page(page):
    while page.getCount() > 0:
        page.remove(page.getByIndex(0))


def add_rect(doc, page, x, y, w, h, fill, line=None, radius=0, transparency=0):
    from com.sun.star.awt import Point, Size

    shape = doc.createInstance("com.sun.star.drawing.RectangleShape")
    shape.setPosition(Point(int(x), int(y)))
    shape.setSize(Size(int(w), int(h)))
    shape.FillStyle = FILL_SOLID
    shape.FillColor = fill
    if transparency:
        try:
            shape.FillTransparence = int(max(0, min(100, transparency)))
        except Exception:
            pass
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


def _mix(a, b, t):
    """两色线性混合，t=0 取 a，t=1 取 b。"""
    t = max(0.0, min(1.0, float(t)))
    out = 0
    for shift in (16, 8, 0):
        ca = (a >> shift) & 255
        cb = (b >> shift) & 255
        out |= (int(ca * (1 - t) + cb * t) & 255) << shift
    return out


def add_grad(doc, page, x, y, w, h, start, end, angle=0, transparency=0):
    """渐变底色块（线性）。取不到渐变 API 时退化成纯色，不让整页构建失败。"""
    from com.sun.star.awt import Point, Size

    shape = doc.createInstance("com.sun.star.drawing.RectangleShape")
    shape.setPosition(Point(int(x), int(y)))
    shape.setSize(Size(int(w), int(h)))
    shape.LineStyle = LINE_NONE
    try:
        grad = shape.FillGradient
        grad.Style = 0                      # GradientStyle.LINEAR
        grad.StartColor = start
        grad.EndColor = end
        grad.Angle = int(angle * 100)       # 度 -> 1/100 度
        grad.StepCount = 64
        grad.Border = 0
        shape.FillGradient = grad
        shape.FillStyle = FILL_GRADIENT
        if transparency:
            shape.FillTransparence = int(max(0, min(100, transparency)))
    except Exception:
        shape.FillStyle = FILL_SOLID
        shape.FillColor = start
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

    # 下限不能大于上限：min_size > size 时二分区间反转，mid 会跑到 size 之上，
    # 于是「自动缩小」反而把 9pt 放大成 14pt，页面直接爆掉。
    if min_size > size:
        min_size = size

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
    kerning=0,
    hanging=0,
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
    if kerning:
        # 字距（1/100 pt）：小标签拉宽字距才有版式味
        try:
            cursor.CharKerning = int(kerning)
        except Exception:
            pass
    if hanging:
        # 悬挂缩进：换行后对齐到正文，不是对齐到项目符
        try:
            cursor.ParaLeftMargin = int(hanging)
            cursor.ParaFirstLineIndent = -int(hanging)
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
    # 垂直对齐必须放在最后一步：setString() 会重置它，末尾这次 setSize() 也会
    # 把它抹回 TOP。以前在 setString 之前设，statement / quote 的 anchor="center"
    # 一直静默失效（文字顶在框上方）；渲染实测确认「枚举赋值 + 最后一次 setSize
    # 之后设」才真正居中。
    try:
        shape.TextVerticalAdjust = ANCHOR.get(anchor, ANCHOR_TOP)
    except Exception:
        pass
    return shape


def _measure_height(shape, w):
    """量出这段文字在宽度 w 下需要的真实高度。

    和 _needed_height 的区别：这个函数不留下 TextAutoGrowHeight=True 的副作用，
    调用方拿到数字之后还能继续 setPosition / setSize 做垂直分配。
    """
    from com.sun.star.awt import Size

    try:
        shape.TextAutoGrowHeight = True
        shape.setSize(Size(int(w), 100))
        height = int(shape.Size.Height)
    except Exception:
        height = None
    try:
        shape.TextAutoGrowHeight = False
    except Exception:
        pass
    return height


# 垂直分配的眼校系数：内容块的上下留白按 0.46 : 0.54 分。
# 正中对齐（0.5）在纸面上看着像内容往下沉，压到 0.46 才「坐」得住。
BALANCE_BIAS = 0.46
# 内容块占正文带的理想比例。留太多空白是模板感，占满又是压迫感。
BAND_FILL = 0.72


def _distribute(shape, w, band_top, band_h, base_spacing, count,
                fill=BAND_FILL, max_grow=1.9, bias=BALANCE_BIAS):
    """把已经创建好的文字块在正文带里做垂直分配。

    两步，都靠 LibreOffice 自己量：
      1. 块太矮（要点少）就把段间距撑开，让块长到正文带的 fill 比例；
      2. 撑完之后把整块挪到略高于几何中心的位置。

    以前这两步都没有，块永远顶在带顶——两行要点的页面下半页会空掉一大半，
    这是「模板感」最刺眼的来源。
    """
    needed = _measure_height(shape, w)
    if not needed:
        return

    eff_spacing = int(base_spacing) if count > 1 else 0
    if base_spacing and count > 1:
        goal = int(band_h * fill)
        if needed < goal:
            extra = int((goal - needed) / count)
            extra = min(extra, int(base_spacing * (max_grow - 1)))
            if extra > 0:
                try:
                    cursor = shape.createTextCursor()
                    cursor.gotoStart(False)
                    cursor.gotoEnd(True)
                    cursor.ParaBottomMargin = int(base_spacing) + extra
                except Exception:
                    pass
                eff_spacing = int(base_spacing) + extra
                needed = _measure_height(shape, w) or needed

    # 量出来的高度含最后一段的段后距，这块留白在纸面上是看不见的。
    # 不减掉它，分配出来的块会整体偏高，看着像还压在标题下面。
    visual = max(1, int(needed) - eff_spacing)
    slack = int(band_h) - visual
    if slack <= 0:
        return
    from com.sun.star.awt import Point, Size

    try:
        shape.setPosition(Point(int(shape.Position.X), int(band_top) + int(slack * bias)))
        shape.setSize(Size(int(w), int(band_h)))
    except Exception:
        pass


def add_text_balanced(doc, page, x, band_top, w, band_h, text, spacing=0, **kw):
    """在 [band_top, band_top + band_h] 这条带里排版，而不是永远顶对齐。"""
    shape = add_text(doc, page, x, band_top, w, band_h, text, spacing=spacing, **kw)
    if (text or "").strip():
        count = len([line for line in str(text).split("\n") if line.strip()]) or 1
        _distribute(shape, w, band_top, band_h, spacing, count)
    return shape


def _placeholder_image(doc, page, x, y, w, h, path=""):
    """缺图占位：灰底 + 描边 + 文件名。

    缺一张图不该毁掉整份 deck——以前这里直接 raise，一张图路径写错，19 页里
    其余 18 页也一起没了。现在画个占位框，把问题写进 warnings 返回给调用方。
    """
    shape = add_rect(doc, page, x, y, w, h, 0xE5E7EB, line=0x9CA3AF, radius=60)
    name = os.path.basename(str(path or "")) or "（未提供路径）"
    add_text(
        doc, page, x, y, w, h, "缺图\n" + name,
        size=12, color=0x6B7280, align="center", anchor="center", fit=False,
    )
    return shape


def add_image(doc, session, page, x, y, w, h, path, cover=False):
    import uno

    if not path or not os.path.isfile(path):
        warn("图片不存在，已画占位框：%s" % (path or "（空路径）"))
        return _placeholder_image(doc, page, x, y, w, h, path)
    provider = session.smgr.createInstanceWithContext(
        "com.sun.star.graphic.GraphicProvider", session.ctx
    )
    graphic = provider.queryGraphic((pv("URL", uno.systemPathToFileUrl(os.path.abspath(path))),))
    shape = doc.createInstance("com.sun.star.drawing.GraphicObjectShape")
    shape.Graphic = graphic
    page.add(shape)
    from com.sun.star.awt import Point, Size

    natural = graphic.getSize()
    nw, nh = natural.Width, natural.Height

    # cover：铺满框后按比例裁掉溢出部分（满幅出血图必须裁，否则会盖住正文）
    if cover and nw > 0 and nh > 0 and w > 0 and h > 0:
        try:
            # GraphicCrop 是 com.sun.star.text.GraphicCrop（STRUCT，四个边各一个
            # 裁切量），单位 1/100 mm，基准是图片的物理自然尺寸 Size100thMM。
            # 曾经写成 RectanglePoint（那是 ENUM，createUnoStruct 必失败）并套用
            # 「1/1000 百分比、满值 100000」的换算，结果要么整张裁空、要么完全没裁，
            # 而且是静默失败——满幅出血图退化成信箱状，一路发到线上都没人发现。
            phys = graphic.getPropertyValue("Size100thMM")
            pw, ph = int(phys.Width), int(phys.Height)
            if pw <= 0 or ph <= 0:  # 极端情况按 96 DPI 兜底
                pw, ph = int(nw * 26.4583), int(nh * 26.4583)
            box_ratio = float(w) / float(h)
            img_ratio = float(pw) / float(ph)
            left = top = 0
            if img_ratio > box_ratio:
                left = int((1.0 - box_ratio / img_ratio) * pw / 2)
            elif img_ratio < box_ratio:
                top = int((1.0 - img_ratio / box_ratio) * ph / 2)
            crop = uno.createUnoStruct("com.sun.star.text.GraphicCrop")
            crop.Left = crop.Right = left
            crop.Top = crop.Bottom = top
            shape.GraphicCrop = crop
            shape.setPosition(Point(int(x), int(y)))
            shape.setSize(Size(int(w), int(h)))
            return shape
        except Exception as exc:
            # 裁切挂了不能让整页崩，但也不许装作没事：退回等比缩放并记账
            warn("cover 裁切失败，该图已退回等比缩放居中：%s" % exc)

    # 等比缩放后居中放进 (x,y,w,h) 的框里
    if nw > 0 and nh > 0:
        scale = min(float(w) / nw, float(h) / nh)
        tw, th = int(nw * scale), int(nh * scale)
    else:
        tw, th = int(w), int(h)
    ox, oy = int(x + (w - tw) / 2), int(y + (h - th) / 2)

    shape.setPosition(Point(ox, oy))
    shape.setSize(Size(tw, th))
    return shape


def add_table(doc, page, x, y, w, h, rows, size=14, font="Microsoft YaHei",
              fg=0x111827, header_bg=None, header_fg=None, line=0xD1D5DB, panel=0xF9FAFB,
              pad=280, bg=0xFFFFFF, borders="all"):
    from com.sun.star.awt import Point, Size

    shape = doc.createInstance("com.sun.star.drawing.TableShape")
    shape.setPosition(Point(int(x), int(y)))
    shape.setSize(Size(int(w), int(h)))
    page.add(shape)
    try:
        # 新建表格默认带一层 LibreOffice 表格样式底色，不清掉会整片泛色
        shape.FillStyle = FILL_NONE
    except Exception:
        pass
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
                # 底色必须显式给每一格：不给就露出表格默认样式那层色
                cell.FillStyle = FILL_SOLID
                if is_head and header_bg is not None:
                    cell.FillColor = header_bg
                elif not is_head and panel is not None:
                    # 斑马纹的浅色必须跟着主题底色走：写死 0xFFFFFF 会让深色主题
                    # 出现"白底白字"的整行隐形
                    cell.FillColor = bg if r % 2 else panel
                else:
                    cell.FillColor = bg
            except Exception:
                pass
            # 四边先一律关掉，再只开需要的那几条，否则默认样式会漏出彩色格线
            want = ("TopBorder", "BottomBorder") if borders == "h" else (
                "TopBorder", "BottomBorder", "LeftBorder", "RightBorder")
            for attr in ("TopBorder", "BottomBorder", "LeftBorder", "RightBorder"):
                try:
                    border = cell.getPropertyValue(attr)
                    if attr in want and line is not None:
                        border.Color = line
                        border.LineWidth = 10
                        border.LineStyle = LINE_SOLID
                    else:
                        border.LineStyle = LINE_NONE
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


SERIF = "Noto Serif SC"
SANS = "Noto Sans SC"
LATIN = "Segoe UI Light"


def layout_lux(doc, session, page, slide, spec, palette, geom, index, total):
    """高级版渲染：大留白 / 中文衬线标题 / 巨号数字 / 发丝线 / 满幅出血图 / 字距标签。

    与原 5 套主题完全隔离——只有 palette["lux"] 为真时才走这里。
    """
    W, H = geom
    bg = hexcolor(palette["bg"])
    fg = hexcolor(palette["fg"])
    muted = hexcolor(palette["muted"])
    accent = hexcolor(palette["accent"])
    panel = hexcolor(palette["panel"])
    accent2 = hexcolor(palette.get("accent2") or palette["fg"])
    paper = 0xF7F4EE
    hair = _mix(bg, fg, 0.16)          # 发丝线：底色和文字色之间的一道极淡线

    layout = (slide.get("layout") or "bullets").strip()
    title = slide.get("title") or ""
    subtitle = slide.get("subtitle") or ""
    kicker = slide.get("kicker") or ""
    body = slide.get("text") or ""
    caption = slide.get("caption") or ""
    bullets = [str(x) for x in (slide.get("bullets") or []) if str(x).strip()]
    rows = [r for r in (slide.get("rows") or []) if r]
    image = slide.get("image")
    if isinstance(image, dict):
        image = image.get("src")

    MX = int(W * 0.065)
    MY = int(H * 0.10)
    CW = W - 2 * MX
    T = add_text

    def label(x, y, text, color=None, w=None):
        # 小标签：全大写 + 拉宽字距，这是版式味的主要来源
        T(doc, page, x, y, w or 6600, 620, text.upper(), size=10.5,
          color=color if color is not None else muted, font=LATIN, kerning=300, fit=False)

    def footer(color=None):
        if spec.get("footer"):
            T(doc, page, MX, H - MY + 420, CW - 1900, 600, spec["footer"], size=9,
              color=color if color is not None else muted, font=LATIN, kerning=70, fit=False)
        if spec.get("pageNumbers", True):
            T(doc, page, W - MX - 1900, H - MY + 420, 1900, 600,
              "%02d / %02d" % (index, total), size=9,
              color=color if color is not None else muted, font=LATIN,
              align="right", kerning=70, fit=False)

    clear_page(page)

    if layout == "cover":
        add_rect(doc, page, 0, 0, W, H, bg)
        add_rect(doc, page, int(W * 0.64), 0, W - int(W * 0.64), H, accent2)
        T(doc, page, int(W * 0.64) + 500, H - int(H * 0.43), W - int(W * 0.64) - 2700,
          int(H * 0.32), "%02d" % index, size=122,
          color=_mix(accent2, 0xFFFFFF, 0.16), font=SERIF, bold=True,
          align="right", anchor="bottom", fit=False)
        label(MX, MY + 150, kicker or "proposal", accent)
        add_rect(doc, page, MX, MY + 1000, 620, 12, accent)
        T(doc, page, MX, int(H * 0.25), int(W * 0.52), int(H * 0.36), title,
          size=54, color=fg, font=SERIF, bold=True)
        add_rect(doc, page, MX, int(H * 0.665), 1500, 10, hair)
        if subtitle:
            T(doc, page, MX, int(H * 0.695), int(W * 0.48), int(H * 0.16), subtitle,
              size=18, color=muted, font=SANS)
        footer()

    elif layout == "section":
        add_rect(doc, page, 0, 0, W, H, bg)
        add_rect(doc, page, 0, 0, int(W * 0.011), H, accent2)
        T(doc, page, MX, int(H * 0.26), 6000, int(H * 0.52), "%02d" % index, size=140,
          color=_mix(bg, fg, 0.14), font=SERIF, bold=True, fit=False)
        add_rect(doc, page, MX + 4400, int(H * 0.345), 10, int(H * 0.235), accent)
        T(doc, page, MX + 5100, int(H * 0.335), W - 2 * MX - 5100, int(H * 0.24), title,
          size=40, color=fg, font=SERIF, bold=True)
        if subtitle:
            T(doc, page, MX + 5100, int(H * 0.60), int(W * 0.44), int(H * 0.16), subtitle,
              size=14, color=muted, font=SANS)
        footer()

    elif layout == "editorial":
        add_rect(doc, page, 0, 0, W, H, bg)
        label(MX, MY - 560, kicker or "editorial", accent)
        # 左栏巨号数字是 editorial 的版式身份。以前这个分支和 bullets 共用同一段
        # 代码，承诺的巨号数字从来没画出来，两种版式长得一模一样。
        numeral_w = int(W * 0.235)
        # 数字框顶端对齐标题的视觉顶边：150 磅的字形在框里会往下沉约 90px，
        # 框仍从 H*0.30 起画的话，数字的视觉中心会明显低于右侧竖线。
        T(doc, page, MX, int(H * 0.245), numeral_w, int(H * 0.40), "%02d" % index,
          size=150, color=_mix(bg, fg, 0.20), font=SERIF, bold=True, fit=False)
        rule_x = MX + numeral_w + 380
        add_rect(doc, page, rule_x, int(H * 0.305), 6, int(H * 0.285), hair)
        col_x = rule_x + 1000
        col_w = W - MX - col_x
        T(doc, page, col_x, int(H * 0.275), col_w, int(H * 0.235), title,
          size=32, color=fg, font=SERIF, bold=True)
        top = int(H * 0.275) + int(H * 0.235)
        avail = H - top - MY - 700
        if bullets:
            add_text_balanced(doc, page, col_x, top, col_w, avail,
                              "\n".join("—  " + b for b in bullets),
                              size=17, color=fg, font=SANS, spacing=880, hanging=620)
        elif body:
            add_text_balanced(doc, page, col_x, top, col_w, avail, body,
                              size=17, color=fg, font=SANS)
        footer()

    elif layout == "bullets":
        add_rect(doc, page, 0, 0, W, H, bg)
        label(MX, MY - 560, kicker or "overview", accent)
        T(doc, page, MX, MY + 380, int(W * 0.80), int(H * 0.25), title,
          size=36, color=fg, font=SERIF, bold=True)
        add_rect(doc, page, MX, MY + int(H * 0.255), CW, 6, hair)
        top = MY + int(H * 0.255) + 820
        avail = H - top - MY - 450
        if bullets:
            add_text_balanced(doc, page, MX, top, CW, avail,
                              "\n".join("—  " + b for b in bullets),
                              size=17.5, color=fg, font=SANS, spacing=880, hanging=620)
        elif body:
            add_text_balanced(doc, page, MX, top, CW, avail, body,
                              size=18, color=fg, font=SANS)
        footer()

    elif layout == "table":
        add_rect(doc, page, 0, 0, W, H, bg)
        label(MX, MY - 560, kicker or "overview", accent)
        T(doc, page, MX, MY + 380, int(W * 0.80), int(H * 0.22), title,
          size=34, color=fg, font=SERIF, bold=True)
        top = MY + int(H * 0.275)
        add_rect(doc, page, MX, top, CW, 6, hair)
        if rows:
            add_table(doc, page, MX, top + 260, CW, H - top - 260 - MY - 500, rows,
                      size=12.5, font=SANS, fg=fg, bg=bg, header_bg=None, header_fg=accent2,
                      line=hair, panel=None, pad=200, borders="h")
        footer()

    elif layout == "kpi":
        add_rect(doc, page, 0, 0, W, H, bg)
        label(MX, MY - 560, kicker or "metrics", accent)
        T(doc, page, MX, MY + 380, int(W * 0.80), int(H * 0.20), title,
          size=34, color=fg, font=SERIF, bold=True)
        items = [r for r in rows if len(r) >= 2][:4]
        if not items:
            # rows 没填的时候，也认 bullets 里 "42%｜效率提升" 这种写法。
            # 这条路径以前根本没有：空 kpi 页会安静地只画一个标题，
            # 结果里 warnings 还是空的，用户只能看到一张近乎空白的页面。
            for item in bullets:
                parts = [p.strip() for p in re.split(r"[｜|]", item, maxsplit=1)]
                if len(parts) == 2 and parts[0] and parts[1]:
                    items.append(parts)
            items = items[:4]
        if not items:
            warn("kpi 版式没有可用数据：请在 rows 里给两列，或用 \"数值｜标签\" 形式的 bullets；本页只画了标题")
        n = max(1, len(items))
        col_w = CW // n
        # kpi 是"一屏就看完"的版式：数字得撑住版面，整组要在标题与页脚
        # 之间垂直居中。原来固定 top = H*0.44，条目少时下半页整片空着。
        num_h = int(H * 0.20)
        lab_h = int(H * 0.10)
        gap = int(H * 0.02)
        block_h = num_h + gap + lab_h
        band_top = MY + 380 + int(H * 0.20)
        band_h = H - band_top - MY - 300
        top = band_top + max(0, int((band_h - block_h) * BALANCE_BIAS))
        for i, item in enumerate(items):
            x = MX + i * col_w
            if i:
                add_rect(doc, page, x - 420, top, 6, block_h, hair)
            T(doc, page, x, top, col_w - 700, num_h, str(item[0]), size=72,
              color=accent2, font=SERIF, bold=True)
            T(doc, page, x, top + num_h + gap, col_w - 700, lab_h, str(item[1]),
              size=13, color=muted, font=SANS)
        footer()

    elif layout == "index":
        add_rect(doc, page, 0, 0, W, H, bg)
        label(MX, MY - 560, kicker or "contents", accent)
        T(doc, page, MX, MY + 380, int(W * 0.70), int(H * 0.20), title,
          size=34, color=fg, font=SERIF, bold=True)
        top = MY + int(H * 0.275)
        add_rect(doc, page, MX, top, CW, 6, hair)
        top += 820
        band = H - top - MY - 300
        row_h = min(int(band / max(1, len(bullets))), 2500)
        # 条目少时 row_h 被 2500 封顶，剩下的高度全堆在页脚上方。把这块
        # 富余按 BALANCE_BIAS 分给上下，目录页才不会看着像没排完。
        slack = band - row_h * max(1, len(bullets))
        if slack > 0:
            top += int(slack * BALANCE_BIAS)
        for i, item in enumerate(bullets):
            y = top + i * row_h
            T(doc, page, MX, y, 1500, 800, "%02d" % (i + 1), size=19, color=accent,
              font=SERIF, bold=True, fit=False)
            T(doc, page, MX + 1600, y - 60, CW - 1600, row_h - 240, item,
              size=18, color=fg, font=SANS)
        footer()

    elif layout == "hero":
        # 图是可选的：hero 的语义是「整页压一句主张」，配图只是背景的一种。
        # 以前这里无条件 add_image，没给图就会画出「缺图」灰框并报一条
        # 「图片不存在（空路径）」的警告 —— 用户明明没写图，却被提示图丢了。
        # 底色必须先铺：底色原先只在「没给图」的分支里出现，一给图整页就退回
        # 纯白，主题色全丢。而且步骤条的透明度语法在不同 LO 版本上未必可靠，
        # 少了底色兜底，整页就会白得刺眼。
        add_rect(doc, page, 0, 0, W, H, bg)
        if image:
            add_image(doc, session, page, 0, 0, W, H, image, cover=True)
        else:
            add_grad(doc, page, 0, 0, W, H, _mix(bg, accent, 0.55), 0x0A0A0C, angle=90)
        # 蒙层用 24 条细带叠出来：层数少了（3 层）会出现肉眼可见的横向色带
        steps = 24
        band = max(1, int(H * 0.62 / steps))
        for i in range(steps):
            top = H - band * (steps - i)
            tr = int(94 - 88 * (i / float(steps - 1)))
            add_rect(doc, page, 0, top, W, band + 2, 0x0A0A0C, transparency=tr)
        label(MX, H - int(H * 0.36), kicker or "feature", accent)
        T(doc, page, MX, H - int(H * 0.33), int(W * 0.60), int(H * 0.17), title,
          size=44, color=paper, font=SERIF, bold=True)
        if subtitle:
            # 副标题的框原来给到 H*0.09 高、落在 0.895H，底沿压到 0.985H，
            # 正压在页脚（0.90H + 420）上：只要写了副标题，字就和页码叠在一起。
            # 收到页脚之上，并留出 400 单位的呼吸位。
            T(doc, page, MX, H - int(H * 0.115), int(W * 0.55), 650, subtitle,
              size=15, color=0xD6CFC2, font=SANS)
        footer(0xCFC8BC)

    elif layout in ("image", "image-left", "image-right"):
        side = "right" if layout == "image-right" else "left"
        if layout == "image":
            add_rect(doc, page, 0, 0, W, H, bg)
            label(MX, MY - 560, kicker or "figure", accent)
            T(doc, page, MX, MY + 380, int(W * 0.74), int(H * 0.19), title,
              size=32, color=fg, font=SERIF, bold=True)
            top = MY + int(H * 0.245)
            add_image(doc, session, page, MX, top, CW, H - top - MY - 700, image)
            if caption:
                T(doc, page, MX, H - MY - 420, CW, 500, caption, size=9.5,
                  color=muted, font=LATIN, kerning=140, fit=False)
        else:
            # 单侧满幅图的版式同样要铺主题底色：图片只占一半宽度，
            # 另一半不铺就是纯白，和整份 deck 的底色断开。
            add_rect(doc, page, 0, 0, W, H, bg)
            half = int(W * 0.46)
            if side == "left":
                add_image(doc, session, page, 0, 0, half, H, image, cover=True)
                tx = half + int(W * 0.048)
                tw = W - tx - MX
            else:
                add_image(doc, session, page, W - half, 0, half, H, image, cover=True)
                tx = MX
                tw = W - half - int(W * 0.048) - MX
            label(tx, int(H * 0.235), kicker or "detail", accent)
            T(doc, page, tx, int(H * 0.275), tw, int(H * 0.22), title,
              size=34, color=fg, font=SERIF, bold=True)
            add_rect(doc, page, tx, int(H * 0.505), 1100, 8, accent)
            if bullets:
                T(doc, page, tx, int(H * 0.555), tw, int(H * 0.34),
                  "\n".join("—  " + b for b in bullets), size=13.5, color=fg,
                  font=SANS, spacing=760, hanging=460)
            elif body:
                T(doc, page, tx, int(H * 0.555), tw, int(H * 0.34), body,
                  size=14.5, color=fg, font=SANS)
        footer()

    elif layout == "quote":
        add_rect(doc, page, 0, 0, W, H, bg)
        T(doc, page, MX - 200, int(H * 0.17), 4000, 3600, "\u201c", size=130,
          color=_mix(bg, accent, 0.5), font=SERIF, bold=True, fit=False)
        T(doc, page, MX, int(H * 0.355), int(W * 0.78), int(H * 0.30), body or title,
          size=32, color=fg, font=SERIF, bold=True)
        add_rect(doc, page, MX, int(H * 0.705), 1000, 8, accent)
        if subtitle:
            T(doc, page, MX, int(H * 0.745), int(W * 0.60), 700, subtitle, size=11,
              color=muted, font=LATIN, kerning=280)
        footer()

    elif layout == "statement":
        add_rect(doc, page, 0, 0, W, H, bg)
        label(MX, MY - 560, kicker or "principle", accent)
        T(doc, page, MX, int(H * 0.30), int(W * 0.84), int(H * 0.34), body or title,
          size=38, color=fg, font=SERIF, bold=True)
        add_rect(doc, page, MX, int(H * 0.715), 1300, 10, accent)
        if subtitle:
            T(doc, page, MX, int(H * 0.755), int(W * 0.60), 700, subtitle, size=11,
              color=muted, font=LATIN, kerning=280)
        footer()

    else:  # closing
        add_rect(doc, page, 0, 0, W, H, accent2)
        T(doc, page, MX, int(H * 0.34), CW, int(H * 0.22), title or "谢谢", size=50,
          color=paper, font=SERIF, bold=True, align="center")
        add_rect(doc, page, int(W / 2) - 400, int(H * 0.60), 800, 8, accent)
        if subtitle:
            T(doc, page, MX, int(H * 0.645), CW, 800, subtitle, size=13,
              color=_mix(accent2, 0xFFFFFF, 0.55), font=LATIN, align="center", kerning=240)
        footer(_mix(accent2, 0xFFFFFF, 0.42))

    set_notes(page, slide.get("notes"))
    transition = spec.get("transition")
    if transition:
        try:
            page.TransitionType = int(transition)
        except Exception:
            pass


def layout_slide(doc, session, page, slide, spec, palette, geom, index, total):
    W, H = geom
    M = int(min(W, H) * 0.075)          # 页边距
    font = spec.get("font") or "Microsoft YaHei"
    bg = hexcolor(palette["bg"])
    fg = hexcolor(palette["fg"])
    muted = hexcolor(palette["muted"])
    accent = hexcolor(palette["accent"])
    panel = hexcolor(palette["panel"])

    # 高级主题走独立渲染路径（layout_lux 自带铺底 / 页脚 / 备注 / 转场）
    if palette.get("lux"):
        layout_lux(doc, session, page, slide, spec, palette, geom, index, total)
        return

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

    # editorial / kpi / index / hero 只在 atelier / noir 的高级路径里实现。
    # 非高级主题会掉进最后的 bullets 分支，用户选了 hero 却拿到一个普通要点页——
    # 静默降级最容易被当成 bug，所以这里明说一句。
    if layout in ("editorial", "kpi", "index", "hero"):
        warn("版式 %s 只在 atelier / noir 主题下生效，当前主题已按 bullets 渲染" % layout)

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
        # 其它 9 个版式都显示 kicker，只有 statement 把它吞了——用户写了的字段
        # 不该凭空消失，位置上移一点让主文本仍然居中。
        if kicker:
            add_text(doc, page, M, int(H * 0.22), W - 2 * M, 900, kicker,
                     size=12, color=accent, bold=True, font=font, align="center")
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
        # subtitle 也算正文：只给 subtitle 的图文页以前会退化成「纯居中大图」，
        # 标题和副标题整块消失，用户看到的就是一张图加个孤零零的标题。
        has_text = bool(bullets or body or subtitle)
        # 图文页的底边不是页边距，是页脚上沿：subtitle / caption 必须排在这条线以上。
        # 以前 image 版式图底在 H-M-1400，而 subtitle 顶在 H-M-1900，直接叠进图里 500。
        footer_top = H - M - 900
        band_bottom = footer_top - 200
        cap_h, sub_h, gap_h = 800, 900, 150
        if layout == "image" or not has_text:
            add_text(doc, page, M, M, W - 2 * M, 1500, title, size=26, color=fg, bold=True, font=font)
            box_top = M + 2000
            # 底部按 subtitle / caption 的实际情况预留，图片只吃剩下的高度
            reserve = 0
            if subtitle:
                reserve += sub_h + gap_h
            if caption:
                reserve += cap_h + gap_h
            img_h = max(1200, band_bottom - reserve - box_top)
            add_image(doc, session, page, M, box_top, W - 2 * M, img_h, image)
            text_y = box_top + img_h + gap_h
            if subtitle:
                add_text(doc, page, M, text_y, W - 2 * M, sub_h, subtitle,
                         size=15, color=muted, font=font, align="center")
                text_y += sub_h + gap_h
            if caption:
                add_text(doc, page, M, text_y, W - 2 * M, cap_h, caption,
                         size=11, color=muted, font=font, align="center")
        else:
            gap = int(W * 0.04)
            text_w = int(W * 0.42)
            img_w = W - 2 * M - text_w - gap
            img_x = M if side == "left" else M + text_w + gap
            text_x = M + img_w + gap if side == "left" else M
            # 侧栏图同样得给 caption 腾位置：原来图底正好压在页脚线上，图注根本没处放，
            # 于是 image-left / image-right 的 caption 一直是静默丢弃的。
            img_h = H - 2 * M - 1800 - ((cap_h + gap_h) if caption else 0)
            add_image(doc, session, page, img_x, M + 900, img_w, img_h, image)
            if caption:
                add_text(doc, page, img_x, M + 900 + img_h + gap_h, img_w, cap_h, caption,
                         size=11, color=muted, font=font, align="center")
            add_text(doc, page, text_x, M, text_w, 1500, title, size=26, color=fg, bold=True, font=font)
            body_top = M + 2000
            if subtitle:
                add_text(doc, page, text_x, M + 1500, text_w, 700, subtitle,
                         size=13, color=muted, font=font)
                body_top = M + 2350
            if bullets:
                add_text(doc, page, text_x, body_top, text_w, H - body_top - M - 600,
                         "\n".join("\u2022  " + item for item in bullets),
                         size=16, color=fg, font=font, spacing=600)
            elif body:
                add_text(doc, page, text_x, body_top, text_w, H - body_top - M - 600, body,
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
        # 行宽不能给到整页宽：16:9 上一条长要点会拉成一百多字的超长行，
        # 换行位置全凭运气。按页宽 0.74 封顶，中文大约六十字一行。
        measure = min(W - 2 * M, int(W * 0.74))
        if bullets:
            add_text_balanced(doc, page, M, content_top, measure, content_h,
                              "\n".join("\u2022  " + item for item in bullets),
                              size=spec.get("bulletSize", 20), color=fg, font=font,
                              spacing=900)
        elif body:
            add_text_balanced(doc, page, M, content_top, measure, content_h, body,
                              size=spec.get("bulletSize", 20), color=fg, font=font)
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


def safe_base_name(name, fallback="deck"):
    """把用户给的文件名主干洗成单段合法文件名。

    `baseName = "../x/y"` 以前可以直接把文件写出 outDir 之外，等于给了个任意路径
    写入。这里只保留安全字符，并且不允许留下 `..` 片段。
    """
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(name or "")).strip()
    text = text.strip(". ").replace("..", "_")
    return text or fallback


def unique_base(out_dir, base, formats):
    """给「不覆盖」模式找一个没被占用的主干名。

    注意 PNG 是 `base-01.png` 这种带序号的名字，所以除了看 .pptx 之类的整文件，
    还要专门探一下首张 PNG，否则 `overwrite: false` 会悄悄盖掉旧的逐页图。
    """
    suffixes = {"odp": ".odp", "pptx": ".pptx", "pdf": ".pdf"}

    def taken(candidate):
        for name in formats:
            suffix = suffixes.get(name)
            if suffix and os.path.exists(os.path.join(out_dir, candidate + suffix)):
                return True
        # PNG 是 base-01.png 这种带序号的名字，只看整文件会漏掉
        return "png" in formats and os.path.exists(
            os.path.join(out_dir, "%s-01.png" % candidate)
        )

    if not taken(base):
        return base
    for index in range(2, 1000):
        candidate = "%s-%d" % (base, index)
        if not taken(candidate):
            return candidate
    return base


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
    base = safe_base_name(req.get("baseName"))
    formats = req.get("formats") or ["pptx"]
    png_width = req.get("pngWidth")
    # overwrite:false 以前是个哑参数——schema 里有，Python 侧根本没读，永远覆盖。
    if req.get("overwrite") is False:
        os.makedirs(out_dir, exist_ok=True)
        base = unique_base(out_dir, base, formats)

    _WARN[:] = []
    timings = {}
    started = time.time()
    files = {}

    with session_scope(req) as session:
        timings["connect"] = round(time.time() - started, 2)
        doc = session.new_presentation()
        # 冷启动 30s+ 里绝大部分花在拉 soffice 和 UNO 握手，单独打点才能判断
        # 该优化进程启动还是该复用常驻进程。
        timings["session"] = dict(getattr(session, "timing", {}))
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
        "baseName": base,
        "theme": theme,
        "ratio": spec.get("ratio") or "16:9",
        "autoFit": _FIT["mode"],
        "fitAdjusted": _FIT["hits"],
        "fitOverflow": _FIT.get("overflow", 0),
        "files": files,
        "bytes": sizes,
        "timings": timings,
        "warnings": list(_WARN),
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
    base = safe_base_name(
        req.get("baseName"), os.path.splitext(os.path.basename(source))[0] or "render"
    )
    formats = req.get("formats") or ["pdf"]
    png_width = req.get("pngWidth")
    _WARN[:] = []
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
        "baseName": base,
        "slideCount": count,
        "files": files,
        "bytes": sizes,
        "timings": timings,
        "warnings": list(_WARN),
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
    # 只认这次真正产出的文件：扩展名必须匹配目标格式，且 mtime 不早于本次开始。
    # 以前只判 name.startswith(stem)，会把目录里同名的旧文件（.pptx / -01.png）
    # 一起列进结果，看起来像"一次转出了三个文件"。
    want_ext = "." + str(target).split(":")[0].split("-")[0].lower()
    produced = []
    for name in sorted(os.listdir(out_dir)):
        path = os.path.join(out_dir, name)
        if not os.path.isfile(path):
            continue
        if os.path.splitext(name)[1].lower() != want_ext:
            continue
        if not name.startswith(stem):
            continue
        try:
            if os.path.getmtime(path) < started - 1:
                continue
        except OSError:
            continue
        produced.append(path)
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
        line = line.strip().lstrip("\ufeff")
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
    # Windows 上不少工具（记事本、PowerShell 管道）会带 BOM 写 UTF-8，
    # json.loads 见到 \ufeff 直接报错，这里先剥掉再解析。
    if raw[:1] == "\ufeff":
        raw = raw[1:]
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
