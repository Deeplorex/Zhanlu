"""湛卢本地服务：JSON API + 静态前端。

安全边界（S01）：
- 仅监听 127.0.0.1；API 需要会话令牌（Cookie 或 X-Zhanlu-Token 头）；
- 带外部 Origin 的请求一律拒绝，本地回环 Origin 才放行；
- 文件一律通过登记 id 引用；上传走 multipart 落盘 inbox/。
"""

from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
import re
import subprocess
import threading
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import APP_NAME_EN, APP_NAME_ZH, __version__, config, desktop, engines, jobs, localai
from .auth import COOKIE_NAME, Auth
from .core import ai, document_ai, ofd, pdfops
from .store import source_dir_of
from .tasks import TaskHub  # noqa: F401 — re-export for tests

WEB_DIR = Path(os.environ.get("ZHANLU_WEB") or
               (Path(__file__).resolve().parents[2] / "apps" / "web" / "dist")).resolve()
MAX_BODY = 512 * 1024 * 1024  # 512 MB 上传上限

auth = Auth()
store = jobs.store
hub = jobs.hub

INSTANCE_ID = uuid.uuid4().hex[:12]

_thumb_sem = threading.Semaphore(2)  # 并发缩略图渲染限制
_thumb_file_locks: dict[str, threading.Lock] = {}
_thumb_locks_guard = threading.Lock()


def _thumb_lock(key: str) -> threading.Lock:
    with _thumb_locks_guard:
        if key not in _thumb_file_locks:
            _thumb_file_locks[key] = threading.Lock()
        return _thumb_file_locks[key]


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- 输出

def _entry_out(entry: dict) -> dict:
    # path 供前端悬停区分同名文件（本机应用内使用，不出网）；source_dir 为可信源目录（同目录保存用）
    out = {k: entry.get(k) for k in ("id", "name", "kind", "size", "mtime", "pages", "path")}
    sd = source_dir_of(entry)
    out["source_dir"] = str(sd) if sd else None
    if entry.get("display"):
        out["name"] = entry["display"]
    return out


def _path_of(fid, key="id") -> tuple[Path, dict]:
    entry = store.get(str(fid))
    if not entry:
        raise ApiError(404, f"未知文件 id: {fid}")
    p = Path(entry["path"])
    if not p.exists():
        raise ApiError(410, f"文件已不存在: {entry['name']}")
    return p, entry


# ---------------------------------------------------------------- API：应用

def api_app_info(_q, _b) -> dict:
    s = config.load_settings()
    return {
        "name": {"zh": APP_NAME_ZH, "en": APP_NAME_EN},
        "display": config.display_name(s),
        "version": __version__,
        "instance": INSTANCE_ID,
        "desktop_input": desktop.enabled,
        "lang": s.get("lang", "auto"),
        "out_dir": str(config.OUT_DIR),
        "ocr_available": jobs.ocrpdf.available(),
        "ocr_tier": jobs.ocrpdf.active_tier(),
        "ocr_plugin": jobs.ocrpdf.plugin_status(),
        "local_ai": localai.status(),
    }


def api_ocr_pack(_q, body) -> dict:
    if body and body.get("uninstall"):
        result = jobs.ocrpdf.uninstall(body.get("tier"))
        return {"ok": True, **result, "status": jobs.ocrpdf.plugin_status()}
    return jobs.ocrpdf.plugin_status()


def api_engines(_q, _b) -> dict:
    snap = engines.snapshot()
    snap["targets"] = engines.convert_targets()
    return snap


# ---------------------------------------------------------------- API：文件

def api_files_list(_q, _b) -> dict:
    return {"files": [_entry_out(e) for e in store.list()]}


def api_desktop_open_files(_q, _b) -> dict:
    result = desktop.take()
    return {"files": [_entry_out(e) for e in result["files"]], "errors": result["errors"]}


def api_desktop_drop_files(_q, _b) -> dict:
    return {"drops": [{"id": d["id"], "files": [_entry_out(e) for e in d["files"]],
                        "errors": d["errors"]} for d in desktop.take_drops()]}


def api_desktop_drop_accept(_q, body) -> dict:
    # 不接收路径；只有桌面壳私有输入登记的随机 ID 可被确认。
    if not isinstance(body, dict) or set(body) != {"id"}:
        raise ApiError(400, "仅支持确认拖放事件 ID")
    return desktop.accept_drop(body.get("id"), store)


