"""任务类型登记表：每种任务的「预览」与「执行」共用一套计划逻辑。

预览（preview）在执行前给出：输出文件数、名称、页数、警告与目标冲突；
执行（run）按同一计划生成文件，先写任务临时目录，确认完整后交付到目标位置。
目标冲突与不可写目录在预览和执行时都会检查，绝不静默覆盖。
"""

from __future__ import annotations

import re
import shutil
import hashlib
import os
import tempfile
import time
import threading
from pathlib import Path

from . import config, localai
from .core import document_ai, export, ocrpdf, ofd, pdfops, tables, topdf
from .store import Store, source_dir_of
from .tasks import Cancelled, TaskHub

store = Store()
hub = TaskHub()
_ofd_cache_locks: dict[str, threading.Lock] = {}
_ofd_cache_guard = threading.Lock()

# 保存位置参数的保留值：与源文件同目录（06 改版 107–115）
SOURCE_DIR_OPT = "@source"


# ---------- 输出目标 ----------

def _safe_name(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", str(name)).strip(" .") or "out"


def _resolve_dir(dir_opt, sources: list[dict] | None = None) -> Path:
    if dir_opt == SOURCE_DIR_OPT:
        first = sources[0] if sources else None
        d = source_dir_of(first) if first else None
        if d is None:
            raise pdfops.OpError(
                "与源文件同目录不可用：该文件没有可信的本机源路径（浏览器上传的副本不算源目录）。请选择应用输出目录或其他位置。")
        return d
    if dir_opt:
        p = Path(str(dir_opt))
        if not p.is_absolute():
            raise pdfops.OpError("保存位置必须是本机绝对路径")
        return p
    return config.OUT_DIR


def _dir_writable(d: Path) -> str | None:
    try:
        d.mkdir(parents=True, exist_ok=True)
        fd, probe_name = tempfile.mkstemp(prefix=".zl-write-probe-", dir=d)
        os.close(fd)
        probe = Path(probe_name)
        for attempt in range(5):
            try:
                probe.unlink()
                break
            except PermissionError:
                if os.name != "nt" or attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
        return None
    except OSError as exc:
        return f"目录不可写：{d}（{exc.strerror or exc}）"


def _deliver(temp: Path, final: Path, display: str | None = None, ctx=None) -> dict:
    """临时文件 → 目标位置（不覆盖已有文件）并登记。"""
    final.parent.mkdir(parents=True, exist_ok=True)
    # 先复制到目标目录，再原子占用目标名；不同卷也不会退化为覆盖式复制。
    fd, staged_name = tempfile.mkstemp(prefix=".zl-delivery-", dir=final.parent)
    staged = Path(staged_name)
    try:
        with os.fdopen(fd, "wb") as dest, temp.open("rb") as src:
            shutil.copyfileobj(src, dest)
        if ctx is not None:
            ctx.reserve_output(staged, final, staged=True)
        try:
            if os.name == "nt":
                os.rename(staged, final)  # Windows 的 rename 不覆盖已有目标。
            else:
                os.link(staged, final)
        except FileExistsError as exc:
            if ctx is not None:
                ctx.discard_reservation(staged, final)
            raise pdfops.OpError(f"目标已有同名文件：{final.name}。请更名或换目录后重试。") from exc
    finally:
        staged.unlink(missing_ok=True)
    return store.add_output(final, display=display or final.name)


def _require_writable(d: Path) -> None:
    err = _dir_writable(d)
    if err:
        raise pdfops.OpError(err)


def _split_ext(name: str) -> tuple[str, str]:
    stem, dot, ext = name.rpartition(".")
    return (stem, f".{ext}") if dot else (name, "")


def _numbered_plan(d: Path, names: list[str]) -> list[str]:
    """同目录模式的交付名：冲突时在扩展名前追加全角括号编号（报告.pdf → 报告（1）.pdf），
    从 1 起取未占用名；逐项检查磁盘已有文件，并避免本批次内部重名。"""
    claimed: set[str] = set()
    final: list[str] = []
    for name in names:
        stem, ext = _split_ext(name)
        cand, n = name, 0
        while n < 999 and ((d / cand).exists() or cand in claimed):
            n += 1
            cand = f"{stem}（{n}）{ext}"
        if (d / cand).exists() or cand in claimed:
            raise pdfops.OpError(f"无法为 {name} 找到可用文件名")
        claimed.add(cand)
        final.append(cand)
    return final


def _deliver_numbered(temp: Path, d: Path, name: str, ctx=None) -> dict:
    """同目录自动编号交付：预览之后新出现的冲突继续递增编号，绝不覆盖任何文件。"""
    stem, ext = _split_ext(name)
    last: pdfops.OpError | None = None
    for n in range(1000):
        cand = name if n == 0 else f"{stem}（{n}）{ext}"
        if (d / cand).exists():
            continue
        try:
            return _deliver(temp, d / cand, display=cand, ctx=ctx)
        except pdfops.OpError as exc:  # 竞态下目标刚被占用 → 尝试下一个编号
            last = exc
    raise last or pdfops.OpError(f"无法为 {name} 找到可用文件名")


def _entry_path(fid) -> tuple[Path, dict]:
    entry = store.get(str(fid))
    if not entry:
        raise pdfops.OpError(f"未知文件 id: {fid}")
    p = Path(entry["path"])
    if not p.exists():
        raise pdfops.OpError(f"文件已不存在: {entry['name']}")
    return p, entry


def _pages_of(entry: dict, p: Path) -> int:
    if entry.get("pages"):
        return int(entry["pages"])
    total = int(pdfops.info(p)["pages"])
    store.set_pages(entry["id"], total)
    return total


# ---------- 预览公共输出 ----------

def _preview_result(dir_opt, names_with_pages: list[dict], summary: str,
                    warnings: list[str] | None = None, sources: list[dict] | None = None) -> dict:
    """预览统一展示自动编号后的最终交付名（v0.2 用户决定：任何保存位置重名都追加（N），
    绝不覆盖、绝不阻断执行）。"""
    d = _resolve_dir(dir_opt, sources)
    names = [n["name"] for n in names_with_pages]
    numbered = _numbered_plan(d, names)
    names_with_pages = [dict(n, name=nn) for n, nn in zip(names_with_pages, numbered)]
    writable_error = _dir_writable(d)
    out = {
        "ok": not writable_error,
        "summary": summary,
        "outputs": names_with_pages,
        "warnings": warnings or [],
        "dir": str(d),
        "writable_error": writable_error,
        "conflicts": [],
        "numbered": True,
    }
    if writable_error:
        out["error"] = writable_error
    return out


def _check_run_target(d: Path, names: list[str]) -> None:
    err = _dir_writable(d)
    if err:
        raise pdfops.OpError(err)
    conflicts = [n for n in names if (d / n).exists()]
    if conflicts:
        raise pdfops.OpError("目标已有同名文件：" + "、".join(conflicts[:5]) + "。请更名或换目录后重试。")


# ============================================================ 拆分

def _split_plan_params(params: dict):
    p, entry = _entry_path(params.get("id"))
    total = _pages_of(entry, p)
    mode = params.get("mode", "boundary")
    plan = pdfops.split_plan(
        total, mode,
        boundary=int(params.get("boundary") or 1),
        every=int(params.get("every") or 1),
        ranges=params.get("ranges"),
    )
    stem = _safe_name(str(params.get("stem") or Path(entry["name"]).stem).removesuffix(".pdf"))
    return p, entry, total, plan, stem


def preview_split(params: dict) -> dict:
    p, entry, total, plan, stem = _split_plan_params(params)
    exported = sum(seg["end"] - seg["start"] + 1 for seg in plan["segments"])
    outs = [{"name": f"{stem}-{n}", "pages": seg["end"] - seg["start"] + 1,
             "range": f"{seg['start']}–{seg['end']}"}
            for seg, n in zip(plan["segments"], plan["names"])]
    warnings = []
    if plan["skipped"]:
        shown = ",".join(_page_list_summary(plan["skipped"]))
        warnings.append(f"自定义范围未导出第 {shown}（本次只生成所选范围的文件）。")
    return _preview_result(params.get("dir"), outs,
                           f"{len(outs)} 个 PDF · 共 {exported} 页", warnings,
                           sources=[entry])


def run_split(params: dict, ctx) -> dict:
    p, entry, total, plan, stem = _split_plan_params(params)
    d = _resolve_dir(params.get("dir"), sources=[entry])
    names = [f"{stem}-{n}" for n in plan["names"]]
    _require_writable(d)
    tmp = ctx.temp_root
    made = []
    for i, seg in enumerate(plan["segments"]):
        ctx.check()
        indices = list(range(seg["start"] - 1, seg["end"]))
        tmp_out = tmp / names[i]
        pdfops._write_pages(p, indices, tmp_out)
        ctx.progress(0.9 * (i + 1) / len(plan["segments"]), f"已准备 {i + 1}/{len(plan['segments'])} 个文件")
    ctx.check()
    for i, seg in enumerate(plan["segments"]):
        ctx.check()
        indices = list(range(seg["start"] - 1, seg["end"]))
        tmp_out = tmp / names[i]
        entry_out = _deliver_numbered(tmp_out, d, names[i], ctx=ctx)
        ctx.output(entry_out)
        store.set_pages(entry_out["id"], len(indices))
        made.append(entry_out)
        ctx.progress(0.9 + 0.1 * (i + 1) / len(plan["segments"]), f"已生成 {i + 1}/{len(plan['segments'])} 个文件")
    return {"files": [dict(e, pages=seg["end"] - seg["start"] + 1)
                      for e, seg in zip(made, plan["segments"])],
            "skipped": plan["skipped"]}


def _page_list_summary(pages: list[int], cap: int = 12) -> list[str]:
    if len(pages) <= cap:
        return [str(x) for x in pages]
    return [str(x) for x in pages[:cap]] + [f"等共 {len(pages)} 页"]


# ============================================================ 合并

def _merge_parts(params: dict):
    items = params.get("items") or []
    if len(items) < 2:
        raise pdfops.OpError("合并至少需要 2 份 PDF")
    parts = []
    for it in items:
        p, entry = _entry_path(it.get("id"))
        if entry["kind"] != "pdf":
            raise pdfops.OpError(f"仅支持合并 PDF：{entry['name']}")
        total = _pages_of(entry, p)
        idx = pdfops.parse_pages(it.get("pages"), total)
        count = len(idx) if idx is not None else total
        if count < 1:
            raise pdfops.OpError(f"{entry['name']} 没有可合并的页")
        parts.append({"path": p, "pages": it.get("pages"), "count": count, "entry": entry})
    return parts


def preview_merge(params: dict) -> dict:
    parts = _merge_parts(params)
    name = _safe_name(str(params.get("name") or "合并卷宗.pdf"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    total = sum(pt["count"] for pt in parts)
    detail = [f"{pt['entry']['name']}（{pt['count']} 页）" for pt in parts]
    # 多文件以当前列表第一项的源目录为准
    return _preview_result(params.get("dir"), [{"name": name, "pages": total, "order": detail}],
                           f"1 个 PDF · 共 {total} 页", sources=[parts[0]["entry"]])


def run_merge(params: dict, ctx) -> dict:
    parts = _merge_parts(params)
    name = _safe_name(str(params.get("name") or "合并卷宗.pdf"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    d = _resolve_dir(params.get("dir"), sources=[parts[0]["entry"]])
    _require_writable(d)
    ctx.progress(0.1, "读取页面")
    tmp_out = ctx.temp_root / name
    pdfops.merge([{"path": pt["path"], "pages": pt["pages"]} for pt in parts], tmp_out)
    ctx.check()
    entry_out = _deliver_numbered(tmp_out, d, name, ctx=ctx)
    ctx.output(entry_out)
    total = sum(pt["count"] for pt in parts)
    entry_out = dict(entry_out, pages=total)
    store.set_pages(entry_out["id"], total)
    return {"file": entry_out}


# ============================================================ 页面整理

def preview_organize(params: dict) -> dict:
    p, entry = _entry_path(params.get("id"))
    pdfops.require_organize_permission(p)
    total = _pages_of(entry, p)
    summary = pdfops.organize_plan_check(total, params.get("plan") or [])
    name = _safe_name(str(params.get("name") or Path(entry["name"]).stem + "-整理.pdf"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    notes = [f"新文档 {summary['count']} 页"]
    if summary["rotations"]:
        notes.append("旋转 " + "、".join(f"第{pg}页({rot}°)" for pg, rot in summary["rotations"][:6])
                     + ("…" if len(summary["rotations"]) > 6 else ""))
    if summary["dropped"]:
        notes.append("删除 " + ",".join(_page_list_summary(summary["dropped"])))
    return _preview_result(params.get("dir"),
                           [{"name": name, "pages": summary["count"]}], "；".join(notes))


def run_organize(params: dict, ctx) -> dict:
    p, entry = _entry_path(params.get("id"))
    total = _pages_of(entry, p)
    summary = pdfops.organize_plan_check(total, params.get("plan") or [])
    name = _safe_name(str(params.get("name") or Path(entry["name"]).stem + "-整理.pdf"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    d = _resolve_dir(params.get("dir"))
    _require_writable(d)
    ctx.progress(0.2, "生成新文档")
    tmp_out = ctx.temp_root / name
    pdfops.organize(p, params["plan"], tmp_out)
    ctx.check()
    entry_out = _deliver_numbered(tmp_out, d, name, ctx=ctx)
    ctx.output(entry_out)
    store.set_pages(entry_out["id"], summary["count"])
    return {"file": dict(entry_out, pages=summary["count"]), "summary": summary}


# ============================================================ PDF 转换

def preview_convert_pdf(params: dict) -> dict:
    p, entry = _entry_path(params.get("id"))
    total = _pages_of(entry, p)
    target = str(params.get("target") or "").lower()
    if target not in ("png", "jpg", "txt", "md", "docx", "xlsx", "csv", "pptx"):
        raise pdfops.OpError("目标格式仅支持 PNG、JPEG、TXT、Markdown、Word、Excel、CSV 或 PPT")
    prefix = _safe_name(str(params.get("prefix") or Path(entry["name"]).stem))
    idx = pdfops.parse_pages(params.get("pages"), total)
    selected = idx if idx is not None else list(range(total))
    if not selected:
        raise pdfops.OpError("所选页码范围内没有页面")
    warnings = []
    if target in ("txt", "md", "docx"):
        stats = pdfops.text_page_stats(p, sample_limit=min(total, 8))
        empty = stats["checked"] - len(stats["text_pages"])
        if stats["checked"] and empty >= max(1, stats["checked"] // 2):
            warnings.append("该 PDF 大概率是扫描件（多数页没有文字层）。输出可能只有少量文字，建议先做离线 OCR。")
        if target == "txt":
            outs = [{"name": f"{prefix}.txt", "pages": len(selected), "note": "一份 TXT，保留页分隔标记"}]
            return _preview_result(params.get("dir"), outs,
                                   f"1 个 TXT · {len(selected)} 页内容", warnings, sources=[entry])
        if target == "md":
            outs = [{"name": f"{prefix}.md", "pages": len(selected), "note": "一份 Markdown · 标题与列表按原文字层级"}]
            return _preview_result(params.get("dir"), outs,
                                   f"1 个 Markdown · {len(selected)} 页内容", warnings, sources=[entry])
        outs = [{"name": f"{prefix}.docx", "pages": len(selected),
                 "note": "一份 Word · 文字按页整理（基础版，不含原版式）"}]
        return _preview_result(params.get("dir"), outs,
                               f"1 个 Word · {len(selected)} 页内容", warnings, sources=[entry])
    if target == "pptx":
        dpi = int(params.get("dpi") or 150)
        if dpi not in (96, 150, 300):
            raise pdfops.OpError("DPI 仅支持 96 / 150 / 300")
        outs = [{"name": f"{prefix}.pptx", "pages": len(selected),
                 "note": "一份 PPT · 每页一张幻灯片图片（16:9，等比居中）"}]
        return _preview_result(params.get("dir"), outs,
                               f"1 个 PPT · {len(selected)} 页 · {dpi} DPI", warnings, sources=[entry])
    if target in ("xlsx", "csv"):
        probe = selected[:8]
        try:
            data = tables.extract(p, pages=",".join(str(i + 1) for i in probe))
        except pdfops.OpError:
            data = []
        n_tables = sum(len(d["tables"]) for d in data)
        # 前八页没有表格时继续分块检查，只有全部所选页均无表格才拦截。
        while not n_tables and len(probe) < len(selected):
            batch = selected[len(probe):len(probe) + tables.MAX_PAGES_PER_CALL]
            data = tables.extract(p, pages=",".join(str(i + 1) for i in batch))
            probe.extend(batch)
            n_tables += sum(len(d["tables"]) for d in data)
        if not n_tables:
            return {
                "ok": False,
                "error": f"所选页面未检测到表格（已检查前 {len(probe)} 页）。请调整页码范围后重试。",
                "outputs": [], "warnings": [],
                "dir": str(_resolve_dir(params.get("dir"), sources=[entry])),
                "conflicts": [], "summary": "未检测到表格",
            }
        if len(selected) > len(probe):
            warnings.append(f"预览仅检查了前 {len(probe)} 页，检测到 {n_tables} 张表格；执行时将检查所选全部 {len(selected)} 页，无表格则不生成文件。")
        label = "Excel" if target == "xlsx" else "CSV"
        outs = [{"name": f"{prefix}.{target}", "pages": len(selected),
                 "note": f"检测到 {n_tables} 张表格（检查了前 {len(probe)} 页）"}]
        return _preview_result(params.get("dir"), outs,
                               f"1 个 {label} · 检测到 {n_tables} 张表格", warnings, sources=[entry])
    outs = [{"name": f"{prefix}-p{i + 1:03d}.{target}", "pages": 1} for i in selected]
    return _preview_result(params.get("dir"), outs,
                           f"{len(outs)} 张 {target.upper()} · 按原页号命名", warnings, sources=[entry])


def _extract_tables_chunked(p: Path, selected: list[int], ctx, phase: float = 0.85) -> list[dict]:
    """按 tables.MAX_PAGES_PER_CALL 分块提取所选页的表格，全程可取消。"""
    data: list[dict] = []
    chunks = [selected[i:i + tables.MAX_PAGES_PER_CALL]
              for i in range(0, len(selected), tables.MAX_PAGES_PER_CALL)]
    for n, chunk in enumerate(chunks):
        ctx.check()
        spec = ",".join(str(i + 1) for i in chunk)
        data.extend(tables.extract(p, pages=spec))
        done = min((n + 1) * tables.MAX_PAGES_PER_CALL, len(selected))
        ctx.progress(phase * (n + 1) / len(chunks), f"已提取 {done}/{len(selected)} 页")
    return data


def run_convert_pdf(params: dict, ctx) -> dict:
    p, entry = _entry_path(params.get("id"))
    total = _pages_of(entry, p)
    target = str(params.get("target") or "").lower()
    prefix = _safe_name(str(params.get("prefix") or Path(entry["name"]).stem))
    d = _resolve_dir(params.get("dir"), sources=[entry])
    if target in ("png", "jpg"):
        dpi = int(params.get("dpi") or 150)
        if dpi not in (96, 150, 300):
            raise pdfops.OpError("DPI 仅支持 96 / 150 / 300")
        idx = pdfops.parse_pages(params.get("pages"), total)
        selected = idx if idx is not None else list(range(total))
        names = [f"{prefix}-p{i + 1:03d}.{target}" for i in selected]
        _require_writable(d)
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(str(p))
        made = []
        try:
            for n, i in enumerate(selected):
                ctx.check()
                page = doc[i]
                img = page.render(scale=dpi / 72.0).to_pil()
                tmp_out = ctx.temp_root / names[n]
                img.save(tmp_out, quality=88) if target == "jpg" else img.save(tmp_out)
                ctx.progress(0.9 * (n + 1) / len(selected), f"已处理 {n + 1}/{len(selected)} 页")
        finally:
            doc.close()
        ctx.check()
        for n, name in enumerate(names):
            ctx.check()
            entry_out = _deliver_numbered(ctx.temp_root / name, d, name, ctx=ctx)
            ctx.output(entry_out)
            made.append(entry_out)
            ctx.progress(0.9 + 0.1 * (n + 1) / len(names), f"已导出 {n + 1}/{len(names)} 页")
        return {"files": made}
    if target == "txt":
        name = f"{prefix}.txt"
        _require_writable(d)
        idx = pdfops.parse_pages(params.get("pages"), total)
        selected = idx if idx is not None else list(range(total))
        parts = []
        has_text = False
        for n, i in enumerate(selected):
            ctx.check()
            pages = pdfops.extract_text(p, pages=str(i + 1))
            page_text = pages[0] if pages else ""
            has_text = has_text or bool(page_text.strip())
            parts.append(f"════════ 第 {i + 1} 页 ════════\n{page_text}".rstrip())
            ctx.progress((n + 1) / len(selected), f"已提取 {n + 1}/{len(selected)} 页")
        if not has_text:
            raise pdfops.OpError("所选页没有可提取的文字，请先完成 OCR。")
        tmp_out = ctx.temp_root / name
        tmp_out.write_text("\n\n".join(parts) + "\n", encoding="utf-8")
        entry_out = _deliver_numbered(tmp_out, d, name, ctx=ctx)
        ctx.output(entry_out)
        return {"files": [entry_out]}
    if target == "md":
        name = f"{prefix}.md"
        _require_writable(d)
        idx = pdfops.parse_pages(params.get("pages"), total)
        selected = idx if idx is not None else list(range(total))
        parts = []
        for n, i in enumerate(selected):
            ctx.check()
            pages = pdfops.extract_markdown(p, pages=str(i + 1))
            parts.append(pages[0] if pages else "")
            ctx.progress((n + 1) / len(selected), f"已转换 {n + 1}/{len(selected)} 页")
        body = "\n\n---\n\n".join(part for part in parts if part)
        if not body.strip():
            raise pdfops.OpError("所选页没有可提取的文字，请先完成 OCR。")
        tmp_out = ctx.temp_root / name
        tmp_out.write_text(body + "\n", encoding="utf-8")
        entry_out = _deliver_numbered(tmp_out, d, name, ctx=ctx)
        ctx.output(entry_out)
        return {"files": [entry_out]}
    if target == "docx":
        name = f"{prefix}.docx"
        _require_writable(d)
        idx = pdfops.parse_pages(params.get("pages"), total)
        spec = ",".join(str(i + 1) for i in idx) if idx is not None else None
        ctx.progress(0.1, "整理文字")
        tmp_out = ctx.temp_root / name
        export.pdf_to_docx(p, tmp_out, pages=spec,
                           progress=lambda done, ttl: ctx.progress(
                               0.1 + 0.8 * done / max(1, ttl), f"已整理 {done}/{ttl} 页"))
        ctx.check()
        entry_out = _deliver_numbered(tmp_out, d, name, ctx=ctx)
        ctx.output(entry_out)
        return {"files": [entry_out]}
    if target == "pptx":
        dpi = int(params.get("dpi") or 150)
        if dpi not in (96, 150, 300):
            raise pdfops.OpError("DPI 仅支持 96 / 150 / 300")
        name = f"{prefix}.pptx"
        _require_writable(d)
        idx = pdfops.parse_pages(params.get("pages"), total)
        selected = idx if idx is not None else list(range(total))
        import pypdfium2 as pdfium

        imgs = []
        doc = pdfium.PdfDocument(str(p))
        try:
            for n, i in enumerate(selected):
                ctx.check()
                img = doc[i].render(scale=dpi / 72.0).to_pil()
                img_path = ctx.temp_root / f"{prefix}-slide-{n + 1:03d}.png"
                img.save(img_path)
                imgs.append(img_path)
                ctx.progress(0.8 * (n + 1) / len(selected), f"已渲染 {n + 1}/{len(selected)} 页")
        finally:
            doc.close()
        ctx.check()
        tmp_out = ctx.temp_root / name
        export.pdf_to_pptx(imgs, tmp_out)
        for img_path in imgs:
            img_path.unlink(missing_ok=True)
        ctx.progress(0.9, "组装 PPT")
        entry_out = _deliver_numbered(tmp_out, d, name, ctx=ctx)
        ctx.output(entry_out)
        return {"files": [entry_out]}
    if target in ("xlsx", "csv"):
        name = f"{prefix}.{target}"
        _require_writable(d)
        idx = pdfops.parse_pages(params.get("pages"), total)
        selected = idx if idx is not None else list(range(total))
        ctx.progress(0.05, "检测表格")
        data = _extract_tables_chunked(p, selected, ctx)
        if not sum(len(d["tables"]) for d in data):
            raise pdfops.OpError("所选页面未检测到表格，请调整页码范围。")
        tmp_out = ctx.temp_root / name
        (tables.export_xlsx if target == "xlsx" else tables.export_csv)(data, tmp_out)
        ctx.progress(0.95, "生成文件")
        entry_out = _deliver_numbered(tmp_out, d, name, ctx=ctx)
        ctx.output(entry_out)
        return {"files": [entry_out]}
    raise pdfops.OpError("目标格式仅支持 PNG、JPEG、TXT、Markdown、Word、Excel、CSV 或 PPT")


# ============================================================ 图片 → PDF

def preview_images_pdf(params: dict) -> dict:
    ids = params.get("ids") or []
    if not ids:
        raise pdfops.OpError("请选择至少一张 PNG/JPEG 图片")
    names, first_entry = [], None
    for fid in ids:
        _, entry = _entry_path(fid)
        if entry["kind"] != "image":
            raise pdfops.OpError(f"仅支持图片：{entry['name']}")
        if first_entry is None:
            first_entry = entry
        names.append(entry["name"])
    name = _safe_name(str(params.get("name") or "图片合集.pdf"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    # 多图以当前列表第一项的源目录为准
    return _preview_result(params.get("dir"), [{"name": name, "pages": len(ids), "order": names}],
                           f"1 个 PDF · {len(ids)} 页 · 顺序即当前排列", sources=[first_entry])


def run_images_pdf(params: dict, ctx) -> dict:
    ids = params.get("ids") or []
    _, first = _entry_path(ids[0])
    name = _safe_name(str(params.get("name") or "图片合集.pdf"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    d = _resolve_dir(params.get("dir"), sources=[first])
    _require_writable(d)
    paths = []
    for fid in ids:
        p, entry = _entry_path(fid)
        paths.append(p)
    ctx.progress(0.3, "合成 PDF")
    tmp_out = ctx.temp_root / name
    topdf.images_to_pdf(paths, tmp_out)
    ctx.check()
    entry_out = _deliver_numbered(tmp_out, d, name, ctx=ctx)
    ctx.output(entry_out)
    store.set_pages(entry_out["id"], len(ids))
    return {"file": dict(entry_out, pages=len(ids))}


# ============================================================ 离线 OCR

def preview_ocr(params: dict) -> dict:
    p, entry = _entry_path(params.get("id"))
    total = _pages_of(entry, p)
    tier = params.get("tier")
    if not ocrpdf.HAS_RAPIDOCR:
        raise pdfops.OpError("OCR 代码未随引擎提供（rapidocr 缺失）。")
    if tier and not ocrpdf._tier_ready(tier):
        raise pdfops.OpError(f"OCR {ocrpdf.TIER_LABELS.get(tier, tier)} 未安装。请到 设置 → 插件 安装。")
    if not tier and not ocrpdf.available():
        raise pdfops.OpError("离线 OCR 模型插件未安装。请到 设置 → 插件 安装（标准档约 30 MB）。")
    name = _safe_name(str(params.get("name") or Path(entry["name"]).stem + "-可搜索.pdf"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    explicit = pdfops.parse_pages(params.get("pages"), total)
    if explicit is not None:
        targets, note = list(explicit), "按指定页识别"
    else:
        # 默认只识别无文字层的页：有文字的页（如 Word 导出的 PDF）直接可搜索，不需要 OCR
        stats = pdfops.text_page_stats(p)
        textless = sorted(set(range(1, total + 1)) - set(stats["text_pages"]))
        if textless:
            targets, note = textless, f"仅识别无文字层的 {len(textless)} 页（其余 {total - len(textless)} 页已有文字层）"
        else:
            return {
                "ok": False,
                "error": "此文档全部页面已有文字层，可直接搜索与复制，无需 OCR。",
                "outputs": [], "warnings": [], "dir": str(_resolve_dir(params.get("dir"))),
                "conflicts": [], "textless": 0, "total": total,
                "summary": "无需 OCR · 已有文字层",
            }
    return _preview_result(
        params.get("dir"),
        [{"name": name, "pages": len(targets),
          "note": f"保留原图的可搜索副本；{note}"}],
        f"1 个可搜索 PDF · 处理 {len(targets)}/{total} 页 · {note}")


def run_ocr(params: dict, ctx) -> dict:
    p, entry = _entry_path(params.get("id"))
    total = _pages_of(entry, p)
    name = _safe_name(str(params.get("name") or Path(entry["name"]).stem + "-可搜索.pdf"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    d = _resolve_dir(params.get("dir"))
    _require_writable(d)
    dpi = int(params.get("dpi") or 200)

    explicit = pdfops.parse_pages(params.get("pages"), total)
    if explicit is not None:
        target_pages = list(explicit)
    else:
        stats = pdfops.text_page_stats(p)
        target_pages = sorted(set(range(1, total + 1)) - set(stats["text_pages"]))
        if not target_pages:
            raise pdfops.OpError("此文档全部页面已有文字层，可直接搜索与复制，无需 OCR。")

    def progress(done: int, ttl: int, page_info: dict):
        ctx.progress(0.95 * done / max(1, ttl), f"已识别 {done}/{ttl} 页（第 {page_info['page']} 页 {page_info['words']} 词）")

    tmp_out = ctx.temp_root / name
    # parse_pages 返回从 0 开始的内部索引；ocr_pdf 接收用户看到的 1-based 页码。
    # 不截断长文档的目标页，否则会无提示地漏掉后续扫描页。
    spec = ",".join(str(x + 1) for x in target_pages) if explicit is not None else ",".join(str(x) for x in target_pages)
    result = ocrpdf.ocr_pdf(p, tmp_out, pages=spec, dpi=dpi,
                            should_cancel=lambda: ctx._task["cancel"].is_set(),
                            progress=progress, tier=params.get("tier"))
    ctx.check()
    entry_out = _deliver_numbered(tmp_out, d, name, ctx=ctx)
    ctx.output(entry_out)
    store.set_pages(entry_out["id"], total)
    return {"file": dict(entry_out, pages=total), **result}


# ============================================================ OCR 模型插件（用户确认后安装）

def run_ocr_pack_install(params: dict, ctx) -> dict:
    """仅当用户在界面确认后才会下载模型插件；装进数据目录 plugins/ocr-models/。"""
    if params.get("confirmed") is not True:
        raise pdfops.OpError("OCR 模型插件需要用户在设置中明确确认后才会安装。")
    tier = params.get("tier") or "standard"
    ocrpdf.install(
        tier,
        progress=lambda pct, detail: ctx.progress(pct if pct is not None else ctx._task["progress"], detail),
        should_cancel=lambda: ctx._task["cancel"].is_set())
    return {"ok": True, "tier": tier, "status": ocrpdf.plugin_status()}


def run_ocr_pack_uninstall(params: dict, ctx) -> dict:
    if params.get("confirmed") is not True:
        raise pdfops.OpError("卸载 OCR 模型插件需要用户确认。")
    result = ocrpdf.uninstall(params.get("tier"))
    return {"ok": True, **result, "status": ocrpdf.plugin_status()}


# ============================================================ AI 分析

def _ai_ready(params: dict) -> tuple[dict, bool]:
    from .core import ai

    config_id = str(params.get("config_id") or "").strip()
    cfg = ai.config_by_id_full(config_id) if config_id else ai.active_config_full()
    if not cfg:
        if config_id:
            raise pdfops.OpError("所选模型配置已不存在，请重新选择。")
        raise pdfops.OpError("尚未配置模型。请到 设置 → 模型配置：配置大模型 API（按通道优先级），或安装本地 AI 插件。")
    local = document_ai.is_local_model(cfg)
    if not local:
        if params.get("allow_remote") is not True:
            raise pdfops.OpError("远程模型需要先确认发送范围（本次会发送文档文字到外部服务）。")
        if not cfg.get("key_plain"):
            raise pdfops.OpError("远程模型缺少密钥。")
    model_override = str(params.get("model_override") or "").strip()
    if model_override:
        if not local:
            raise pdfops.OpError("只能切换已安装的本地模型。")
        installed = {m.get("name") for m in localai.list_models()}
        if model_override not in installed:
            raise pdfops.OpError("所选本地模型未安装或服务未就绪。")
        cfg = {**cfg, "model": model_override, "name": f"本地 · {model_override}"}
    return cfg, local


def run_ai_analyze(params: dict, ctx) -> dict:
    p, entry = _entry_path(params.get("id"))
    cfg, local = _ai_ready(params)

    def prog(value):
        ctx.check()
        ctx.progress(value)

    result = document_ai.analyze(
        p, cfg, str(params.get("action") or "ask"),
        str(params.get("question") or ""), str(params.get("selection") or ""),
        params.get("selection_page"), prog,
        depth=str(params.get("depth") or "standard"))
    result["local"] = local
    return result


# ============================================================ 本地模型拉取

def run_ai_pull(params: dict, ctx) -> dict:
    model = str(params.get("model") or localai.DEFAULT_MODEL)
    localai.pull_model(
        model,
        progress=lambda pct, detail: ctx.progress(pct if pct is not None else ctx._task["progress"], detail),
        should_cancel=lambda: ctx._task["cancel"].is_set())
    cfg = localai.ensure_local_config()
    return {"ok": True, "model": model, "config": cfg and {k: cfg[k] for k in ("id", "name", "model")}}


# ============================================================ 本地 AI 插件（用户确认后安装）

def run_ai_pack_install(params: dict, ctx) -> dict:
    """仅当用户在界面确认后（confirmed=True）才下载安装；装进湛卢数据目录，可整目录删除。"""
    from .tasks import Cancelled  # noqa: F401

    if params.get("confirmed") is not True:
        raise pdfops.OpError("本地 AI 插件需要用户在设置中明确确认后才会安装。")
    localai.install_plugin(
        url=params.get("url"),
        progress=lambda pct, detail: ctx.progress(pct if pct is not None else ctx._task["progress"], detail),
        should_cancel=lambda: ctx._task["cancel"].is_set())
    result = localai.ensure_server()
    if result.get("running"):
        localai.ensure_local_config()
    return {"ok": True, "running": result.get("running", False),
            "exe": result.get("exe"), "note": "插件已安装到湛卢数据目录；删除该目录即完全卸载。"}


# ============================================================ OFD 预览与转 PDF

def _require_ofd(entry: dict) -> None:
    if entry["kind"] != "ofd":
        raise pdfops.OpError(f"仅支持 OFD 文件：{entry['name']}")


def _ofd_cached_pdf(p: Path, ctx=None, progress=None, should_cancel=None) -> tuple[Path, str]:
    """OFD→PDF 版式级转换，按内容 sha 缓存。返回 (pdf 路径, note)。
    版式转换失败时回落文本重建（note 标注），全部失败才报错。"""
    import hashlib

    digest = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    key = f"v4-{digest.hexdigest()}"  # 转换器或签章渲染修复后不复用旧版缓存。
    with _ofd_cache_guard:
        lock = _ofd_cache_locks.setdefault(key, threading.Lock())
    with lock:
        if ctx is not None:
            ctx.check()
        return _ofd_build_cache(p, key, ctx, progress, should_cancel)


def _ofd_build_cache(p: Path, key: str, ctx, progress, should_cancel) -> tuple[Path, str]:
    config.ensure_dirs()
    out = config.CACHE_OFD_DIR / f"{key}.pdf"
    metadata_path = out.with_suffix(".json")
    metadata = config.load_json(metadata_path, {})
    if out.exists() and out.stat().st_size > 0 and isinstance(metadata, dict) and isinstance(metadata.get("note"), str):
        return out, metadata["note"]

    tmp = (ctx.temp_root if ctx is not None else config.TEMP_DIR) / f"ofd-{key[:12]}.pdf"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    note = ""
    try:
        result = ofd.to_pdf(p, tmp, progress=progress, should_cancel=should_cancel)
        note = str(result.get("note") or "")
    except Cancelled:
        raise
    except Exception as exc:
        if ctx is not None:
            ctx.progress(0.5, "版式转换受限，回退文字重建")
        pages = ofd.text(p)
        if not any(pages):
            raise pdfops.OpError("该 OFD 未解析到文本内容，无法转换为 PDF。") from exc
        ofd.OfdDoc(p).to_pdf_text_rebuild(tmp)
        note = "文字重建版（该文件版式转换受限，仅保留文字）"
    os.replace(tmp, out)  # 缓存原子落位
    config.save_json(metadata_path, {"note": note})
    return out, note


def preview_ofd_convert(params: dict) -> dict:
    p, entry = _entry_path(params.get("id"))
    _require_ofd(entry)
    total = ofd.info(p).get("pages") or 0
    name = _safe_name(str(params.get("name") or Path(entry["name"]).stem + "-转换"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return _preview_result(params.get("dir"),
                           [{"name": name, "pages": total, "note": "版式级转换 · 文字/矢量/图片按原坐标"}],
                           f"1 个 PDF · {total} 页", sources=[entry])


def run_ofd_convert(params: dict, ctx) -> dict:
    p, entry = _entry_path(params.get("id"))
    _require_ofd(entry)
    name = _safe_name(str(params.get("name") or Path(entry["name"]).stem + "-转换"))
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    d = _resolve_dir(params.get("dir"), sources=[entry])
    _require_writable(d)
    ctx.progress(0.05, "解析 OFD")

    def prog(value, detail=""):
        ctx.progress(0.1 + 0.85 * value, detail)

    pdf_path, note = _ofd_cached_pdf(p, ctx=ctx, progress=prog,
                                     should_cancel=lambda: ctx._task["cancel"].is_set())
    ctx.check()
    entry_out = _deliver_numbered(pdf_path, d, name, ctx=ctx)
    ctx.output(entry_out)
    pages = int(pdfops.info(pdf_path)["pages"])
    store.set_pages(entry_out["id"], pages)
    return {"files": [dict(entry_out, pages=pages, note=note)], "note": note}


def run_ofd_preview(params: dict, ctx) -> dict:
    """打开 OFD 时自动触发：转换到预览缓存并登记内部文件（recent=False，不进最近文件）。"""
    p, entry = _entry_path(params.get("id"))
    _require_ofd(entry)

    def prog(value, detail=""):
        ctx.progress(0.1 + 0.85 * value, detail)

    pdf_path, note = _ofd_cached_pdf(p, ctx=ctx, progress=prog,
                                     should_cancel=lambda: ctx._task["cancel"].is_set())
    ctx.check()
    pages = int(pdfops.info(pdf_path)["pages"])
    stem = _safe_name(Path(entry["name"]).stem)
    cached = store.add_output(pdf_path, name=f"{stem}-预览.pdf",
                              display=f"{entry['name']} · PDF 预览", recent=False)
    store.set_pages(cached["id"], pages)
    return {"file": dict(cached, pages=pages), "note": note, "source": entry["id"]}


# ============================================================ 登记

_KINDS = {
    "split": ("拆分 PDF", preview_split, run_split),
    "merge": ("合并 PDF", preview_merge, run_merge),
    "organize": ("页面整理", preview_organize, run_organize),
    "convert_pdf": ("PDF 转换", preview_convert_pdf, run_convert_pdf),
    "images_pdf": ("图片转 PDF", preview_images_pdf, run_images_pdf),
    "convert_ofd": ("OFD 转 PDF", preview_ofd_convert, run_ofd_convert),
    "ofd_preview": ("OFD 预览转换", None, run_ofd_preview),
    "ocr": ("离线 OCR", preview_ocr, run_ocr),
    "ai_analyze": ("AI 阅读", None, run_ai_analyze),
    "ai_pull": ("下载本地模型", None, run_ai_pull),
    "ai_pack_install": ("安装本地 AI 插件", None, run_ai_pack_install),
    "ocr_pack_install": ("安装 OCR 模型插件", None, run_ocr_pack_install),
    "ocr_pack_uninstall": ("卸载 OCR 模型插件", None, run_ocr_pack_uninstall),
}

for _kind, (_label, _preview, _run) in _KINDS.items():
    hub.register(_kind, (lambda label: lambda params: label)(_label), _run)


def _cleanup_outputs(delivered: list[dict]) -> None:
    """取消/失败时删除已交付文件并从登记簿移除（不留半成品）。"""
    import os as _os

    for item in delivered:
        try:
            p = Path(item.get("path") or "")
            if p and p.is_file():
                p.unlink()
        except OSError:
            pass
        if item.get("id"):
            store.remove(item["id"])


def _cleanup_pending(pending: list[dict]) -> list[dict]:
    """按交付前指纹回收产物；内容已变化时保留文件供用户核对。"""
    unresolved = []
    for item in pending:
        path = item.get("path")
        digest = item.get("sha256")
        if not path or not digest:
            unresolved.append(item)
            continue
        p = Path(path)
        try:
            if p.exists():
                stat = p.stat()
                if (not p.is_file() or stat.st_size != item.get("size") or
                        ("inode" in item and (stat.st_dev, stat.st_ino) != (item["device"], item["inode"]))):
                    unresolved.append(item)
                    continue
                actual = hashlib.sha256()
                with p.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        actual.update(chunk)
                if actual.hexdigest() != digest:
                    unresolved.append(item)
                    continue
                p.unlink()
            store.remove_path(p)
        except OSError:
            unresolved.append(item)
        finally:
            staged_path = item.get("staged_path")
            if staged_path:
                staged = Path(staged_path)
                try:
                    stat = staged.stat()
                    if (stat.st_dev, stat.st_ino) == (item.get("device"), item.get("inode")):
                        staged.unlink()
                except OSError:
                    pass
    return unresolved


hub.cleanup_outputs = _cleanup_outputs
hub.cleanup_pending = _cleanup_pending
hub.reconcile_interrupted()


def preview(kind: str, params: dict) -> dict:
    if kind not in _KINDS:
        raise pdfops.OpError(f"未知任务类型: {kind}")
    _label, _preview, _run = _KINDS[kind]
    if _preview is None:
        return {"ok": True, "summary": _label, "outputs": [], "warnings": []}
    return _preview(params)
