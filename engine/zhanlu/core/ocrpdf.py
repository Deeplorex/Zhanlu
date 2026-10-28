"""离线 OCR → 可搜索 PDF。

流程：pypdfium2 渲染页面（含页面旋转）→ RapidOCR(百度 PP-OCR 系列模型，ONNX)
识别 → reportlab 生成同尺寸「隐形文字层」（渲染模式 3，不可见但可选中/搜索/复制）
→ pikepdf 把文字层叠加回原页面。页面原图完全保留，输出为新文件。

模型策略（插件分层，均不内置安装包）：
- standard：PP-OCRv6 mobile/small（约 30 MB）——默认，快；
- advanced：PP-OCRv5 server（约 165 MB）——更准更慢，用户在设置里选择安装；
- 模型文件放在数据目录 plugins/ocr-models/（Global.model_root_dir 重定向），
  由用户确认后从 modelscope 下载；删除该目录即卸载。开发环境回退到
  site-packages 内 pip 安装时缓存的模型，便于开发。
"""

from __future__ import annotations

from pathlib import Path

from .. import config
from . import pdfops

try:
    from rapidocr import RapidOCR
    from rapidocr.utils.typings import ModelType, OCRVersion
    HAS_RAPIDOCR = True
except ImportError:  # 代码缺失时优雅降级
    RapidOCR = None
    HAS_RAPIDOCR = False

MIN_CONF = 0.55

# 档位定义：文件名特征 → 参数。标准与高级可并存，运行时按档位选引擎。
_CLS_MODEL = "ch_ppocr_mobile_v2.0_cls_mobile.onnx"
_TIER_FILES = {
    "standard": ("PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx", _CLS_MODEL),
    "advanced": ("ch_PP-OCRv5_det_server.onnx", "ch_PP-OCRv5_rec_server.onnx", _CLS_MODEL),
}
_TIER_PARAMS = {
    "standard": {},
    "advanced": {
        "Det.ocr_version": OCRVersion.PPOCRV5, "Det.model_type": ModelType.SERVER,
        "Rec.ocr_version": OCRVersion.PPOCRV5, "Rec.model_type": ModelType.SERVER,
    } if HAS_RAPIDOCR else {},
}
TIER_LABELS = {
    "standard": "标准 · PP-OCRv6（约 30 MB，快）",
    "advanced": "高级 · PP-OCRv5 server（约 165 MB，更准更慢）",
}

_engines: dict[str, object] = {}


def models_root() -> Path:
    return config.OCR_MODELS_DIR


def _tier_ready(tier: str) -> bool:
    files = _TIER_FILES.get(tier)
    if not files:
        return False
    root = models_root()
    return all((root / f).is_file() for f in files)


def _pkg_models_dir() -> Path | None:
    """开发环境：仅在 pip 包里完整模型已存在时回退，不触发隐式下载。"""
    if not HAS_RAPIDOCR:
        return None
    try:
        import rapidocr
        d = Path(rapidocr.__file__).parent / "models"
        return d if all((d / name).is_file() for name in _TIER_FILES["standard"]) else None
    except Exception:  # noqa: BLE001
        return None


def _pkg_models_ok() -> bool:
    return _pkg_models_dir() is not None


def plugin_status() -> dict:
    tiers = {t: _tier_ready(t) for t in _TIER_FILES}
    active = next((t for t in ("advanced", "standard") if tiers[t]), None)
    if active is None and _pkg_models_ok():
        active = "package"
    return {
        "dir": str(models_root()),
        "tiers": tiers,
        "tier_files": {t: list(fs) for t, fs in _TIER_FILES.items()},
        "labels": TIER_LABELS,
        "active": active,
        "available": active is not None,
        "source": "modelscope.cn/models/RapidAI/RapidOCR",
    }


def available() -> bool:
    return plugin_status()["available"]


def active_tier() -> str | None:
    return plugin_status()["active"]


def _get_engine(tier: str):
    eng = _engines.get(tier)
    if eng is None:
        root = _pkg_models_dir() if tier == "package" else models_root()
        if root is None:
            raise pdfops.OpError("离线 OCR 模型文件不完整，请到 设置 → 插件 安装。")
        params: dict = {"Global.model_root_dir": str(root)}
        params.update(_TIER_PARAMS.get(tier, {}))
        eng = RapidOCR(params=params)
        _engines[tier] = eng
    return eng


