"""PDF 核心操作：信息/拆分/合并/页面管理/文本/目录/图片/渲染/加密。

约定：所有页面规格（pages spec）均为 1-based 字符串，如 "1-3,5,8-"。
所有页面操作都是非破坏性的——输出写入新文件，返回新路径。
"""

from __future__ import annotations

import re
from pathlib import Path

from pypdf import PdfReader, PdfWriter

try:  # 渲染能力（PDF→图片 / OCR 前置），缺失时优雅降级
    import pypdfium2 as pdfium
    HAS_PDFIUM = True
except ImportError:
    pdfium = None
    HAS_PDFIUM = False

try:
    import cryptography  # noqa: F401
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False


class OpError(Exception):
    """带用户可读信息的操作错误。"""


# ---------- 页码规格 ----------

def parse_pages(spec: str | None, total: int) -> list[int] | None:
    """'1-3,5,8-' → [0,1,2,4,7,...]（0-based，保持给定顺序，去重）。None/空 → None 表示全部。"""
    if spec is None or not str(spec).strip():
        return None
    out: list[int] = []
    seen: set[int] = set()
    for token in re.split(r"[,，;；]", str(spec)):
        token = token.strip()
        if not token:
            continue
        m = re.fullmatch(r"(\d+)\s*-\s*(\d*)", token)
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else total
            if start < 1 or end > total or start > end:
                raise OpError(f"页码范围无效: {token}（文档共 {total} 页）")
            rng = range(start - 1, end)
        elif token.isdigit():
            n = int(token)
            if n < 1 or n > total:
                raise OpError(f"页码超出范围: {token}（文档共 {total} 页）")
            rng = [n - 1]
        else:
            raise OpError(f"无法识别的页码: {token}")
        for i in rng:
            if i not in seen:
                seen.add(i)
                out.append(i)
    return out or None


def split_groups(spec: str) -> list[list[int]]:
    """拆分用：'1-20,21-40,41' → [[0..19],[20..39],[40]]（1-based 输入 → 0-based 组）。"""
    groups: list[list[int]] = []
    for token in re.split(r"[,，;；\n]", spec or ""):
        token = token.strip()
        if not token:
            continue
        m = re.fullmatch(r"(\d+)\s*-\s*(\d+)", token)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a < 1 or a > b:
                raise OpError(f"拆分范围无效: {token}")
            groups.append(list(range(a - 1, b)))
        elif token.isdigit():
            groups.append([int(token) - 1])
        else:
            raise OpError(f"无法识别的拆分段: {token}")
    if not groups:
        raise OpError("请至少给出一个拆分范围")
    return groups


# ---------- 拆分计划（预览与执行共用同一来源，保证名称一致） ----------

def split_plan(total: int, mode: str, *, boundary: int = 1, every: int = 1,
               ranges: str | None = None) -> dict:
    """四种规则 → [{start,end}](1-based 闭区间) + 未导出页提示。

    预览和执行都调用这里；输出文件名由此处唯一决定。
    """
    if mode == "single":
        segs = [{"start": i, "end": i} for i in range(1, total + 1)]
    elif mode == "boundary":
        if not (isinstance(boundary, int) and 1 <= boundary < total):
            raise OpError(f"分割位置必须在 1–{total - 1} 之间")
        segs = [{"start": 1, "end": boundary}, {"start": boundary + 1, "end": total}]
    elif mode == "every":
        if not (isinstance(every, int) and 1 <= every <= total):
            raise OpError(f"每份页数必须在 1–{total} 之间")
        segs = []
        i = 1
        while i <= total:
            segs.append({"start": i, "end": min(i + every - 1, total)})
            i += every
    elif mode == "ranges":
        tokens = [t.strip() for t in re.split(r"[,，;；\n]", ranges or "") if t.strip()]
        if not tokens:
            raise OpError("请输入页码范围，例如 1-5,6-12")
        segs = []
        for token in tokens:
            m = re.fullmatch(r"(\d+)(?:\s*-\s*(\d+))?", token)
            if not m:
                raise OpError(f"无法识别的页码范围: {token}")
            a = int(m.group(1))
            b = int(m.group(2) or a)
            if a < 1 or b > total or a > b:
                raise OpError(f"页码范围无效: {token}（文档共 {total} 页）")
            segs.append({"start": a, "end": b})
        covered: set[int] = set()
        for seg in segs:
            overlap = covered & set(range(seg["start"], seg["end"] + 1))
            if overlap:
                raise OpError(f"范围重叠：第 {min(overlap)} 页被多次导出")
            covered |= set(range(seg["start"], seg["end"] + 1))
    else:
        raise OpError(f"未知拆分方式: {mode}")

    skipped = sorted(set(range(1, total + 1)) - covered) if mode == "ranges" else []
    names = [split_output_name(seg["start"], seg["end"], i, len(segs))
             for i, seg in enumerate(segs, 1)]
    return {"segments": segs, "names": names, "skipped": skipped}


