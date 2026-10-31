"""OFD（GB/T 33190）解析与转换：文档信息 / 目录 / 文本，及版式级转 PDF（自研）。

OFD 是 ZIP + XML：OFD.xml → DocRoot(Document.xml) → Pages/Page@BaseLoc。
版式级转换（to_pdf）把 TextObject/PathObject/ImageObject 与模板按坐标映射到 PDF；
结构异常时回退文本重建（_to_pdf_text），任何解析失败都以带 note 的结果返回。
"""

from __future__ import annotations

import io
import math
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from .pdfops import OpError
from . import topdf


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _find_all(el, name: str) -> list:
    return [c for c in el.iter() if _local(c.tag) == name]


def _first(el, name: str):
    found = _find_all(el, name)
    return found[0] if found else None


def _norm(name: str) -> str:
    return posixpath.normpath(name.replace("\\", "/").lstrip("./"))


class OfdDoc:
    def __init__(self, path: Path):
        self.path = Path(path)
        try:
            self.zf = zipfile.ZipFile(str(self.path))
        except zipfile.BadZipFile as exc:
            raise OpError("不是有效的 OFD 文件（非 ZIP 结构）") from exc
        self.doc_root_file: str | None = None
        self.doc_info: dict = {}
        self.page_files: list[str] = []
        self.page_ids: dict[str, int] = {}
        self.bookmark_file: str | None = None
        self._parse_structure()

    def _parse_structure(self):
        names = set(self.zf.namelist())
        if "OFD.xml" not in names:
            raise OpError("缺少 OFD.xml，不是有效的 OFD 文档")
        root = ET.fromstring(self.zf.read("OFD.xml"))
        for el in root.iter():
            n = _local(el.tag)
            if n == "DocRoot" and el.text and el.text.strip():
                self.doc_root_file = _norm(el.text.strip())
            elif n in ("DocID", "Title", "Author", "Creator", "CreationDate", "ModDate") and el.text:
                self.doc_info.setdefault(n, el.text.strip())
        if self.doc_root_file and self.doc_root_file in names:
            doc = ET.fromstring(self.zf.read(self.doc_root_file))
            base = posixpath.dirname(self.doc_root_file)
            for p in _find_all(doc, "Page"):
                loc = p.attrib.get("BaseLoc", "").strip()
                pid = p.attrib.get("ID", "")
                full = _norm(posixpath.join(base, loc)) if loc else ""
                if full and full not in names and full + ".xml" in names:
                    full = full + ".xml"
                self.page_files.append(full)
                if pid:
                    self.page_ids[pid] = len(self.page_files) - 1
        for n in names:
            low = n.lower()
            if "bookmark" in low and low.endswith(".xml"):
                self.bookmark_file = n
                break

    # ---- 对外结果 ----

    def info(self) -> dict:
        return {
            "pages": len(self.page_files),
            "doc": self.doc_info,
            "has_bookmark": self.bookmark_file is not None,
        }

    def outline(self) -> list[dict]:
        if not self.bookmark_file:
            return []
        try:
            root = ET.fromstring(self.zf.read(self.bookmark_file))
        except ET.ParseError:
            return []

        def walk(el) -> list[dict]:
            nodes = []
            for child in el:
                if _local(child.tag) == "Bookmark":
                    node = {"title": child.attrib.get("Title", "").strip() or "(无标题)", "page": None, "children": []}
                    point = _first(child, "Point")
                    if point is not None:
                        ref = point.attrib.get("PageRef", "")
                        if ref in self.page_ids:
                            node["page"] = self.page_ids[ref] + 1
                    node["children"] = walk(child)
                    nodes.append(node)
            return nodes

        return walk(root)

    def text_pages(self) -> list[str]:
        out: list[str] = []
        for pf in self.page_files:
            text = ""
            if pf and pf in set(self.zf.namelist()):
                try:
                    page_xml = ET.fromstring(self.zf.read(pf))
                    parts = [el.text or "" for el in _find_all(page_xml, "TextCode")]
                    text = "\n".join(p.strip() for p in parts if p and p.strip())
                except ET.ParseError:
                    text = ""
            out.append(text)
        return out

    def to_pdf(self, out: Path, progress=None, should_cancel=None) -> dict:
        """版式级 OFD→PDF（v0.2 自研）：按坐标绘制文字/矢量/图片与模板。
        返回 {"pages": N, "note": ...}；note 汇报未支持特性（电子签章等）。"""
        return _to_pdf_layout(self, out, progress=progress, should_cancel=should_cancel)

    def to_pdf_text_rebuild(self, out: Path) -> Path:
        """兜底：文本重建转 PDF（无版式，仅文字流）。"""
        pages = self.text_pages()
        if not any(pages):
            raise OpError("该 OFD 未解析到文本，无法文本重建为 PDF")
        title = self.doc_info.get("Title") or self.path.stem
        return topdf.pages_text_to_pdf(pages, out, title=title)