def engine_for_run(tier: str | None = None):
    """run_ocr 选择引擎：指定档位须已安装；否则高级优先、标准次之、开发包兜底。"""
    if not HAS_RAPIDOCR:
        raise pdfops.OpError("OCR 代码未随引擎提供（rapidocr 缺失）")
    if tier:
        if not _tier_ready(tier):
            raise pdfops.OpError(f"OCR {TIER_LABELS.get(tier, tier)} 未安装。请到 设置 → 插件 安装。")
        return _get_engine(tier)
    for t in ("advanced", "standard"):
        if _tier_ready(t):
            return _get_engine(t)
    if _pkg_models_ok():
        return _get_engine("package") if "package" not in _engines else _engines["package"]
    raise pdfops.OpError("离线 OCR 模型插件未安装。请到 设置 → 插件 安装。")


def install(tier: str, progress=None, should_cancel=None) -> dict:
    """用户确认后调用：把该档模型下载到 plugins/ocr-models/（modelscope 源）。

    rapidocr 在构造时会按需下载缺失模型；跑一张空白图触发全部模块下载完成。
    """
    from ..tasks import Cancelled

    if not HAS_RAPIDOCR:
        raise pdfops.OpError("OCR 代码未随引擎提供（rapidocr 缺失）")
    if tier not in _TIER_FILES:
        raise pdfops.OpError(f"未知 OCR 模型档位: {tier}")
    if progress:
        progress(0.1, f"准备下载 {TIER_LABELS[tier]}")
    config.ensure_dirs()
    models_root().mkdir(parents=True, exist_ok=True)
    if should_cancel and should_cancel():
        raise Cancelled()
    eng = _get_engine(tier)
    if progress:
        progress(0.35, "下载模型文件中（modelscope）…")
    # 触发三个模块（det/cls/rec）真正下载：空白图不会经过识别，必须给含文字的图
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (420, 120), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=44)
    except TypeError:  # 旧版 Pillow 无 size 参数
        font = ImageFont.load_default()
    draw.text((20, 30), "Zhanlu 2026 测试", font=font, fill=(20, 20, 20))
    img = img.rotate(180)  # 触发方向分类（cls）路径
    eng(np.asarray(img))
    if should_cancel and should_cancel():
        raise Cancelled()
    if not _tier_ready(tier):
        raise pdfops.OpError("模型文件不完整，请重试安装。")
    if progress:
        progress(1.0, f"{TIER_LABELS[tier]} 安装完成")
    return {"ok": True, "tier": tier, "dir": str(models_root())}


def uninstall(tier: str | None = None) -> dict:
    """删除模型目录（tier=None 时整目录清空）。"""
    import shutil
    import uuid as _uuid

    if not models_root().exists():
        return {"ok": True}
    if tier is None:
        shutil.rmtree(models_root(), ignore_errors=True)
    else:
        tmp = models_root().parent / f"_rm-{_uuid.uuid4().hex[:6]}"
        models_root().rename(tmp)
        shutil.rmtree(tmp, ignore_errors=True)
        models_root().mkdir(parents=True, exist_ok=True)
    _engines.clear()
    return {"ok": True}


def _img_to_user(x_img: float, y_img: float, *, scale: float, disp_h_px: float,
                 w_pt: float, h_pt: float, rot: int) -> tuple[float, float]:
    """图像像素 → 未旋转用户空间。disp_h_px 为（旋转后）图像高度像素。"""
    xd = x_img / scale                       # 展示坐标，y 向上
    yd = disp_h_px / scale - y_img / scale
    if rot == 90:
        return w_pt - yd, xd
    if rot == 180:
        return w_pt - xd, h_pt - yd
    if rot == 270:
        return yd, h_pt - xd
    return xd, yd