def split_output_name(start: int, end: int, index: int, count: int) -> str:
    if start == end:
        return f"p{start:03d}.pdf"
    return f"{index:02d}-p{start:03d}-p{end:03d}.pdf"


# ---------- 基础 ----------

def _reader(path: Path, password: str | None = None) -> PdfReader:
    reader = PdfReader(str(path), password=password) if password else PdfReader(str(path))
    if reader.is_encrypted and password is None:
        # 有些加密 PDF 空密码即可读
        try:
            if not reader.decrypt(""):
                raise OpError("文档已加密，请先提供密码")
        except OpError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise OpError(f"文档已加密，无法打开: {exc}") from exc
    return reader


def info(path: Path, password: str | None = None) -> dict:
    reader = _reader(path, password)
    meta = {}
    for key in ("title", "author", "subject", "creator", "producer"):
        v = (reader.metadata or {}).get(f"/{key}")
        if v:
            meta[key] = str(v)
    first = reader.pages[0]
    box = first.mediabox
    return {
        "pages": len(reader.pages),
        "encrypted": bool(reader.is_encrypted),
        "meta": meta,
        "width_pt": round(float(box.width), 1),
        "height_pt": round(float(box.height), 1),
    }


def _write_pages(src: Path, indices: list[int], out: Path, password: str | None = None,
                 import_outline: bool = True) -> Path:
    reader = _reader(src, password)
    total = len(reader.pages)
    indices = [i if i >= 0 else total + i for i in indices]
    writer = PdfWriter()
    if import_outline and len(indices) > 1:
        try:
            writer.append(reader, pages=list(indices), import_outline=True)
        except Exception:  # noqa: BLE001 — 大纲导入失败时退回纯页面复制
            writer = PdfWriter()
            for i in indices:
                writer.add_page(reader.pages[i])
    else:
        for i in indices:
            writer.add_page(reader.pages[i])
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        writer.write(f)
    return out


def _all_indices(path: Path, password: str | None = None) -> list[int]:
    return list(range(len(_reader(path, password).pages)))


# ---------- 拆分 / 合并 ----------

def merge(parts: list[dict], out: Path) -> Path:
    """parts: [{path, pages?: '1-3', password?: str}] → 合并输出。"""
    writer = PdfWriter()
    for part in parts:
        p = Path(part["path"])
        reader = _reader(p, part.get("password"))
        total = len(reader.pages)
        idx = parse_pages(part.get("pages"), total)
        if idx is None:
            idx = list(range(total))
        try:
            writer.append(reader, pages=list(idx), import_outline=True)
        except Exception:  # noqa: BLE001
            for i in idx:
                writer.add_page(reader.pages[i])
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        writer.write(f)
    return out


