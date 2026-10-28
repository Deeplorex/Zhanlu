"""OFD（GB/T 33190）轻量解析：文档信息 / 目录 / 文本，及文本重建转 PDF（实验）。

OFD 是 ZIP + XML：OFD.xml → DocRoot(Document.xml) → Pages/Page@BaseLoc。
本模块用标准库做尽力解析，任何结构异常都以带 note 的部分结果返回，不抛中断。
"""

from __future__ import annotations

import posixpath
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

    def to_pdf(self, out: Path) -> Path:
        pages = self.text_pages()
        if not any(pages):
            raise OpError("该 OFD 未解析到文本，无法文本重建为 PDF")
        title = self.doc_info.get("Title") or self.path.stem
        return topdf.pages_text_to_pdf(pages, out, title=title)


def info(path: Path) -> dict:
    doc = OfdDoc(path)
    result = doc.info()
    result["outline"] = doc.outline()
    result["note"] = "OFD 轻量解析（实验）：支持信息/目录/文本；版式渲染暂不可用"
    return result


def text(path: Path) -> list[str]:
    return OfdDoc(path).text_pages()


def outline(path: Path) -> list[dict]:
    return OfdDoc(path).outline()


def to_pdf(path: Path, out: Path) -> Path:
    return OfdDoc(path).to_pdf(out)