def _build_text_layer(items: list[dict], *, w_pt: float, h_pt: float, rot: int,
                      llx: float, lly: float, scale: float, disp_h_px: float) -> bytes:
    """一页的隐形文字层 PDF（与原页面同 MediaBox）。"""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen.canvas import Canvas

    try:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        font = "STSong-Light"
    except Exception:  # noqa: BLE001 — CID 注册失败时退化为 Helvetica（仅西文）
        font = "Helvetica"

    buf = __import__("io").BytesIO()
    canvas = Canvas(buf, pagesize=(w_pt, h_pt))
    text = canvas.beginText()
    text.setTextRenderMode(3)  # 隐形：不可见，可搜索可复制

    for item in items:
        line = item["text"]
        if not line.strip():
            continue
        xs = [float(p[0]) for p in item["box"]]
        ys = [float(p[1]) for p in item["box"]]
        corners = [_img_to_user(x, y, scale=scale, disp_h_px=disp_h_px,
                                w_pt=w_pt, h_pt=h_pt, rot=rot)
                   for x, y in ((min(xs), min(ys)), (min(xs), max(ys)),
                                (max(xs), min(ys)), (max(xs), max(ys)))]
        px = [c[0] for c in corners]
        py = [c[1] for c in corners]
        x0, y0 = min(px), min(py)
        box_w = max(px) - x0
        box_h = max(py) - y0
        size = max(4.0, min(box_h * 1.02, 200.0))
        n = max(1, len(line))
        char_w = box_w / n
        if char_w < size * 0.35:  # 行太长字太多：压字号而不是溢出
            size = max(4.0, char_w / 0.35)
        text.setFont(font, size)
        text.setCharSpace(max(-size * 0.55, char_w - size * 0.98))
        text.setTextOrigin(llx + x0, lly + y0 + size * 0.08)
        text.textLine(line)
    canvas.drawText(text)
    canvas.showPage()
    canvas.save()
    return buf.getvalue()


def ocr_pdf(src: Path, out: Path, *, pages: str | None = None, dpi: int = 200,
            password: str | None = None, progress=None, should_cancel=None,
            tier: str | None = None) -> dict:
    """生成可搜索副本。progress(done, total, page_info)；should_cancel() 为真时中止。"""
    import numpy as np
    import pikepdf
    import pypdfium2 as pdfium

    from ..tasks import Cancelled

    if not HAS_RAPIDOCR:
        raise pdfops.OpError("离线 OCR 能力包未安装（rapidocr 缺失）")

    total = len(pdfops._reader(src, password).pages)
    idx = pdfops.parse_pages(pages, total)
    targets = list(idx if idx is not None else range(total))
    engine = engine_for_run(tier)

    src_pdf = pikepdf.open(str(src), password=password or "")
    page_infos: dict[int, dict] = {}
    overlay_pages: dict[int, bytes] = {}

    doc = pdfium.PdfDocument(str(src), password=password or "")
    try:
        for n_done, i in enumerate(targets):
            if should_cancel and should_cancel():
                raise Cancelled()
            page = doc[i]
            w_pt, h_pt = page.get_size()
            scale = dpi / 72.0
            img = page.render(scale=scale).to_pil().convert("RGB")
            result = engine(np.asarray(img))
            rot = int(page.get_rotation() or 0) % 360
            disp_h_px = img.height

            pike_page = src_pdf.pages[i]
            mbox = [float(v) for v in pike_page.mediabox]
            llx, lly = mbox[0], mbox[1]
            bw, bh = mbox[2] - mbox[0], mbox[3] - mbox[1]

            items = []
            boxes = None if result.boxes is None else list(result.boxes)
            txts = None if result.txts is None else list(result.txts)
            scores = None if result.scores is None else list(result.scores)
            for box, line, score in zip(boxes or [], txts or [], scores or []):
                if line and str(line).strip():
                    items.append({"box": box, "text": str(line), "score": float(score)})
            avg = round(sum(it["score"] for it in items) / len(items), 3) if items else 0.0
            page_infos[i + 1] = {
                "page": i + 1, "words": len(items), "avg_score": avg,
                "low": (not items) or avg < MIN_CONF,
            }
            if items:
                overlay_pages[i] = _build_text_layer(
                    items, w_pt=bw, h_pt=bh, rot=rot, llx=llx, lly=lly,
                    scale=scale, disp_h_px=disp_h_px)
            if progress:
                progress(n_done + 1, len(targets), page_infos[i + 1])
    finally:
        doc.close()

    for i in sorted(overlay_pages):
        with pikepdf.open(__import__("io").BytesIO(overlay_pages[i])) as ov:
            src_pdf.pages[i].add_overlay(ov.pages[0])
    src_pdf.save(str(out))
    src_pdf.close()

    low_pages = [p for p, info in page_infos.items() if info["low"]]
    return {
        "pages": page_infos,
        "low_pages": low_pages,
        "checked": len(targets),
        "total_pages": total,
    }