def split(path: Path, out_dir: Path, mode: str, *, boundary: int = 1, every: int = 1,
          ranges: str | None = None, size_mb: float = 5.0, stem: str | None = None,
          password: str | None = None) -> list[Path]:
    reader = _reader(path, password)
    total = len(reader.pages)
    stem = stem or Path(path).stem

    if mode == "size":  # 历史保留：按大小分组
        per_page = max(1.0, Path(path).stat().st_size / max(1, total)) / (1024 * 1024)
        chunk = max(1, int(size_mb / per_page))
        groups = [list(range(i, min(i + chunk, total))) for i in range(0, total, chunk)]
    else:
        plan = split_plan(total, mode, boundary=boundary, every=every, ranges=ranges)
        groups = [list(range(seg["start"] - 1, seg["end"])) for seg in plan["segments"]]

    outs: list[Path] = []
    for gi, indices in enumerate(groups, 1):
        out = out_dir / f"{stem}-{gi:02d}-{indices[0] + 1:03d}-{indices[-1] + 1:03d}.pdf"
        _write_pages(path, indices, out, password)
        outs.append(out)
    return outs


# ---------- 页面整理（重排 + 旋转 + 删除，一个计划一次成文） ----------

def organize_plan_check(total: int, plan: list[dict]) -> dict:
    """plan: [{page:1-based 原页号, rotate:0|90|180|270}]。返回摘要；非法时抛 OpError。"""
    if not plan:
        raise OpError("至少保留一页")
    seen: set[int] = set()
    rotations = []
    for item in plan:
        page = item.get("page")
        if not isinstance(page, int) or not (1 <= page <= total) or page in seen:
            raise OpError(f"页面计划无效：第 {page} 页缺失或重复")
        seen.add(page)
        rot = int(item.get("rotate") or 0)
        if rot % 90 or not (-360 < rot < 360):
            raise OpError("旋转角度必须是 90 的倍数")
        if rot % 360:
            rotations.append((page, rot % 360))
    dropped = sorted(set(range(1, total + 1)) - seen)
    return {"count": len(plan), "rotations": rotations, "dropped": dropped}


def require_organize_permission(path: Path, password: str | None = None) -> None:
    """受保护文档未允许修改或组装时不执行页面整理。"""
    from pypdf.constants import UserAccessPermissions

    reader = _reader(path, password)
    permissions = reader.user_access_permissions
    if permissions is not None and (
        not permissions & UserAccessPermissions.MODIFY or
        not permissions & UserAccessPermissions.ASSEMBLE_DOC
    ):
        raise OpError("该 PDF 限制修改或页面整理，无法保存整理结果。")


def organize(path: Path, plan: list[dict], out: Path, password: str | None = None) -> Path:
    require_organize_permission(path, password)
    total = len(_reader(path, password).pages)
    organize_plan_check(total, plan)
    indices = [item["page"] - 1 for item in plan]
    _write_pages(path, indices, out, password, import_outline=False)
    writer = PdfWriter(clone_from=str(out))
    for dst_index, item in enumerate(plan):
        rot = int(item.get("rotate") or 0) % 360
        if rot:
            writer.pages[dst_index].rotate(rot)
    with open(out, "wb") as f:
        writer.write(f)
    return out


# ---------- 文本页统计（OCR 引导与转换提示） ----------

def text_page_stats(path: Path, password: str | None = None, sample_limit: int = 0) -> dict:
    """逐页判断是否有可提取文字。sample_limit>0 时只看前 N 页（快速判断扫描件）。"""
    reader = _reader(path, password)
    total = len(reader.pages)
    limit = total if sample_limit <= 0 else min(total, sample_limit)
    has_text: list[int] = []
    for i in range(limit):
        try:
            if (reader.pages[i].extract_text() or "").strip():
                has_text.append(i + 1)
        except Exception:  # noqa: BLE001
            continue
    return {"total": total, "text_pages": has_text, "checked": limit}


# ---------- 页面管理（非破坏，输出新文件） ----------