def info(path: Path) -> dict:
    doc = OfdDoc(path)
    result = doc.info()
    result["outline"] = doc.outline()
    result["note"] = "OFD 解析：支持信息/目录/文本/版式级转 PDF"
    return result


def text(path: Path) -> list[str]:
    return OfdDoc(path).text_pages()


def outline(path: Path) -> list[dict]:
    return OfdDoc(path).outline()


def to_pdf(path: Path, out: Path, progress=None, should_cancel=None) -> dict:
    return OfdDoc(path).to_pdf(out, progress=progress, should_cancel=should_cancel)


# ============================================================
# 版式级 OFD→PDF（自研实现，参考 easyofd 的解析思路）
# 坐标体系：OFD 毫米、原点左上；PDF 点、原点左下。K = mm→pt。
# ============================================================

_PT_PER_MM = 72.0 / 25.4

# 常见中文字体名 → Windows 字体文件（包内未嵌字体时按名映射）
_SYSTEM_FONT_MAP: list[tuple[tuple[str, ...], str]] = [
    (("仿宋", "fangsong", "fs"), "simfang.ttf"),
    (("楷体", "kaiti", "kt"), "simkai.ttf"),
    (("黑体", "heiti", "simhei"), "simhei.ttf"),
    (("微软雅黑", "雅黑", "yahei", "hiragino", "pingfang", "思源", "noto"), "msyh.ttc"),
    (("小标宋", "标宋", "biaosong"), "simsun.ttc"),  # 方正小标宋 → 宋体兜底
    (("宋体", "songti", "simsun", "song"), "simsun.ttc"),
    # 西文内嵌字体常为 OTF/CFF（reportlab 无法嵌入），按名映射系统字体
    (("helvetica", "arial", "segoe", "sans"), "arial.ttf"),
    (("times", "georgia", "serif"), "times.ttf"),
    (("courier", "mono", "consola"), "consola.ttf"),
]
_FALLBACK_FONT = "STSong-Light"  # reportlab 内置 CID 字体，无需文件

_FONT_WINDOW_DIRS = ("C:/Windows/Fonts",)


def _f(value, default: float = 0.0) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def _parse_ctm(text: str | None) -> tuple | None:
    """'a b c d e f' → (a,b,c,d,e,f)；无/不合法返回 None。"""
    if not text:
        return None
    parts = str(text).split()
    if len(parts) != 6:
        return None
    try:
        return tuple(float(p) for p in parts)
    except ValueError:
        return None


