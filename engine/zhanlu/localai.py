"""本地 AI 通道管理：检测/启动 Ollama、列出与拉取模型、注册为默认本地配置。

本地模型是首版 AI 的默认路径：文字不出本机。远程模型仅用户显式配置后可用。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

from . import config

API_HOST = "127.0.0.1"
API_PORT = 11434
BASE_URL = f"http://{API_HOST}:{API_PORT}/v1"
CREATE_NO_WINDOW = 0x08000000

# 插件式本地 AI 运行时：只安装到湛卢数据目录（绿色、可整目录删除），
# 绝不系统级安装、绝不在启动时自动安装——安装必须由用户在界面明确触发。
PLUGIN_ROOT = config.PLUGINS_DIR
PLUGIN_DIR = PLUGIN_ROOT / "ollama"
PLUGIN_EXE = PLUGIN_DIR / "ollama.exe"
PLUGIN_ZIP_URL = "https://ollama.com/download/ollama-windows-amd64.zip"
PLUGIN_MODELS_DIR = config.APP_DIR / "models"

# 首选默认模型（中文能力与体量的折中），安装插件时按此拉取
DEFAULT_MODEL = "qwen2.5:3b"
_FALLBACK_MODELS = ["qwen2.5:1.5b", "llama3.2:3b", "gemma3:4b"]

_server_proc: subprocess.Popen | None = None
_lock = threading.Lock()


def _http_json(path: str, timeout: float = 2.0):
    req = urllib.request.Request(f"http://{API_HOST}:{API_PORT}{path}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def find_ollama() -> str | None:
    """优先使用湛卢插件目录中的运行时；用户自行安装的系统版本仍可被检测使用。"""
    if PLUGIN_EXE.is_file():
        return str(PLUGIN_EXE)
    exe = shutil.which("ollama")
    if exe:
        return exe
    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe",
        Path("C:/Program Files/Ollama/ollama.exe"),
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def is_serving() -> bool:
    try:
        _http_json("/api/version", timeout=1.5)
        return True
    except Exception:  # noqa: BLE001
        return False


def ensure_server(wait_seconds: float = 12.0) -> dict:
    """已运行直接返回；否则启动 ollama serve（仅当用户已安装运行时）。不会安装任何东西。"""
    global _server_proc
    exe = find_ollama()
    if not exe:
        return {"installed": False, "running": False, "exe": None,
                "error": "本地 AI 插件未安装。请到 设置 → 插件，由你确认后安装。"}
    if is_serving():
        return {"installed": True, "running": True, "exe": exe}
    with _lock:
        if not is_serving():
            try:
                env = dict(os.environ, OLLAMA_HOST=f"{API_HOST}:{API_PORT}")
                # 插件运行时的模型目录指向湛卢数据目录；若用户系统里已有模型则沿用，避免重复下载
                if Path(exe).parent == PLUGIN_DIR:
                    system_models = Path.home() / ".ollama" / "models"
                    env["OLLAMA_MODELS"] = (
                        str(system_models) if system_models.is_dir() else str(PLUGIN_MODELS_DIR))
                _server_proc = subprocess.Popen(
                    [exe, "serve"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=CREATE_NO_WINDOW, env=env,
                )
            except OSError as exc:
                return {"installed": True, "running": False, "exe": exe, "error": str(exc)}
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if is_serving():
            return {"installed": True, "running": True, "exe": exe}
        if _server_proc and _server_proc.poll() is not None:
            return {"installed": True, "running": False, "exe": exe,
                    "error": "ollama serve 进程已退出"}
        time.sleep(0.4)
    return {"installed": True, "running": False, "exe": exe, "error": "本地服务启动超时"}


def list_models() -> list[dict]:
    try:
        data = _http_json("/api/tags", timeout=3.0)
        return [{"name": m.get("name") or m.get("model"),
                 "size": m.get("size"),
                 "modified": m.get("modified_at")}
                for m in (data.get("models") or []) if (m.get("name") or m.get("model"))]
    except Exception:  # noqa: BLE001
        return []


def status() -> dict:
    s = config.load_settings().get("localai") or {}
    exe = find_ollama()
    running = is_serving()
    models = list_models() if running else []
    default = s.get("default_model")
    if not default:
        default = _pick_default(models)
    plugin_installed = PLUGIN_EXE.is_file()
    return {
        "installed": bool(exe),
        "plugin": {
            "installed": plugin_installed,
            "dir": str(PLUGIN_DIR) if plugin_installed else str(PLUGIN_DIR),
            "zip_url": PLUGIN_ZIP_URL,
            "approx_mb": 1513,
        },
        "exe": exe,
        "from_plugin": bool(exe) and Path(exe).parent == PLUGIN_DIR,
        "running": running,
        "api": BASE_URL,
        "models": models,
        "default_model": default,
        "auto_start": s.get("auto_start", False),
        "recommended": DEFAULT_MODEL,
        "pull_targets": [DEFAULT_MODEL] + [m for m in _FALLBACK_MODELS],
    }


def install_plugin(url: str | None = None, progress=None, should_cancel=None) -> dict:
    """用户明确确认后才会被调用：下载官方 zip 并解压到湛卢数据目录（绿色插件）。

    不写注册表、不开机自启、不做系统级安装；删除 PLUGIN_DIR 即完全卸载。
    """
    import shutil as _shutil
    import zipfile

    from .tasks import Cancelled

    config.ensure_dirs()
    if PLUGIN_EXE.is_file():
        return {"ok": True, "already": True, "exe": str(PLUGIN_EXE)}
    download_url = url or PLUGIN_ZIP_URL
    tmp_zip = config.TEMP_DIR / "ollama-plugin.zip"
    tmp_dir = config.TEMP_DIR / "ollama-plugin-extract"
    _shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    req = urllib.request.Request(download_url, headers={"User-Agent": "ZhanluPDF"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp_zip, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        got = 0
        while True:
            if should_cancel and should_cancel():
                raise Cancelled()
            chunk = resp.read(1024 * 512)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if progress:
                mb = 1024 * 1024
                label = f"下载中 {got // mb}/{total // mb} MB" if total else f"下载中 {got // mb} MB"
                progress(0.88 * (got / total) if total else None, label)

    if progress:
        progress(0.92, "校验并解压…")
    with zipfile.ZipFile(tmp_zip) as z:
        z.extractall(tmp_dir)
    exe = next((c for c in [tmp_dir / "ollama.exe", *tmp_dir.glob("*/ollama.exe")] if c.is_file()), None)
    if not exe:
        raise RuntimeError("压缩包内容不符合预期（未找到 ollama.exe）")
    if progress:
        progress(0.97, "安装到湛卢数据目录…")
    _shutil.rmtree(PLUGIN_DIR, ignore_errors=True)
    PLUGIN_ROOT.mkdir(parents=True, exist_ok=True)
    _shutil.move(str(exe.parent), str(PLUGIN_DIR))
    try:
        tmp_zip.unlink()
    except OSError:
        pass
    if progress:
        progress(1.0, "插件安装完成")
    return {"ok": True, "exe": str(PLUGIN_EXE), "dir": str(PLUGIN_DIR)}


def uninstall_plugin() -> dict:
    """删除插件目录即完全卸载（模型若在湛卢数据目录则一并删除）。"""
    import shutil as _shutil

    if _server_proc and _server_proc.poll() is None:
        _server_proc.kill()
    _shutil.rmtree(PLUGIN_DIR, ignore_errors=True)
    _shutil.rmtree(PLUGIN_MODELS_DIR, ignore_errors=True)
    return {"ok": not PLUGIN_EXE.exists()}


def _pick_default(models: list[dict]) -> str | None:
    names = [m["name"] for m in models]
    for wanted in (DEFAULT_MODEL,) + tuple(_FALLBACK_MODELS):
        for n in names:
            if n == wanted or n.split(":")[0] == wanted.split(":")[0]:
                return n
    return names[0] if names else None


def pull_model(model: str, progress=None, should_cancel=None) -> dict:
    """拉取（下载）模型到本机。逐行解析 ollama 输出上报进度。"""
    from .tasks import Cancelled

    exe = find_ollama()
    if not exe:
        raise RuntimeError("未检测到 Ollama，无法拉取模型")
    ensure_server()
    proc = subprocess.Popen(
        [exe, "pull", model],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        creationflags=CREATE_NO_WINDOW,
    )
    try:
        for line in proc.stdout or []:
            if should_cancel and should_cancel():
                proc.kill()
                raise Cancelled()
            line = line.strip()
            try:
                payload = json.loads(line)
                status = payload.get("status", "")
                total = payload.get("total")
                done = payload.get("completed")
                if total and done and progress:
                    progress(0.05 + 0.9 * min(1.0, done / total), f"{status} · {done}/{total}")
                elif progress:
                    progress(None, status)
            except ValueError:
                if progress and line:
                    progress(None, line[:80])
        rc = proc.wait()
        if rc != 0:
            raise RuntimeError(f"模型拉取失败（退出码 {rc}）")
    finally:
        if proc.poll() is None:
            proc.kill()
    if progress:
        progress(1.0, f"{model} 已就绪")
    return {"ok": True, "model": model}


def ensure_local_config() -> dict | None:
    """本地服务可用且有模型时，确保存在指向它的 AI 配置并默认激活本地通道。

    返回登记的配置（或 None）。不覆盖用户显式选择的远程配置为“激活”，
    除非当前没有任何配置。
    """
    from .core import ai

    st = status()
    if not (st["running"] and st["default_model"]):
        return None
    s = config.load_settings()
    configs = s["ai"]["configs"]
    local_cfg = None
    for c in configs:
        if c.get("protocol") == "ollama" and c.get("baseurl") == BASE_URL:
            local_cfg = c
            break
    changed = False
    if not local_cfg:
        local_cfg = {
            "id": "local-ollama",
            "name": f"本地 · {st['default_model']}",
            "protocol": "ollama",
            "baseurl": BASE_URL,
            "model": st["default_model"],
            # 本地 CPU 推理与首次加载模型较慢，放宽单次请求超时
            "timeout": 300,
        }
        configs.insert(0, local_cfg)
        changed = True
    elif local_cfg.get("model") != st["default_model"] or local_cfg.get("timeout", 0) < 300:
        local_cfg["model"] = st["default_model"]
        local_cfg["name"] = f"本地 · {st['default_model']}"
        local_cfg.setdefault("timeout", 300)
        changed = True
    if not s["ai"].get("active"):
        # 不再自动钉死 active：让用户设置的通道优先级（prefer）来决定生效配置
        pass
    if changed:
        config.save_settings(s)
    return local_cfg