def delete_pages(path: Path, pages: str, out: Path, password: str | None = None) -> Path:
    total = len(_reader(path, password).pages)
    drop = set(parse_pages(pages, total) or [])
    keep = [i for i in range(total) if i not in drop]
    if not keep:
        raise OpError("不能删除全部页面")
    return _write_pages(path, keep, out, password)


def extract_pages(path: Path, pages: str, out: Path, password: str | None = None) -> Path:
    total = len(_reader(path, password).pages)
    idx = parse_pages(pages, total)
    if not idx:
        raise OpError("未选择要提取的页面")
    return _write_pages(path, idx, out, password)


def rotate_pages(path: Path, pages: str, angle: int, out: Path, password: str | None = None) -> Path:
    if angle % 90:
        raise OpError("旋转角度必须是 90 的倍数")
    total = len(_reader(path, password).pages)
    idx = parse_pages(pages, total) or list(range(total))
    _write_pages(path, list(range(total)), out, password)  # 先完整复制（保留大纲）
    writer = PdfWriter(clone_from=str(out))
    for i in idx:
        writer.pages[i].rotate(angle)
    with open(out, "wb") as f:
        writer.write(f)
    return out


def insert_blank(path: Path, at: int, count: int, out: Path, password: str | None = None) -> Path:
    reader = _reader(path, password)
    total = len(reader.pages)
    if not (1 <= at <= total + 1):
        raise OpError(f"插入位置必须在 1–{total + 1} 之间")
    if count < 1 or count > 100:
        raise OpError("插入页数必须在 1–100 之间")
    writer = PdfWriter()
    writer.append(reader, import_outline=True)
    box = reader.pages[0].mediabox
    for _ in range(count):
        writer.add_blank_page(width=float(box.width), height=float(box.height))
    # 把新增的空页移动到目标位置
    new_total = total + count
    order = list(range(new_total))
    blanks = list(range(total, new_total))
    for b in blanks:
        order.remove(b)
    pos = at - 1
    order[pos:pos] = blanks
    moved = PdfWriter()
    for i in order:
        moved.add_page(writer.pages[i])
    with open(out, "wb") as f:
        moved.write(f)
    return out


def insert_pdf(path: Path, other: Path, other_pages: str | None, at: int, out: Path,
               password: str | None = None, other_password: str | None = None) -> Path:
    reader = _reader(path, password)
    other_reader = _reader(other, other_password)
    total = len(reader.pages)
    ototal = len(other_reader.pages)
    if not (1 <= at <= total + 1):
        raise OpError(f"插入位置必须在 1–{total + 1} 之间")
    oidx = parse_pages(other_pages, ototal) or list(range(ototal))
    part_a = list(range(0, at - 1))
    part_b = list(range(at - 1, total))
    writer = PdfWriter()
    for i in part_a:
        writer.add_page(reader.pages[i])
    for i in oidx:
        writer.add_page(other_reader.pages[i])
    for i in part_b:
        writer.add_page(reader.pages[i])
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        writer.write(f)
    return out


def move_pages(path: Path, pages: str, to: int, out: Path, password: str | None = None) -> Path:
    """把选中页移动到第 to 页的位置（1-based，指移动后在新序列中的位置）。"""
    reader = _reader(path, password)
    total = len(reader.pages)
    sel = parse_pages(pages, total) or []
    if not sel:
        raise OpError("未选择要移动的页面")
    if not (1 <= to <= total):
        raise OpError(f"目标位置必须在 1–{total} 之间")
    rest = [i for i in range(total) if i not in set(sel)]
    pos = to - 1
    order = rest[:pos] + sel + rest[pos:]
    return _write_pages(path, order, out, password, import_outline=False)


# ---------- 提取 ----------

def extract_text(path: Path, pages: str | None = None, password: str | None = None) -> list[str]:
    reader = _reader(path, password)
    total = len(reader.pages)
    idx = parse_pages(pages, total)
    idx = idx if idx is not None else range(total)
    out = []
    for i in idx:
        try:
            out.append((reader.pages[i].extract_text() or "").strip())
        except Exception:  # noqa: BLE001 — 单页失败不终止
            out.append("")
    return out