def _parse_color(el, drawparams: dict, kind: str):
    """取对象或其 DrawParam 的 FillColor/StrokeColor → (r,g,b) 0-1。"""
    node = None
    for child in el:
        if _local(child.tag) == kind:
            node = child
            break
    value = None
    if node is not None:
        value = node.attrib.get("Value", "")
    elif el.attrib.get("DrawParam") and drawparams.get(el.attrib["DrawParam"], {}).get(kind.lower()):
        value = drawparams[el.attrib["DrawParam"]][kind.lower()]
    if not value:
        return None
    parts = [p for p in str(value).split() if p]
    nums: list[float] = []
    for p in parts:
        p = p.lstrip("#")
        try:
            nums.append(float(int(p, 16)) if re.fullmatch(r"[0-9a-fA-F]{1,2}", p) else float(p))
        except ValueError:
            nums.append(0.0)
    if len(nums) >= 3:
        # 样张常见 '#ee #20 #25'（十六进制 0-255）与 '156 82 35'（十进制 0-255）
        hi = max(nums[:3])
        scale = 1.0 / 255.0 if hi > 1.5 else 1.0
        return tuple(v * scale for v in nums[:3])
    if len(nums) == 1:  # 灰度
        v = nums[0] / 255.0 if nums[0] > 1.5 else nums[0]
        return (v, v, v)
    if len(nums) == 4:  # CMYK 近似转 RGB（忽略真实 ColorSpace 细节）
        c, m, y, k = (v / 255.0 if v > 1.5 else v for v in nums)
        return ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    return None


def _res_base(res_el, doc_base: str) -> str:
    loc = res_el.attrib.get("BaseLoc", "").strip()
    return _norm(posixpath.join(doc_base, loc)) if loc else doc_base


def _parse_res(zf: zipfile.ZipFile, res_file: str, fonts: dict, images: dict, drawparams: dict) -> None:
    """解析一个 Res XML：字体 / 多媒体（图片）/ 绘图参数。"""
    names = set(zf.namelist())
    if res_file not in names:
        return
    try:
        root = ET.fromstring(zf.read(res_file))
    except ET.ParseError:
        return
    doc_base = posixpath.dirname(res_file)
    base = _res_base(root, doc_base)

    for font in _find_all(root, "Font"):
        fid = font.attrib.get("ID", "")
        if not fid:
            continue
        entry = {"name": font.attrib.get("FontName", ""), "file": None}
        for child in font:
            if _local(child.tag) == "FontFile" and child.text:
                entry["file"] = _norm(posixpath.join(base, child.text.strip()))
        fonts[fid] = entry

    for media in _find_all(root, "MultiMedia"):
        mid = media.attrib.get("ID", "")
        if not mid:
            continue
        for child in media:
            if _local(child.tag) == "MediaFile" and child.text:
                loc = _norm(posixpath.join(base, child.text.strip()))
                if loc in names:
                    images[mid] = loc

    for param in _find_all(root, "DrawParam"):
        pid = param.attrib.get("ID", "")
        if not pid:
            continue
        entry = {"linewidth": _f(param.attrib.get("LineWidth"), 0.35)}
        for child in param:
            n = _local(child.tag)
            if n in ("FillColor", "StrokeColor") and child.attrib.get("Value"):
                entry[n.lower()] = child.attrib.get("Value")
        drawparams[pid] = entry


def _object_ctm(el, parent_ctm) -> tuple | None:
    own = _parse_ctm(el.attrib.get("CTM"))
    if own is None:
        return parent_ctm
    if parent_ctm is None:
        return own
    a1, b1, c1, d1, e1, f1 = parent_ctm
    a2, b2, c2, d2, e2, f2 = own
    # 先 parent 后 own：组合矩阵 M = Mparent ∘ Mown
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def _collect_objects(el, out: list, ctm=None, notes: set | None = None) -> None:
    """按文档顺序收集 TextObject/PathObject/ImageObject；Group/SubForm 递归并组合 CTM。"""
    for child in el:
        tag = _local(child.tag)
        if tag == "TextObject":
            out.append(("text", child, _object_ctm(child, ctm)))
        elif tag == "PathObject":
            out.append(("path", child, _object_ctm(child, ctm)))
        elif tag == "ImageObject":
            out.append(("image", child, _object_ctm(child, ctm)))
        elif tag in ("GroupObject", "SubForm", "FormObject", "Layer"):
            _collect_objects(child, out, _object_ctm(child, ctm), notes)
        elif tag == "Page":
            _collect_objects(child, out, ctm, notes)


