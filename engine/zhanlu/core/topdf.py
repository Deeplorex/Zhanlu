"""生成 PDF：TXT / Markdown / OFD 文本 → PDF；图片（多张）→ PDF。"""

from __future__ import annotations

import html
import re
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
)

_FONT: str | None = None
_FONT_MONO = "Courier"

_WIN_FONTS = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyh.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def cjk_font() -> str:
    global _FONT
    if _FONT:
        return _FONT
    for path in _WIN_FONTS:
        try:
            pdfmetrics.registerFont(TTFont("ZhanluCJK", path, subfontIndex=0))
            _FONT = "ZhanluCJK"
            return _FONT
        except Exception:  # noqa: BLE001
            continue
    try:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        _FONT = "STSong-Light"
    except Exception:  # noqa: BLE001
        _FONT = "Helvetica"
    return _FONT


def _doc(out: Path, title: str) -> SimpleDocTemplate:
    return SimpleDocTemplate(
        str(out), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=22 * mm, bottomMargin=20 * mm,
        title=title,
    )


def _styles() -> dict:
    f = cjk_font()
    def st(name: str, **kw) -> ParagraphStyle:
        base = dict(fontName=f, leading=19, wordWrap="CJK", spaceAfter=6)
        base.update(kw)
        return ParagraphStyle(name, **base)
    return {
        "h1": st("h1", fontSize=20, spaceBefore=6, spaceAfter=14),
        "h2": st("h2", fontSize=16, spaceBefore=12, spaceAfter=8),
        "h3": st("h3", fontSize=13.5, spaceBefore=10, spaceAfter=6),
        "body": st("body", fontSize=11),
        "li": st("li", fontSize=11, leftIndent=14),
        "code": ParagraphStyle("code", fontName=_FONT_MONO, fontSize=9, leading=12),
        "quote": st("quote", fontSize=11, leftIndent=12, textColor="#586673"),
    }


def _inline(text: str) -> str:
    t = html.escape(text)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<!\*)\*([^*\s][^*]*?)\*(?!\*)", r"<i>\1</i>", t)
    t = re.sub(r"`([^`]+)`", r"<font face='Courier'>\1</font>", t)
    return t


def txt_to_pdf(text: str, out: Path, title: str = "文档") -> Path:
    styles = _styles()
    story = [Paragraph(html.escape(title or "文档"), styles["h1"])]
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        story.append(Paragraph(_inline(para).replace("\n", "<br/>"), styles["body"]))
    _doc(out, title).build(story)
    return out


_MD_H = re.compile(r"^(#{1,6})\s+(.*)$")


def md_to_pdf(md_text: str, out: Path, title: str = "文档") -> Path:
    styles = _styles()
    story: list = [Paragraph(_inline(title or Path(out).stem), styles["h1"])]
    lines = md_text.splitlines()
    i = 0
    in_code = False
    code_buf: list[str] = []
    para_buf: list[str] = []

    def flush_para():
        if para_buf:
            story.append(Paragraph(_inline(" ".join(para_buf)), styles["body"]))
            para_buf.clear()

    while i < len(lines):
        line = lines[i].rstrip()
        if line.strip().startswith("```"):
            if in_code:
                story.append(Preformatted("\n".join(code_buf), styles["code"]))
                story.append(Spacer(1, 6))
                code_buf.clear()
                in_code = False
            else:
                flush_para()
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(line)
            i += 1
            continue
        s = line.strip()
        m = _MD_H.match(s)
        if m:
            flush_para()
            level = min(len(m.group(1)), 3)
            story.append(Paragraph(_inline(m.group(2)), styles[f"h{level}"]))
        elif not s:
            flush_para()
        elif re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", s):
            flush_para()
            story.append(Spacer(1, 4))
        elif re.match(r"^[-*+]\s+", s):
            flush_para()
            story.append(Paragraph("• " + _inline(re.sub(r"^[-*+]\s+", "", s)), styles["li"]))
        elif re.match(r"^\d+[.)]\s+", s):
            flush_para()
            num = re.match(r"^(\d+)[.)]\s+(.*)$", s)
            story.append(Paragraph(f"{num.group(1)}. " + _inline(num.group(2)), styles["li"]))
        elif s.startswith(">"):
            flush_para()
            story.append(Paragraph(_inline(s.lstrip("> ")), styles["quote"]))
        else:
            para_buf.append(s)
        i += 1
    if in_code and code_buf:
        story.append(Preformatted("\n".join(code_buf), styles["code"]))
    flush_para()
    _doc(out, title).build(story)
    return out


def pages_text_to_pdf(pages_text: list[str], out: Path, title: str = "文档") -> Path:
    """OFD → PDF 的文本重建（实验性）：每页文本一页。"""
    styles = _styles()
    story = [Paragraph(html.escape(title), styles["h1"])]
    for pi, text in enumerate(pages_text, 1):
        for para in re.split(r"\n\s*\n", (text or "").strip()):
            if para.strip():
                story.append(Paragraph(html.escape(para.strip()), styles["body"]))
        story.append(Paragraph(f"— {pi} —", styles["quote"]))
        if pi != len(pages_text):
            story.append(PageBreak())
    _doc(out, title).build(story)
    return out


def images_to_pdf(image_paths: list[Path], out: Path) -> Path:
    if not image_paths:
        raise ValueError("没有图片")
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        import img2pdf

        with open(out, "wb") as f:
            f.write(img2pdf.convert([str(p) for p in image_paths]))
        return out
    except ImportError:
        from PIL import Image

        imgs = [Image.open(p).convert("RGB") for p in image_paths]
        imgs[0].save(out, save_all=True, append_images=imgs[1:])
        for im in imgs:
            im.close()
        return out