def api_file_info(fid: str, q) -> dict:
    p, entry = _path_of(fid)
    result = _entry_out(entry)
    if entry["kind"] == "pdf":
        try:
            info = pdfops.info(p)
        except pdfops.OpError as exc:
            if "加密" in str(exc):
                return dict(result, encrypted=True, outline=[])
            raise
        if entry.get("pages") != info["pages"]:
            store.set_pages(fid, info["pages"])
            entry["pages"] = info["pages"]
            result["pages"] = info["pages"]
        result.update(info)
        result["outline"] = pdfops.outline(p)
        if q.get("probe") == "text":
            stats = pdfops.text_page_stats(p, sample_limit=min(info["pages"], 6))
            result["text_pages_sampled"] = len(stats["text_pages"])
            result["sampled"] = stats["checked"]
    elif entry["kind"] == "ofd":
        result.update(ofd.info(p))
    return result


def api_file_delete(fid: str) -> dict:
    return {"ok": store.remove(fid)}


def api_file_raw(fid: str, q) -> tuple[bytes, str, str]:
    p, entry = _path_of(fid)
    data = p.read_bytes()
    mime = mimetypes.guess_type(entry["name"])[0] or "application/octet-stream"
    disp = "attachment" if q.get("dl") else "inline"
    quoted = urllib.parse.quote(entry["name"])
    return data, mime, f"{disp}; filename*=UTF-8''{quoted}"


def api_file_thumb(fid: str, q) -> bytes:
    p, entry = _path_of(fid)
    if entry["kind"] != "pdf":
        raise ApiError(501, "该格式暂不支持缩略图")
    page = int(q.get("page", 1) or 1)
    dpi = min(int(q.get("dpi", 60) or 60), 120)
    key = f"{fid}_p{page}_d{dpi}.png"
    cache = config.THUMB_DIR / key
    if cache.is_file():
        return cache.read_bytes()
    with _thumb_sem, _thumb_lock(fid):  # PDFium 非线程安全：同一文档必须串行渲染
        if cache.is_file():
            return cache.read_bytes()
        data = pdfops.thumb(p, page, dpi)
        try:
            cache.write_bytes(data)
        except OSError:
            pass
    return data


# ---------------------------------------------------------------- API：任务

def api_jobs_preview(_q, body) -> dict:
    try:
        return jobs.preview(str(body.get("kind") or ""), body.get("params") or {})
    except pdfops.OpError as exc:
        return {"ok": False, "error": str(exc)}


def api_jobs_run(_q, body) -> dict:
    kind = str(body.get("kind") or "")
    params = body.get("params") or {}
    if kind not in jobs._KINDS:
        raise ApiError(400, f"未知任务类型: {kind}")
    return hub.submit(kind, params)


def api_tasks(_q, _b) -> dict:
    return {"tasks": hub.list()}


def api_task_get(tid: str) -> dict:
    t = hub.get(tid)
    if not t:
        raise ApiError(404, "任务不存在")
    return t


def api_task_cancel(tid: str) -> dict:
    if not hub.cancel(tid):
        raise ApiError(409, "任务不在运行中，无法取消")
    return {"ok": True}


def api_task_retry(tid: str) -> dict:
    try:
        return hub.retry(tid)
    except KeyError as exc:
        raise ApiError(404, str(exc)) from exc
    except ValueError as exc:
        raise ApiError(409, str(exc)) from exc


def api_task_clear(tid: str) -> dict:
    return {"ok": hub.clear(tid)}


def api_tasks_clear(_q, _b) -> dict:
    return {"ok": True, "count": hub.clear_finished()}


# ---------------------------------------------------------------- API：系统

# 弹窗宿主 powershell.exe 不带 DPI 感知清单，>100% 缩放时整窗被位图拉伸发虚；
# 弹窗前把该进程声明为按显示器 DPI 感知（已声明过时调用失败，忽略返回值即可）。
_PS_DPI_AWARE = (
    "Add-Type -Namespace Zhanlu -Name Dpi -MemberDefinition"
    " '[DllImport(\"shcore.dll\")] public static extern int SetProcessDpiAwareness(int value);' | Out-Null;"
    " [Zhanlu.Dpi]::SetProcessDpiAwareness(2) | Out-Null;"
)

_PS_PICK_FOLDER = _PS_DPI_AWARE + (
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null;"
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
    "$d.Description = '选择湛卢 PDF 的保存位置';"
    "$d.ShowNewFolderButton = $true;"
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)"
    "{ Write-Output $d.SelectedPath }"
)