def _page_objects(page_el, notes: set) -> list:
    """页面 → 绘制对象有序列表。Layer 排序：Background < 普通 < Foreground。"""
    layers = _find_all(page_el, "Layer")

    def rank(layer) -> int:
        t = (layer.attrib.get("Type") or "").strip().lower()
        return {"background": 0, "foreground": 2}.get(t, 1)

    objects: list = []
    for layer in sorted(layers, key=rank):
        _collect_objects(layer, objects, None, notes)
    # 没有任何 Layer 的退化页面（对象直接挂在 Content 下）
    if not layers:
        content = _first(page_el, "Content")
        if content is not None:
            _collect_objects(content, objects, None, notes)
    return objects


def _register_font_file(file_name: str, reg_name: str) -> str | None:
    """注册 TTF/TTC；OTF(CFF) 等不支持时返回 None。"""
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except ImportError:
        return None
    try:
        if file_name.lower().endswith((".ttc", ".otc")):
            pdfmetrics.registerFont(TTFont(reg_name, file_name, subfontIndex=0))
        else:
            pdfmetrics.registerFont(TTFont(reg_name, file_name))
        return reg_name
    except Exception:
        return None


def _match_system_font(name: str) -> str | None:
    low = (name or "").lower()
    for keys, fname in _SYSTEM_FONT_MAP:
        if any(k in low for k in keys):
            for d in _FONT_WINDOW_DIRS:
                p = Path(d) / fname
                if p.exists():
                    return _register_font_file(str(p), f"zlofd-sys-{fname}")
    return None


class _FontBook:
    """FontID → reportlab 字体名。包内 FontFile 优先，其次系统字体映射，最后 STSong-Light。"""

    def __init__(self, fonts: dict, zf: zipfile.ZipFile):
        self._map: dict[str, str] = {}
        self._extracted: dict[str, str] = {}
        self._zf = zf
        self._fonts = fonts
        self._counter = 0

    def get(self, font_id) -> str:
        fid = str(font_id or "")
        if fid in self._map:
            return self._map[fid]
        entry = self._fonts.get(fid, {})
        rl_name = None
        file_name = entry.get("file")
        if file_name and file_name in set(self._zf.namelist()):
            local = self._extracted.get(file_name)
            if not local:
                import tempfile

                fd, tmp = tempfile.mkstemp(prefix="zlofd-font-", suffix=Path(file_name).suffix or ".ttf")
                import os as _os

                with _os.fdopen(fd, "wb") as fh:
                    fh.write(self._zf.read(file_name))
                local = tmp
                self._extracted[file_name] = local
            rl_name = _register_font_file(local, f"zlofd-f{self._counter}")
            if rl_name:
                self._counter += 1
        if rl_name is None:
            rl_name = _match_system_font(entry.get("name", ""))
        if rl_name is None:
            rl_name = _FALLBACK_FONT
        self._map[fid] = rl_name
        return rl_name


def _delta_positions(spec: str, first: float, length: int) -> list[float] | None:
    """解析 DeltaX/DeltaY → 每字符累计位置（对齐 ofdrw DeltaTool 语义）：
    'g count delta' 展开为 count 个相同偏移；条目短于字数时以最后一个值延续补齐。
    无偏移返回 None（按自然字距整串绘制）。"""
    tokens = [t for t in str(spec or "").split() if t]
    if not tokens:
        return None
    deltas: list[float] = []
    i = 0
    n = len(tokens)
    try:
        while i < n:
            t = tokens[i]
            if t == "g" and i + 2 < n:  # g count delta
                count = int(float(tokens[i + 1]))
                delta = float(tokens[i + 2])
                deltas.extend([delta] * max(0, count))
                i += 3
            else:
                deltas.append(float(t))
                i += 1
    except ValueError:
        return None
    if not deltas:
        return None
    if len(deltas) < length:
        deltas.extend([deltas[-1]] * (length - len(deltas)))
    positions = [first]
    cur = first
    for d in deltas[: max(0, length - 1)]:
        cur += d
        positions.append(cur)
    return positions


