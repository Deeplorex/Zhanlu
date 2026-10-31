"""文件登记簿：上传与生成的文件都注册为 id，全应用用 id 引用。

两档条目：
- recent=True（用户打开/上传的文档）：进入「最近文件」列表，按注册时间保留 50 条。
- recent=False（批量任务输出，如逐页 PNG）：可按 id 下载/打开，但不进最近列表，
  按注册时间最多保留 300 条，避免上千个输出把用户文档挤出登记簿。
"""

import hashlib
import threading
import time
import uuid
from pathlib import Path

from . import config


def _sha_of(path: Path) -> str | None:
    """文件内容 sha256；读取失败（不存在等）返回 None。"""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None

KIND_BY_EXT = {
    ".pdf": "pdf",
    ".ofd": "ofd",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".bmp": "image",
    ".tif": "image",
    ".tiff": "image",
    ".txt": "txt",
    ".md": "md",
    ".markdown": "md",
    ".docx": "docx",
    ".doc": "docx",
    ".xlsx": "xlsx",
    ".csv": "csv",
    ".xls": "xlsx",
    ".pptx": "pptx",
    ".ppt": "pptx",
}
MAX_RECENT = 50
MAX_OUTPUTS = 300


def kind_of(name: str) -> str:
    return KIND_BY_EXT.get(Path(name).suffix.lower(), "other")


def source_dir_of(entry: dict | None) -> Path | None:
    """可信源目录（06 改版「与源文件同目录」）：真实路径登记条目的父目录。
    浏览器上传保存在 inbox 的副本不是用户的源目录，返回 None。"""
    if not entry or not entry.get("path"):
        return None
    try:
        p = Path(entry["path"]).resolve()
    except OSError:
        return None
    try:
        p.relative_to(config.INBOX_DIR.resolve())
        return None
    except ValueError:
        return p.parent