_PS_PICK_PDFS = _PS_DPI_AWARE + (
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null;"
    "$d = New-Object System.Windows.Forms.OpenFileDialog;"
    "$d.Title = '打开 PDF 或 OFD';"
    "$d.Filter = 'PDF 和 OFD 文档|*.pdf;*.ofd';"
    "$d.Multiselect = $true;"
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)"
    "{ Write-Output $d.FileNames }"
)

_PS_PICK_CONVERT = _PS_PICK_PDFS.replace(
    "$d.Filter = 'PDF 和 OFD 文档|*.pdf;*.ofd';",
    "$d.Filter = 'PDF、OFD 和图片|*.pdf;*.ofd;*.png;*.jpg;*.jpeg';",
).replace("$d.Title = '打开 PDF 或 OFD';", "$d.Title = '选择 PDF、OFD 或图片';")


def _register_picked(paths: list[str], allow_images: bool = False) -> tuple[list[dict], list[str]]:
    """把用户在原生对话框里亲自选择的路径按可信通道登记真实位置（06 改版 §2：
    与源文件同目录依赖真实源路径；HTTP 请求体从不携带路径，边界不变）。
    path+mtime+size 命中已有登记时复用，避免重复登记同一文件。"""
    entries: list[dict] = []
    errors: list[str] = []
    for value in paths:
        try:
            p = Path(str(value)).resolve(strict=True)
            allowed = {".pdf", ".ofd", ".png", ".jpg", ".jpeg"} if allow_images else {".pdf", ".ofd"}
            if not p.is_file() or p.suffix.lower() not in allowed:
                raise ValueError("请选择 PDF、OFD 或 PNG/JPEG 图片" if allow_images else "请选择 PDF 或 OFD 文件")
            stat = p.stat()
            entry = next(
                (e for e in store.list()
                 if e["path"] == str(p) and e["mtime"] == stat.st_mtime and e["size"] == stat.st_size),
                None)
            entry = entry or store.add_path(p)
            if p.suffix.lower() == ".pdf" and not entry.get("pages"):
                try:
                    entry["pages"] = pdfops.info(p)["pages"]
                    store.set_pages(entry["id"], entry["pages"])
                except Exception:  # 加密或损坏的文件仍可交由后续流程提示
                    pass
            entries.append(entry)
        except (OSError, ValueError) as exc:
            errors.append(f"无法打开 {Path(str(value)).name}：{exc}")
    return entries, errors


def api_pick_pdfs(_q, body) -> dict:
    """用户通过系统对话框选择文件；路径只由引擎取得并登记。"""
    kind = body.get("kind", "pdf")
    if kind not in ("pdf", "convert"):
        raise ApiError(400, "不支持的文件选择类型")
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", _PS_PICK_CONVERT if kind == "convert" else _PS_PICK_PDFS],
            capture_output=True, text=True, timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ApiError(500, f"无法打开文件选择：{exc}") from exc
    if out.returncode:
        raise ApiError(500, "无法打开文件选择，请重试")
    picked = [line.strip() for line in (out.stdout or "").splitlines() if line.strip()]
    if not picked:
        return {"files": [], "errors": [], "cancelled": True}
    entries, errors = _register_picked(picked, allow_images=kind == "convert")
    return {"files": [_entry_out(e) for e in entries], "errors": errors, "cancelled": False}


def api_pick_folder(_q, _b) -> dict:
    """系统目录选择对话框（授权保存位置）。"""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", _PS_PICK_FOLDER],
            capture_output=True, text=True, timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ApiError(500, f"无法打开目录选择：{exc}") from exc
    path = (out.stdout or "").strip()
    if not path:
        return {"path": None, "cancelled": True}
    p = Path(path)
    if not p.is_dir():
        raise ApiError(500, "选择的目录不可用")
    return {"path": str(p), "cancelled": False}


def api_open_path(_q, body) -> dict:
    """仅定位已登记文件，不接受调用方提供的任意本机路径。"""
    fid = body.get("id")
    if not fid:
        raise ApiError(400, "缺少文件 id")
    p, _entry = _path_of(fid)
    if not p.exists():
        raise ApiError(404, "路径不存在")
    if p.is_dir():
        os.startfile(str(p))  # type: ignore[attr-defined]
    else:
        subprocess.run(["explorer", "/select,", str(p)], check=False)
    return {"ok": True}