def _apply_ctm_point(ctm, x: float, y: float) -> tuple[float, float]:
    if ctm is None:
        return x, y
    a, b, c, d, e, f = ctm
    return (a * x + c * y + e, b * x + d * y + f)


def _object_matrix(el, ctm) -> tuple:
    """对象放置矩阵（页内毫米、y 向下），语义对齐 ofdrw 权威实现：
    page = Boundary 原点 + CTM·local。即 CTM（含其 e/f 平移）作用于局部坐标后，
    再平移到 Boundary 原点；无 CTM 时平移即 Boundary 原点。"""
    parts = el.attrib.get("Boundary", "").split()
    bx, by = (_f(parts[0]), _f(parts[1])) if len(parts) >= 2 else (0.0, 0.0)
    if ctm is None:
        return (1.0, 0.0, 0.0, 1.0, bx, by)
    a, b, c, d, e, f = ctm
    return (a, b, c, d, e + bx, f + by)


def _matrix_scale(m: tuple) -> float:
    a, b, c, d, _, _ = m
    return math.sqrt(abs(a * d - b * c)) or 1.0


def _matrix_rotation(m) -> float:
    """矩阵旋转角（度，OFD y-down 体系；转 PDF 时取负）。"""
    a, b, _, _, _, _ = m
    if abs(b) < 1e-9:
        return 0.0
    return math.degrees(math.atan2(b, a))


# ---- 路径指令（AbbreviatedData）：S/M 起始、L 直线、C 六参贝塞尔或零参闭合、B 贝塞尔、Q 二次 ----

