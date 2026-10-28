"""外部引擎检测与能力总览：湛卢本体零依赖，能力按本机实际情况汇报。"""

from __future__ import annotations

import shutil
from pathlib import Path

from . import config
from .core import ai, ocrpdf, pdfops, tables, topdf
from .core.document_ai import is_local_model

_WIN_OFFICE_PATHS = [
    r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE",
    r"C:\Program Files (x86)\Microsoft Office\root\Office16\WINWORD.EXE",
    r"C:\Program Files\Microsoft Office\Office16\WINWORD.EXE",
    r"C:\Program Files (x86)\Microsoft Office\Office16\WINWORD.EXE",
    r"C:\Program Files\Microsoft Office\Office15\WINWORD.EXE",
]
_WIN_LO_PATHS = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]


def detect_office() -> dict:
    path = None
    try:
        import winreg  # type: ignore

        for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(root, r"Software\Microsoft\Windows\CurrentVersion\App Paths\Winword.exe") as k:
                    path = winreg.QueryValueEx(k, "")[0]
                    break
            except OSError:
                continue
    except ImportError:
        pass
    if not path:
        for p in _WIN_OFFICE_PATHS:
            if Path(p).exists():
                path = p
                break
    return {"name": "本机 Office", "available": bool(path), "path": path}


def detect_libreoffice() -> dict:
    path = shutil.which("soffice")
    if not path:
        for p in _WIN_LO_PATHS:
            if Path(p).exists():
                path = p
                break
    return {"name": "LibreOffice", "available": bool(path), "path": path}


def snapshot() -> dict:
    office = detect_office()
    lo = detect_libreoffice()
    ai_cfg = ai.active_config()
    s = config.load_settings()
    return {
        "office": office,
        "libreoffice": lo,
        "ai": {
            "configured": bool(ai_cfg and (is_local_model(ai_cfg) or ai_cfg.get("key"))),
            "count": len(s["ai"]["configs"]),
            "active_name": (ai_cfg or {}).get("name"),
        },
        "ocr": {
            "engine": s["ocr"].get("engine", "rapid"),
            "tier": ocrpdf.active_tier(),
            "plugin": ocrpdf.plugin_status(),
            "providers": [
                {"id": "rapid-standard", "name": "离线 OCR · 标准档（PP-OCRv6，约 30 MB）",
                 "available": ocrpdf.plugin_status()["tiers"]["standard"] or ocrpdf._pkg_models_ok()},
                {"id": "rapid-advanced", "name": "离线 OCR · 高级档（PP-OCRv5 server，约 165 MB，更准更慢）",
                 "available": ocrpdf.plugin_status()["tiers"]["advanced"]},
            ],
        },
        "libs": {
            "render": pdfops.HAS_PDFIUM,
            "tables": tables.HAS_PDFPLUMBER,
            "xlsx": tables.HAS_OPENPYXL,
            "images2pdf": True,
            "genpdf": True,
            "encrypt": pdfops.HAS_CRYPTO,
        },
    }


def convert_targets() -> list[dict]:
    """前端转换中心的目标格式矩阵。"""
    snap = snapshot()
    office_pdf = snap["office"]["available"] or snap["libreoffice"]["available"]

    def t(target, engine, available, note=""):
        return {"target": target, "engine": engine, "available": available, "note": note}

    return {
        "pdf": [
            t("txt", "内置", True),
            t("md", "内置", True),
            t("png", "渲染引擎", snap["libs"]["render"]),
            t("jpg", "渲染引擎", snap["libs"]["render"]),
            t("xlsx", "表格引擎", snap["libs"]["tables"] and snap["libs"]["xlsx"]),
            t("csv", "表格引擎", snap["libs"]["tables"]),
            t("docx", "AI 版式增强", snap["ai"]["configured"], "需配置 AI 模型；复杂版式还原效果取决于模型"),
            t("pptx", "AI 版式增强", snap["ai"]["configured"], "需配置 AI 模型"),
            t("ofd", "ofdrw 插件", False, "插件体系提供，当前未安装"),
        ],
        "ofd": [
            t("pdf", "内置（文本重建·实验）", True),
        ],
        "image": [t("pdf", "img2pdf", True)],
        "txt": [t("pdf", "内置", True)],
        "md": [t("pdf", "内置", True)],
        "docx": [t("pdf", "本机 Office / LibreOffice", office_pdf, "未检测到可用引擎" if not office_pdf else "")],
        "xlsx": [t("pdf", "本机 Office / LibreOffice", office_pdf, "未检测到可用引擎" if not office_pdf else "")],
        "pptx": [t("pdf", "本机 Office / LibreOffice", office_pdf, "未检测到可用引擎" if not office_pdf else "")],
    }