# ---------------------------------------------------------------- API：AI

def api_ai_configs(_q, body) -> dict:
    if body is None:
        s = config.load_settings()
        return {"configs": ai.list_configs(), "protocols": ai.PROTOCOLS,
                "prefer": s["ai"].get("prefer") or "cloud"}
    result = ai.save_configs(body)
    s = config.load_settings()
    return {"ok": True, "configs": ai.list_configs(), "prefer": s["ai"].get("prefer") or "cloud", **result}


def api_ai_test(_q, body) -> dict:
    cfg_full = None
    if body.get("configId"):
        for c in config.load_settings()["ai"]["configs"]:
            if c["id"] == body["configId"]:
                cfg_full = {**c, "key_plain": ai.deobfuscate(c.get("key", ""))}
                break
    if cfg_full is None:
        raise ApiError(404, "未找到该配置")
    return ai.test_config(cfg_full)


def api_ai_scope(_q, body) -> dict:
    """Show the actual local text range before a remote model receives it."""
    p, _entry = _path_of(body.get("id"))
    try:
        return document_ai.sending_scope(
            p, str(body.get("action") or ""),
            str(body.get("question") or ""), str(body.get("selection") or ""),
            body.get("selection_page"))
    except ValueError as exc:
        # 用户可见的输入问题（如"请先完成 OCR"）按 400 返回，不裹"内部错误"
        raise ApiError(400, str(exc)) from exc


def api_ai_active(_q, body) -> dict:
    s = config.load_settings()
    if body is not None and "active" in body:
        # 允许显式清除（active=None → 按通道优先级自动选择）
        s["ai"]["active"] = body["active"] or None
        config.save_settings(s)
    s = config.load_settings()
    effective = ai.active_config()
    return {"active": s["ai"].get("active"),
            "effective": effective and effective.get("id"),
            "effective_name": effective and effective.get("name")}


def api_ai_local(_q, body) -> dict:
    if body and body.get("ensure"):
        result = localai.ensure_server()
        if result.get("running"):
            cfg = localai.ensure_local_config()
            result["config"] = cfg and {k: cfg[k] for k in ("id", "name", "model")}
    elif body and body.get("uninstall"):
        result = localai.uninstall_plugin()
        result.update(localai.status())
    else:
        result = localai.status()
    return result


# ---------------------------------------------------------------- 路由表

JSON_ROUTES: dict = {
    ("GET", "/api/app-info"): api_app_info,
    ("GET", "/api/engines"): api_engines,
    ("GET", "/api/files"): api_files_list,
    ("GET", "/api/desktop/open-files"): api_desktop_open_files,
    ("GET", "/api/desktop/drop-files"): api_desktop_drop_files,
    ("POST", "/api/desktop/drop-accept"): api_desktop_drop_accept,
    ("GET", "/api/tasks"): api_tasks,
    ("POST", "/api/tasks/clear"): api_tasks_clear,
    ("POST", "/api/jobs/preview"): api_jobs_preview,
    ("POST", "/api/jobs/run"): api_jobs_run,
    ("POST", "/api/sys/pick-folder"): api_pick_folder,
    ("POST", "/api/sys/pick-pdfs"): api_pick_pdfs,
    ("POST", "/api/sys/open-path"): api_open_path,
    ("GET", "/api/ai/configs"): lambda q, b: api_ai_configs(q, None),
    ("POST", "/api/ai/configs"): api_ai_configs,
    ("POST", "/api/ai/test"): api_ai_test,
    ("POST", "/api/ai/scope"): api_ai_scope,
    ("GET", "/api/ai/active"): lambda q, b: api_ai_active(q, None),
    ("POST", "/api/ai/active"): api_ai_active,
    ("GET", "/api/ai/local"): lambda q, b: api_ai_local(q, None),
    ("POST", "/api/ai/local"): api_ai_local,
    ("GET", "/api/ocr-pack"): lambda q, b: api_ocr_pack(q, None),
    ("POST", "/api/ocr-pack"): api_ocr_pack,
}