def _draw_path(c, el, drawparams: dict, page_h: float, ctm, K: float) -> None:
    data_el = None
    for child in el:
        if _local(child.tag) == "AbbreviatedData":
            data_el = child
            break
    data = (data_el.text if data_el is not None else "") or ""
    tokens = data.replace(",", " ").split()
    if not tokens:
        return

    matrix = _object_matrix(el, ctm)

    fill_color = _parse_color(el, drawparams, "FillColor")
    stroke_color = _parse_color(el, drawparams, "StrokeColor")
    fill_flag = el.attrib.get("Fill", "").lower() == "true" or (el.attrib.get("Fill") == "" and fill_color is not None)
    stroke_flag = el.attrib.get("Stroke", "").lower() == "true" or (el.attrib.get("Stroke") == "" and (stroke_color is not None or "LineWidth" in el.attrib))
    param = drawparams.get(el.attrib.get("DrawParam", ""), {})
    line_width = _f(el.attrib.get("LineWidth"), _f(param.get("linewidth"), 0.35)) * K * _matrix_scale(matrix)

    if not fill_flag and not stroke_flag:
        fill_flag, stroke_flag = fill_color is not None, True

    p = c.beginPath()
    cur = (0.0, 0.0)
    sub_start = (0.0, 0.0)

    def emit(x: float, y: float) -> tuple[float, float]:
        X, Y = _apply_ctm_point(matrix, x, y)
        return X * K, (page_h - Y) * K

    def pt(x: float, y: float, relative: bool) -> tuple[float, float]:
        if relative:
            x, y = cur[0] + x, cur[1] + y
        return (x, y)

    i, n = 0, len(tokens)
    started = False
    try:
        while i < n:
            tok = tokens[i]
            rel = tok.islower()
            cmd = tok.upper()
            i += 1

            def num(idx: int) -> float:
                return float(tokens[i + idx])

            if cmd in ("M", "S") and i + 1 < n:
                x, y = pt(num(0), num(1), rel)
                i += 2
                cur = (x, y)
                sub_start = (x, y)
                X, Y = emit(x, y)
                p.moveTo(X, Y)
                started = True
            elif cmd == "L" and i + 1 < n:
                x, y = pt(num(0), num(1), rel)
                i += 2
                cur = (x, y)
                X, Y = emit(x, y)
                if not started:
                    p.moveTo(X, Y)
                    started = True
                else:
                    p.lineTo(X, Y)
            elif cmd in ("C", "B") and i + 5 < n:
                x1, y1 = pt(num(0), num(1), rel)
                x2, y2 = pt(num(2), num(3), rel)
                x3, y3 = pt(num(4), num(5), rel)
                i += 6
                cur = (x3, y3)
                pts = [emit(x1, y1), emit(x2, y2), emit(x3, y3)]
                if not started:
                    p.moveTo(*pts[0])
                    started = True
                p.curveTo(pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1])
            elif cmd == "Q" and i + 3 < n:  # 二次贝塞尔 → 三次近似
                x1, y1 = pt(num(0), num(1), rel)
                x2, y2 = pt(num(2), num(3), rel)
                i += 4
                cx1, cy1 = emit(x1, y1)
                cx2, cy2 = emit(x2, y2)
                cx0, cy0 = emit(cur[0], cur[1])
                p.curveTo(cx0 + (cx1 - cx0) * 2 / 3, cy0 + (cy1 - cy0) * 2 / 3,
                          cx2 + (cx1 - cx2) * 2 / 3, cy2 + (cy1 - cy2) * 2 / 3, cx2, cy2)
                cur = (x2, y2)
            elif cmd == "C":  # 零参 C = 闭合子路径；当前点回到子路径起点
                if started:
                    p.close()
                started = False
                cur = sub_start
            else:
                # 未知指令或参数不足：跳过该指令与其后的数字
                while i < n and re.fullmatch(r"[+-]?\d*\.?\d+(e[+-]?\d+)?", tokens[i], re.IGNORECASE):
                    i += 1
    except (ValueError, IndexError):
        pass

    if fill_flag and fill_color:
        c.setFillColorRGB(*fill_color)
    if stroke_flag:
        c.setStrokeColorRGB(*(stroke_color or (0, 0, 0)))
        c.setLineWidth(max(0.1, line_width))
    # reportlab：FILL_EVEN_ODD=0，FILL_NON_ZERO=1
    fill_mode = 0 if el.attrib.get("Rule") == "even-odd" else 1
    try:
        c.drawPath(p, stroke=stroke_flag, fill=fill_flag, fillMode=fill_mode)
    except Exception:
        pass


