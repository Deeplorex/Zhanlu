"""表格提取：pdfplumber（本地算法）。复杂表格由 AI 通道兜底（见 ai.py）。"""

from __future__ import annotations

import csv
from pathlib import Path

try:
    import pdfplumber
    HAS_PDFPLUMBER = True
except ImportError:
    pdfplumber = None
    HAS_PDFPLUMBER = False

try:
    import openpyxl
    HAS_OPENPYXL = True
except ImportError:
    openpyxl = None
    HAS_OPENPYXL = False

from .pdfops import OpError, _reader, parse_pages

MAX_PAGES_PER_CALL = 20


def extract(path: Path, pages: str | None = None, password: str | None = None) -> list[dict]:
    """返回 [{page:1-based, tables: [rows...]}]，rows 为二维字符串数组。"""
    if not HAS_PDFPLUMBER:
        raise OpError("表格引擎未安装（pdfplumber 缺失）")
    total = len(_reader(path, password).pages)
    idx = parse_pages(pages, total) or list(range(total))
    idx = idx[:MAX_PAGES_PER_CALL]
    results: list[dict] = []
    with pdfplumber.open(str(path), password=password or "") as pdf:
        for i in idx:
            if i >= len(pdf.pages):
                continue
            tables = pdf.pages[i].extract_tables() or []
            rows_list = []
            for t in tables:
                rows_list.append([[("" if c is None else str(c).strip()) for c in row] for row in t])
            if rows_list:
                results.append({"page": i + 1, "tables": rows_list})
    return results


def export_csv(data: list[dict], out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        multi = sum(len(d["tables"]) for d in data) > 1
        for d in data:
            for ti, rows in enumerate(d["tables"], 1):
                if multi:
                    w.writerow([f"—— 第 {d['page']} 页 · 表 {ti} ——"])
                for row in rows:
                    w.writerow(row)
                if multi:
                    w.writerow([])
    return out


def export_xlsx(data: list[dict], out: Path) -> Path:
    if not HAS_OPENPYXL:
        raise OpError("Excel 导出未安装（openpyxl 缺失）")
    out.parent.mkdir(parents=True, exist_ok=True)
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    n = 0
    for d in data:
        for ti, rows in enumerate(d["tables"], 1):
            n += 1
            ws = wb.create_sheet(f"P{d['page']}T{ti}"[:31])
            for row in rows:
                ws.append(row)
    if n == 0:
        raise OpError("所选页面未检测到表格，请调整页码范围。")
    wb.save(out)
    return out