_BULLET_RE = re.compile(r"^[•·▪◦‣∙●○■□◦\-–—]\s*")
_NUM_LIST_RE = re.compile(r"^(\d{1,3})\s*[.、)）]\s*\S")


def extract_markdown(path: Path, pages: str | None = None, password: str | None = None) -> list[str]:
    """每页转为结构化 Markdown：按字体相对大小识别标题层级，行首项目符号/编号转列表。
    没有文字层的页返回空串；纯启发式，版式还原程度取决于原 PDF 的字体信息。"""
    import math

    reader = _reader(path, password)
    total = len(reader.pages)
    idx = parse_pages(pages, total)
    idx = idx if idx is not None else range(total)

    def page_markdown(page) -> str:
        frags: list[tuple[float, float, float, str]] = []  # (y, x, size, text)

        def visit(text, cm, tm, font_dict, font_size):
            if not text or not text.strip():
                return
            try:
                size = font_size * (math.hypot(tm[2], tm[3]) or 1) or font_size or 10
            except Exception:  # noqa: BLE001
                size = font_size or 10
            frags.append((-tm[5], tm[4], round(size, 1), text.replace("\r", " ").replace("\n", " ")))

        try:
            page.extract_text(visitor_text=visit)
        except Exception:  # noqa: BLE001
            return ""
        if not frags:
            return ""
        # 按行聚类：y 接近的片段合并为一行（容差随行内字号放大）
        frags.sort(key=lambda f: (f[0], f[1]))
        lines: list[list[tuple[float, float, str]]] = []
        cur: list[tuple[float, float, str]] = []
        cur_y = 0.0
        cur_max = 0.0
        for y, x, size, text in frags:
            if cur and abs(y - cur_y) <= max(2.0, cur_max * 0.4):
                cur.append((x, size, text))
                cur_max = max(cur_max, size)
            else:
                if cur:
                    lines.append(cur)
                cur = [(x, size, text)]
                cur_y = y
                cur_max = size
        if cur:
            lines.append(cur)
        rows = []
        for line in lines:
            line.sort(key=lambda f: f[0])
            text = "".join(t for _, _, t in line).strip()
            if not text:
                continue
            size = max(s for _, s, _ in line)
            rows.append((size, text))
        if not rows:
            return ""
        # 正文基准：出现最多的行字号（长度≥4 的行）
        from collections import Counter
        body = Counter(round(s, 1) for s, t in rows if len(t) >= 4)
        base = body.most_common(1)[0][0] if body else max(s for s, _ in rows)

        out_md: list[str] = []
        for size, text in rows:
            if _BULLET_RE.match(text):
                out_md.append("- " + _BULLET_RE.sub("", text, count=1).strip())
                continue
            if _NUM_LIST_RE.match(text):
                out_md.append("- " + text)
                continue
            ratio = size / base if base else 1
            if ratio >= 1.55:
                out_md.append(f"# {text}")
            elif ratio >= 1.25:
                out_md.append(f"## {text}")
            elif ratio >= 1.08 and len(text) <= 40:
                out_md.append(f"### {text}")
            else:
                out_md.append(text)
        # 相邻同类型行合并为段落；标题与列表独立
        result: list[str] = []
        para: list[str] = []
        def flush():
            if para:
                result.append("  \n".join(para) if len(para) > 1 else para[0])
                para.clear()
        for line in out_md:
            if line.startswith(("#", "- ")) or not line:
                flush()
                result.append(line)
            else:
                para.append(line)
        flush()
        return "\n\n".join(result)

    out = []
    for i in idx:
        try:
            out.append(page_markdown(reader.pages[i]).strip())
        except Exception:  # noqa: BLE001 — 单页失败不终止
            out.append("")
    return out