RE_FILE = re.compile(r"^/api/files/([^/]+)/?$")
RE_FILE_INFO = re.compile(r"^/api/files/([^/]+)/info$")
RE_FILE_RAW = re.compile(r"^/api/files/([^/]+)/raw$")
RE_FILE_THUMB = re.compile(r"^/api/files/([^/]+)/thumb$")
RE_TASK = re.compile(r"^/api/tasks/([^/]+)/(cancel|retry|clear)/?$")
RE_TASK_GET = re.compile(r"^/api/tasks/([^/]+)/?$")

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = f"Zhanlu/{__version__}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静模式
        pass

    # ---- 基础响应 ----

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _err(self, status: int, message: str):
        self._json({"error": message}, status)

    # ---- 鉴权 ----

    def _guard(self, q: dict) -> bool:
        """API 统一闸门：Host/Origin 白名单 + 会话令牌。失败时已写响应并返回 False。"""
        if not auth.host_ok(self.headers.get("Host")):
            self._err(403, "拒绝访问")
            return False
        if not auth.origin_ok(self.headers.get("Origin")):
            self._err(403, "拒绝跨站访问")
            return False
        if not auth.authorized(self.headers, q.get("token")):
            self._err(401, "缺少有效会话令牌")
            return False
        return True

    # ---- 请求体 ----

    def _read_body_to_file(self) -> Path:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ApiError(400, "空请求体")
        if length > MAX_BODY:
            raise ApiError(413, f"文件过大（上限 {MAX_BODY // (1024 * 1024)} MB）")
        tmp = config.TEMP_DIR / f"upload-{uuid.uuid4().hex[:10]}"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        received = 0
        with open(tmp, "wb") as f:
            while received < length:
                chunk = self.rfile.read(min(1024 * 1024, length - received))
                if not chunk:
                    raise ApiError(400, "上传中断")
                f.write(chunk)
                received += len(chunk)
        return tmp

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError
            return data
        except (ValueError, UnicodeDecodeError) as exc:
            raise ApiError(400, "请求体不是有效 JSON") from exc

    def _multipart_files(self) -> tuple[dict, list[dict]]:
        """流式落盘的 multipart：返回 (fields, [{name, path, size}])。"""
        tmp = self._read_body_to_file()
        ctype = self.headers.get("Content-Type", "")
        m = re.search(r'boundary="?([^";]+)"?', ctype)
        if not m:
            tmp.unlink(missing_ok=True)
            raise ApiError(400, "multipart 缺少 boundary")
        boundary = ("--" + m.group(1)).encode()
        fields: dict = {}
        files: list[dict] = []
        with open(tmp, "rb") as f:
            payload = f.read()
        tmp.unlink(missing_ok=True)
        for part in payload.split(boundary):
            if part.startswith(b"\r\n"):
                part = part[2:]
            if not part or part == b"--":
                continue
            if part.endswith(b"--\r\n"):
                part = part[:-4]
            elif part.endswith(b"\r\n"):
                part = part[:-2]
            if b"\r\n\r\n" not in part:
                continue
            head, _, body = part.partition(b"\r\n\r\n")
            head_text = head.decode("utf-8", "ignore")
            name_m = re.search(r'name="([^"]*)"', head_text)
            file_m = re.search(r'filename="([^"]*)"', head_text)
            if not name_m:
                continue
            if file_m and file_m.group(1):
                fname = file_m.group(1)
                fpath = config.TEMP_DIR / f"part-{uuid.uuid4().hex[:8]}"
                with open(fpath, "wb") as out:
                    out.write(body)
                files.append({"name": fname, "path": fpath, "size": len(body)})
            else:
                fields[name_m.group(1)] = body.decode("utf-8", "ignore")
        return fields, files

    # ---- 分发 ----

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        self._err(403, "不支持跨域")

    def _dispatch(self, method: str):
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            q = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}

            # 首页种 Cookie：/?token=…
            if method == "GET" and path == "/" and q.get("token"):
                self._serve_index(set_cookie_token=q["token"])
                return

            # 静态资源（不含用户数据）不需要令牌
            if method == "GET" and not path.startswith("/api/"):
                return self._static(path)

            # 以下全部是 API：统一闸门
            if not self._guard(q):
                return

            if method == "POST" and path == "/api/files/upload":
                _fields, files = self._multipart_files()
                # 上传链路按内容去重：同一文件重复上传返回原登记，同一文件仅能打开一次
                entries = [store.add_bytes_from(f["path"], f["name"], dedupe=True) for f in files]
                for e in entries:
                    if e["kind"] == "pdf":
                        try:
                            e["pages"] = pdfops.info(Path(e["path"]))["pages"]
                            store.set_pages(e["id"], e["pages"])
                        except Exception:  # noqa: BLE001
                            pass
                return self._json({"files": [_entry_out(e) for e in entries]})

            m = RE_FILE_RAW.match(path)
            if m and method == "GET":
                return self._serve_file_range(m.group(1), q)
            m = RE_FILE_THUMB.match(path)
            if m and method == "GET":
                return self._bytes(api_file_thumb(m.group(1), q), "image/png", {})
            m = RE_FILE_INFO.match(path)
            if m and method == "GET":
                return self._json(api_file_info(m.group(1), q))
            m = RE_TASK.match(path)
            if m and method == "POST":
                tid, action = m.group(1), m.group(2)
                if action == "cancel":
                    return self._json(api_task_cancel(tid))
                if action == "retry":
                    return self._json(api_task_retry(tid))
                return self._json(api_task_clear(tid))
            m = RE_TASK_GET.match(path)
            if m and method == "GET":
                return self._json(api_task_get(m.group(1)))
            m = RE_FILE.match(path)
            if m and method == "DELETE":
                return self._json(api_file_delete(m.group(1)))

            handler = JSON_ROUTES.get((method, path))
            if handler:
                body = self._body() if method == "POST" else {}
                return self._json(handler(q, body))

            self._err(404, f"未知接口: {method} {path}")
        except (ApiError, pdfops.OpError) as exc:
            self._err(getattr(exc, "status", 400), str(exc))
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            try:
                self._err(500, f"内部错误: {exc}")
            except Exception:  # noqa: BLE001
                pass

    # ---- 字节与静态 ----

    def _bytes(self, data: bytes, mime: str, headers: dict):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _serve_file_range(self, fid: str, q: dict):
        """流式输出原文件；支持单段 Range（pdf.js 大文档按需分块加载）。"""
        p, entry = _path_of(fid)
        mime = mimetypes.guess_type(entry["name"])[0] or "application/octet-stream"
        total = p.stat().st_size
        quoted = urllib.parse.quote(entry["name"])
        disp = f"attachment; filename*=UTF-8''{quoted}" if q.get("dl") else "inline"
        rng = self.headers.get("Range")
        start, end = 0, total - 1
        partial = False
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), total - 1)
                elif m.group(2):  # bytes=-N → 最后 N 字节
                    start = max(0, total - int(m.group(2)))
                partial = 0 <= start <= end < total
                if not partial:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{total}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Disposition", disp)
        self.send_header("Cache-Control", "no-store")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        with open(p, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(1024 * 512, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    def _serve_index(self, set_cookie_token: str):
        target = WEB_DIR / "index.html"
        if not target.is_file():
            return self._err(404, "前端资源缺失（未构建）")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Set-Cookie",
            f"{COOKIE_NAME}={set_cookie_token}; Path=/; HttpOnly; SameSite=Strict",
        )
        self.end_headers()
        self.wfile.write(data)

    def _static(self, path: str):
        if path in ("/", ""):
            path = "/index.html"
        rel = urllib.parse.unquote(path).lstrip("/")
        target = (WEB_DIR / rel).resolve()
        if not target.is_relative_to(WEB_DIR) or not target.is_file():
            return self._err(404, "资源不存在")
        ext = target.suffix.lower()
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", STATIC_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def serve(port: int = 8741, open_browser: bool = True, token: str | None = None,
          strict_port: bool = False) -> int:
    config.ensure_dirs()
    if token:
        auth.token = token
    actual = port
    server = None
    candidates = [port] if strict_port else range(port, port + 20)
    for cand in candidates:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", cand), Handler)
            actual = cand
            break
        except OSError:
            if strict_port:
                raise RuntimeError(f"端口 {port} 已被占用（桌面模式由壳指定端口，不做顺延）")
            continue
    if server is None:
        raise RuntimeError(f"端口 {port}–{port + 19} 均被占用")
    url = auth.entry_url("127.0.0.1", actual)
    print(f"[湛卢/Zhanlu] v{__version__} · 本地服务已启动: http://127.0.0.1:{actual}")
    print(f"[湛卢/Zhanlu] 数据目录: {config.APP_DIR}")
    print(f"[湛卢/Zhanlu] 会话入口(仅本机): {url}")
    # 本地 AI 插件只在用户于设置/AI 页明确操作时才会启动或安装，这里不做任何隐式动作
    if open_browser:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[湛卢/Zhanlu] 已退出")
    finally:
        server.server_close()
    return actual