def _draw_text(c, el, fontbook: _FontBook, drawparams: dict, page_h: float, ctm, K: float, notes: set) -> None:
    font_id = el.attrib.get("Font", "")
    size = _f(el.attrib.get("Size"), 4.0)
    if size <= 0:
        return
    matrix = _object_matrix(el, ctm)
    scale = _matrix_scale(matrix)
    rl_font = fontbook.get(font_id)
    fill_color = _parse_color(el, drawparams, "FillColor") or (0, 0, 0)
    stroke_color = _parse_color(el, drawparams, "StrokeColor")
    fill_flag = el.attrib.get("Fill", "true").lower() != "false"
    hscale = _f(el.attrib.get("HScale"), 1.0) or 1.0
    weight = int(_f(el.attrib.get("Weight"), 400))
    char_direction = _f(el.attrib.get("CharDirection"), 0)
    if abs(char_direction) > 0.5:
        notes.add("竖排文字按横排近似")

    size_pt = size * scale * K
    if size_pt <= 0.2:
        return
    rot = _matrix_rotation(matrix)

    c.setFillColorRGB(*fill_color)
    c.setStrokeColorRGB(*(stroke_color or fill_color))
    fake_bold = fill_flag and weight >= 700
    if fake_bold:
        c.setLineWidth(max(0.15, size_pt * 0.018))

    for tc in el:
        if _local(tc.tag) != "TextCode":
            continue
        text = _clean_text(tc.text or "")
        if not text:
            continue
        x0 = _f(tc.attrib.get("X"))
        y0 = _f(tc.attrib.get("Y"))
        xs = _delta_positions(tc.attrib.get("DeltaX", ""), x0, len(text))
        ys = _delta_positions(tc.attrib.get("DeltaY", ""), y0, len(text))

        def place(lx: float, ly: float) -> tuple[float, float]:
            X, Y = _apply_ctm_point(matrix, lx, ly)
            return X * K, (page_h - Y) * K

        if xs is None and ys is None:
            # 无逐字偏移：整串按自然字距绘制（保持复制/检索语义）
            px, py = place(x0, y0)
            c.saveState()
            try:
                c.translate(px, py)
                if rot:
                    c.rotate(-rot)
                if hscale != 1.0:
                    c.scale(hscale, 1.0)
                c.setFont(rl_font, size_pt)
                c.drawString(0, 0, text, mode=2 if fake_bold else 0)
            finally:
                c.restoreState()
            continue

        chars = list(text)
        for idx, ch in enumerate(chars):
            gx = xs[idx] if xs and idx < len(xs) else x0
            gy = ys[idx] if ys and idx < len(ys) else y0
            px, py = place(gx, gy)
            c.saveState()
            try:
                c.translate(px, py)
                if rot:
                    c.rotate(-rot)
                if hscale != 1.0:
                    c.scale(hscale, 1.0)
                c.setFont(rl_font, size_pt)
                c.drawString(0, 0, ch, mode=2 if fake_bold else 0)
            finally:
                c.restoreState()


def _clean_text(text: str) -> str:
    return text.replace("\x00", "").strip("\x0c")


def _draw_image(c, el, images: dict, zf: zipfile.ZipFile, page_h: float, ctm, K: float) -> None:
    rid = el.attrib.get("ResourceID", "")
    zip_name = images.get(rid)
    if not zip_name:
        return
    parts = el.attrib.get("Boundary", "0 0 0 0").split()
    if len(parts) < 4:
        return
    bw, bh = _f(parts[2]), _f(parts[3])
    if bw <= 0 or bh <= 0:
        return
    try:
        raw = zf.read(zip_name)
    except (KeyError, OSError):
        return

    matrix = _object_matrix(el, ctm)
    # 局部坐标：无 CTM 时图片直接占满 Boundary（毫米）；有 CTM 时为 0..1 单位方块
    # （由 CTM 缩放到毫米，如二维码 CTM="20 0 0 20 0 0" → 20×20mm）
    if ctm is not None:
        lw, lh = 1.0, 1.0
    else:
        lw, lh = bw, bh

    def corner(x: float, y: float):
        X, Y = _apply_ctm_point(matrix, x, y)
        return (X * K, (page_h - Y) * K)

    # 取变换后包围盒（平移/缩放精确；旋转 v1 近似为轴对齐）
    corners = [corner(0, 0), corner(lw, 0), corner(0, lh), corner(lw, lh)]
    xs = [p[0] for p in corners]
    ys = [p[1] for p in corners]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    if x1 - x0 < 0.1 or y1 - y0 < 0.1:
        return
    try:
        from reportlab.lib.utils import ImageReader

        c.drawImage(ImageReader(io.BytesIO(raw)), x0, y0, x1 - x0, y1 - y0, mask="auto")
    except Exception:
        pass