def outline(path: Path, password: str | None = None) -> list[dict]:
    """PDF 书签树 → [{title, page(1-based), children:[...]}]。"""
    reader = _reader(path, password)

    def page_no(dest) -> int | None:
        try:
            return reader.get_destination_page_number(dest) + 1
        except Exception:  # noqa: BLE001
            return None

    def walk(items) -> list[dict]:
        nodes = []
        for item in items:
            if isinstance(item, list):
                if nodes:
                    nodes[-1]["children"] = walk(item)
            else:
                title = getattr(item, "title", None) or "(无标题)"
                nodes.append({"title": str(title).strip(), "page": page_no(item), "children": []})
        return nodes

    try:
        return walk(reader.outline)
    except Exception:  # noqa: BLE001
        return []


def toc_markdown(nodes: list[dict], depth: int = 0) -> str:
    lines = []
    for n in nodes:
        page = f" · {n['page']}" if n.get("page") else ""
        lines.append(f"{'  ' * depth}- {n['title']}{page}")
        if n.get("children"):
            lines.append(toc_markdown(n["children"], depth + 1))
    return "\n".join([l for l in lines if l])


def extract_images(path: Path, out_dir: Path, password: str | None = None) -> list[Path]:
    reader = _reader(path, password)
    out_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    seen_names: set[str] = set()
    for pi, page in enumerate(reader.pages, 1):
        try:
            images = list(page.images)
        except Exception:  # noqa: BLE001
            continue
        for img in images:
            name = f"p{pi:03d}_{img.name}"
            base = name
            k = 1
            while name in seen_names:
                k += 1
                stem, _, ext = base.rpartition(".")
                name = f"{stem}_{k}.{ext}" if stem else f"{base}_{k}"
            seen_names.add(name)
            try:
                target = out_dir / name
                with open(target, "wb") as f:
                    f.write(img.data)
                saved.append(target)
            except Exception:  # noqa: BLE001
                continue
    return saved


def render_pages(path: Path, out_dir: Path, pages: str | None = None, dpi: int = 150,
                 fmt: str = "png", password: str | None = None) -> list[Path]:
    if not HAS_PDFIUM:
        raise OpError("渲染引擎未安装（pypdfium2 缺失）")
    total = len(_reader(path, password).pages)
    idx = parse_pages(pages, total)
    idx = idx if idx is not None else range(total)
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = pdfium.PdfDocument(str(path), password=password or "")
    stem = Path(path).stem
    outs = []
    scale = max(0.5, dpi / 72.0)
    for i in idx:
        page = doc[i]
        pil = page.render(scale=scale).to_pil()
        out = out_dir / f"{stem}-p{i + 1:03d}.{fmt}"
        pil.save(out)
        outs.append(out)
    doc.close()
    return outs


def thumb(path: Path, page_1based: int, dpi: int = 60, password: str | None = None) -> bytes:
    if not HAS_PDFIUM:
        raise OpError("渲染引擎未安装")
    doc = pdfium.PdfDocument(str(path), password=password or "")
    try:
        idx = min(max(1, page_1based), len(doc)) - 1
        pil = doc[idx].render(scale=dpi / 72.0).to_pil()
        import io

        buf = io.BytesIO()
        pil.save(buf, format="PNG")
        return buf.getvalue()
    finally:
        doc.close()


# ---------- 加密 ----------

def encrypt(path: Path, out: Path, user_pw: str, owner_pw: str | None = None,
            password: str | None = None) -> Path:
    writer = PdfWriter(clone_from=_reader(path, password))
    writer.encrypt(user_password=user_pw, owner_password=owner_pw or user_pw)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        writer.write(f)
    return out


def decrypt(path: Path, out: Path, password: str) -> Path:
    reader = _reader(path, password)
    if not reader.is_encrypted:
        raise OpError("文档未加密")
    writer = PdfWriter()
    writer.append(reader, import_outline=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        writer.write(f)
    return out
