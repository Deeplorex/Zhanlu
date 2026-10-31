"""File activation from the desktop parent's private stdin, never from HTTP paths."""

import json
import threading
import time
from pathlib import Path

from .core import pdfops

enabled = False
_lock = threading.Lock()
_files = []
_errors = []
_drops = []
_drop_requests = {}
_expired_drops = {}
_DROP_TTL = 600
_DROP_LIMIT = 64


def _register(paths, store, allow_images=False):
    files, errors = [], []
    for value in paths:
        try:
            path = Path(value).resolve(strict=True)
            allowed = (".pdf", ".ofd", ".png", ".jpg", ".jpeg") if allow_images else (".pdf", ".ofd")
            if not path.is_file() or path.suffix.lower() not in allowed:
                raise ValueError("请选择 PDF、OFD 或 PNG/JPEG 图片" if allow_images else "请选择 PDF 或 OFD 文件")
            stat = path.stat()
            entry = next((e for e in store.list() if e["path"] == str(path)
                          and e["mtime"] == stat.st_mtime and e["size"] == stat.st_size), None)
            entry = entry or store.add_path(path)
            if path.suffix.lower() == ".pdf" and not entry.get("pages"):
                try:
                    entry["pages"] = pdfops.info(path)["pages"]
                    store.set_pages(entry["id"], entry["pages"])
                except Exception:  # 加密或损坏文件由后续打开或任务流程说明
                    pass
            files.append(entry)
        except (OSError, ValueError, TypeError) as exc:
            errors.append(f"无法打开 {Path(str(value)).name}：{exc}")
    return files, errors


def receive(paths, store):
    files, errors = _register(paths, store)
    with _lock:
        _files.extend(files)
        _errors.extend(errors)


def receive_drop(drop_id, paths, store):
    """仅暂存私有 stdin 的路径；网页确认有效落点后才登记。"""
    if not isinstance(drop_id, str) or not drop_id or len(drop_id) > 128 or not isinstance(paths, list):
        return
    with _lock:
        _expire_drops()
        if drop_id in _drop_requests or drop_id in _expired_drops:
            return
        if len(_drop_requests) >= _DROP_LIMIT:
            done = next((key for key, item in _drop_requests.items() if item["state"] == "done"), None)
            pending = next((key for key, item in _drop_requests.items() if item["state"] == "pending"), None)
            if done is not None:
                del _drop_requests[done]
            elif pending is not None:
                del _drop_requests[pending]
                _fail_drop(pending, "等待处理的拖入文件过多，请重试。")
            else:
                _fail_drop(drop_id, "等待处理的拖入文件过多，请重试。")
                return
        _drop_requests[drop_id] = {"paths": list(paths), "state": "pending", "expires": time.monotonic() + _DROP_TTL}


def _fail_drop(drop_id, message):
    """调用方持有 _lock。"""
    _expired_drops[drop_id] = time.monotonic() + _DROP_TTL
    while len(_expired_drops) > _DROP_LIMIT * 2:
        _expired_drops.pop(next(iter(_expired_drops)))
    _drops.append({"id": drop_id, "files": [], "errors": [message]})
    del _drops[:-_DROP_LIMIT * 2]


def _expire_drops():
    """调用方持有 _lock。"""
    now = time.monotonic()
    for key, item in list(_drop_requests.items()):
        if item["expires"] <= now:
            del _drop_requests[key]
            if item["state"] == "pending":
                _fail_drop(key, "拖入文件等待确认超时，请重试。")
    for key, expires in list(_expired_drops.items()):
        if expires <= now:
            del _expired_drops[key]


def accept_drop(drop_id, store):
    """只接受已经由桌面 stdin 提供的 ID；未知 ID 不创建任何授权状态。"""
    if not isinstance(drop_id, str) or not drop_id or len(drop_id) > 128:
        return {"accepted": False}
    with _lock:
        _expire_drops()
        if drop_id in _expired_drops:
            return {"accepted": False, "expired": True}
        item = _drop_requests.get(drop_id)
        if item is None:
            return {"accepted": False}
        if item["state"] != "pending":
            return {"accepted": True}
        item["state"] = "processing"
        paths = item.pop("paths")

    def register():
        try:
            files, errors = _register(paths, store, allow_images=True)
        except Exception as exc:
            files, errors = [], [f"无法登记拖入文件：{exc}"]
        with _lock:
            _drops.append({"id": drop_id, "files": files, "errors": errors})
            del _drops[:-_DROP_LIMIT * 2]
            item = _drop_requests.get(drop_id)
            if item is not None:
                item["state"] = "done"

    threading.Thread(target=register, name="desktop-drop", daemon=True).start()
    return {"accepted": True}


def take_drops():
    with _lock:
        _expire_drops()
        result = list(_drops)
        _drops.clear()
        return result


def take():
    with _lock:
        result = {"files": list(_files), "errors": list(_errors)}
        _files.clear()
        _errors.clear()
        return result


def start(stream, store):
    global enabled
    enabled = True

    def read():
        for line in stream:
            try:
                paths = json.loads(line)
                if isinstance(paths, list):
                    receive(paths, store)
                elif isinstance(paths, dict) and paths.get("type") == "drop":
                    receive_drop(paths.get("id"), paths.get("paths"), store)
            except (ValueError, TypeError):
                continue

    threading.Thread(target=read, name="desktop-files", daemon=True).start()