def _to_pdf_layout(doc: OfdDoc, out: Path, progress=None, should_cancel=None) -> dict:
    """版式级转换主流程：模板/资源/逐页对象绘制。"""
    try:
        from reportlab.pdfgen import canvas as rl_canvas
    except ImportError as exc:
        raise OpError("PDF 生成组件缺失（reportlab）") from exc

    zf = doc.zf
    names = set(zf.namelist())
    if not doc.doc_root_file:
        raise OpError("OFD 缺少 DocRoot，无法版式转换")
    doc_base = posixpath.dirname(doc.doc_root_file)
    document = ET.fromstring(zf.read(doc.doc_root_file))

    fonts: dict = {}
    images: dict = {}
    drawparams: dict = {}

    common = _first(document, "CommonData")
    page_size = [210.0, 297.0]
    template_files: list[str] = []
    if common is not None:
        area = _first(common, "PhysicalBox")
        if area is None:
            page_area = _first(common, "PageArea")
            if page_area is not None:
                area = _first(page_area, "PhysicalBox")
        if area is not None and area.text:
            parts = [_f(p) for p in area.text.split()]
            if len(parts) >= 4:
                page_size = parts[2:]
        for tag in ("PublicRes", "DocumentRes"):
            node = _first(common, tag)
            if node is not None and node.text:
                _parse_res(zf, _norm(posixpath.join(doc_base, node.text.strip())), fonts, images, drawparams)
        # 全局模板页（TemplatePage）与文档模板
        for tag in ("TemplatePage",):
            for tp in _find_all(common, tag):
                loc = tp.attrib.get("BaseLoc", "").strip()
                if loc:
                    template_files.append(_norm(posixpath.join(doc_base, loc)))
        for tpl in _find_all(document, "Template"):
            loc = tpl.attrib.get("BaseLoc", "").strip()
            if loc:
                template_files.append(_norm(posixpath.join(doc_base, loc)))

    fontbook = _FontBook(fonts, zf)
    notes: set = set()
    K = _PT_PER_MM

    def page_from_xml(file_name: str | None):
        if not file_name or file_name not in names:
            return None
        try:
            return ET.fromstring(zf.read(file_name))
        except ET.ParseError:
            return None

    template_objects: list = []
    for tf in template_files:
        tpl = page_from_xml(tf)
        if tpl is not None:
            objs = _page_objects(tpl, notes)
            template_objects.append(objs)

    c = rl_canvas.Canvas(str(out))
    total = len(doc.page_files) or 1
    for pg_no, pf in enumerate(doc.page_files):
        if should_cancel is not None and should_cancel():
            from .tasks import Cancelled

            raise Cancelled()
        page = page_from_xml(pf)
        # 每页尺寸：页 Area/PhysicalBox 覆盖公共值
        w, h = page_size
        if page is not None:
            area = _first(page, "PhysicalBox")
            if area is None:
                a = _first(page, "Area")
                if a is not None:
                    area = _first(a, "PhysicalBox")
            if area is not None and area.text:
                parts = [_f(p) for p in area.text.split()]
                if len(parts) >= 4 and parts[2] > 1 and parts[3] > 1:
                    w, h = parts[2], parts[3]
        c.setPageSize((w * K, h * K))

        objects: list = []
        for tobjs in template_objects:
            objects.extend(tobjs)
        if page is not None:
            objects.extend(_page_objects(page, notes))
        if page is not None:
            for child in page:  # 页面级资源（Res 引用以 BaseLoc 指向）
                if _local(child.tag) in ("Res", "PageRes") and child.attrib.get("BaseLoc"):
                    _parse_res(zf, _norm(posixpath.join(doc_base, child.attrib["BaseLoc"].strip())), fonts, images, drawparams)

        for kind, el, otm in objects:
            try:
                if kind == "text":
                    _draw_text(c, el, fontbook, drawparams, h, otm, K, notes)
                elif kind == "path":
                    _draw_path(c, el, drawparams, h, otm, K)
                elif kind == "image":
                    _draw_image(c, el, images, zf, h, otm, K)
            except Exception:
                continue  # 单个对象失败不中断整页
        c.showPage()
        if progress is not None:
            progress(0.9 * (pg_no + 1) / total, f"已转换 {pg_no + 1}/{total} 页")

    c.save()
    skipped = []
    if "竖排文字" in notes:
        skipped.append("竖排文字按横排近似")
    note = "版式级转换" + ("；" + "、".join(sorted(notes)) if notes else "")
    return {"pages": len(doc.page_files), "note": note}