class Store:
    def __init__(self):
        config.ensure_dirs()
        self._lock = threading.RLock()
        self._reg: dict = config.load_json(config.REGISTRY_FILE, {})

    def _save(self):
        config.save_json(config.REGISTRY_FILE, self._reg)

    def add_path(self, path: Path, name: str | None = None, recent: bool = True) -> dict:
        """登记一个本机已存在的文件（不复制）。"""
        path = Path(path).resolve()
        fid = uuid.uuid4().hex[:10]
        entry = {
            "id": fid,
            "path": str(path),
            "name": name or path.name,
            "kind": kind_of(path.name),
            "size": path.stat().st_size if path.exists() else 0,
            "mtime": path.stat().st_mtime if path.exists() else time.time(),
            "added_at": time.time(),
            "recent": bool(recent),
        }
        with self._lock:
            self._reg[fid] = entry
            self._trim()
            self._save()
        return dict(entry)

    def add_bytes(self, data: bytes, name: str) -> dict:
        """保存上传内容到 inbox 并登记。"""
        config.ensure_dirs()
        fid = uuid.uuid4().hex[:10]
        safe = re_safe_name(name)
        path = config.INBOX_DIR / f"{fid}_{safe}"
        with open(path, "wb") as f:
            f.write(data)
        return self.add_path(path, name=safe)

    def add_bytes_from(self, tmp_path, name: str, dedupe: bool = False) -> dict:
        """把已落盘的上传临时文件移入 inbox 并登记（流式上传路径）。

        dedupe=True 时只在上传副本中按内容（sha256）查找：重复上传返回原条目。
        本机路径或任务产物即使内容相同，也不能作为上传文件的可信来源。
        """
        import shutil

        tmp = Path(tmp_path)
        sha = _sha_of(tmp) if dedupe else None
        with self._lock:
            if sha:
                hit = self.find_by_sha(sha)
                if hit:
                    tmp.unlink(missing_ok=True)
                    return hit
            config.ensure_dirs()
            fid = uuid.uuid4().hex[:10]
            safe = re_safe_name(name)
            dest = config.INBOX_DIR / f"{fid}_{safe}"
            shutil.move(str(tmp), str(dest))
            entry = self.add_path(dest, name=safe)
            if entry["id"] in self._reg:
                sha = sha or _sha_of(dest)
                if sha:
                    self._reg[entry["id"]]["sha"] = sha
                    self._save()
                    entry["sha"] = sha
            return entry

    def find_by_sha(self, sha: str) -> dict | None:
        """仅在存在的上传副本中查找；旧条目缺 sha 时回读文件补算并缓存。"""
        with self._lock:
            entries = [dict(e) for e in self._reg.values()
                       if source_dir_of(e) is None and Path(e.get("path") or "").is_file()]
        for e in entries:
            if e.get("sha") == sha:
                return e
        for e in entries:
            if e.get("sha"):
                continue
            if self._entry_sha(e) == sha:
                return e
        return None

    def _entry_sha(self, entry: dict) -> str | None:
        """读取条目文件的 sha256 并缓存进登记簿；文件缺失返回 None。"""
        sha = entry.get("sha")
        if sha:
            return sha
        p = Path(entry.get("path") or "")
        if not p.is_file():
            return None
        sha = _sha_of(p)
        if sha and entry.get("id") in self._reg:
            with self._lock:
                if entry["id"] in self._reg:
                    self._reg[entry["id"]]["sha"] = sha
                    self._save()
        return sha

    def add_output(self, path: Path, name: str | None = None, display: str | None = None,
                   recent: bool | None = None) -> dict:
        """登记一个生成产物。display 是给用户看的名字；recent 默认按是否文档类分档。"""
        p = Path(path)
        if recent is None:
            recent = kind_of(p.name) in ("pdf", "ofd", "txt", "md")
        entry = self.add_path(p, name=name or p.name, recent=recent)
        if display:
            with self._lock:
                if entry["id"] in self._reg:
                    self._reg[entry["id"]]["display"] = display
                    self._save()
                    entry["display"] = display
        return dict(entry)

    def get(self, fid: str) -> dict | None:
        with self._lock:
            entry = self._reg.get(fid)
            return dict(entry) if entry else None

    def path_of(self, fid: str) -> Path:
        entry = self.get(fid)
        if not entry:
            raise KeyError(f"未知文件 id: {fid}")
        p = Path(entry["path"])
        if not p.exists():
            raise FileNotFoundError(f"文件已不存在: {entry['name']}")
        return p

    def list(self, recent_only: bool = True) -> list[dict]:
        with self._lock:
            items = [dict(e) for e in self._reg.values()
                     if (not recent_only) or e.get("recent", True)]
            items.sort(key=lambda e: -e.get("added_at", e.get("mtime", 0)))
            return items

    def remove(self, fid: str) -> bool:
        with self._lock:
            if fid in self._reg:
                del self._reg[fid]
                self._save()
                return True
            return False

    def remove_path(self, path: Path) -> int:
        """仅供回收任务产物：移除精确指向该路径的登记项。"""
        target = Path(path).resolve()
        with self._lock:
            ids = [fid for fid, entry in self._reg.items()
                   if Path(entry.get("path") or "").resolve() == target]
            for fid in ids:
                del self._reg[fid]
            if ids:
                self._save()
            return len(ids)

    def set_pages(self, fid: str, pages: int):
        with self._lock:
            if fid in self._reg:
                self._reg[fid]["pages"] = pages
                self._save()

    def _trim(self):
        """两档各自按注册时间截断（文件 mtime 与注册顺序无关）。"""
        def key(kv):
            return -kv[1].get("added_at", kv[1].get("mtime", 0))

        recent = sorted(((k, v) for k, v in self._reg.items() if v.get("recent", True)), key=key)
        outputs = sorted(((k, v) for k, v in self._reg.items() if not v.get("recent", True)), key=key)
        self._reg = dict(recent[:MAX_RECENT] + outputs[:MAX_OUTPUTS])


def re_safe_name(name: str) -> str:
    keep = [c if (c.isalnum() or c in "._-()（）【】[]+-" or '\u4e00' <= c <= '\u9fff') else "_" for c in name]
    safe = "".join(keep).lstrip(".")[:120] or "file"
    return safe
