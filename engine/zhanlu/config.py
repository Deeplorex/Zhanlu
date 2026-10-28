"""本机配置与数据目录。安装/数据路径一律英文 Zhanlu，显示名随系统语言。"""

import json
import locale
import os
import tempfile
import time
from pathlib import Path


def _default_home() -> Path:
    env = os.environ.get("ZHANLU_HOME")
    if env:
        return Path(env)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "Zhanlu"


APP_DIR = _default_home()
INBOX_DIR = APP_DIR / "inbox"
OUT_DIR = APP_DIR / "out"
TEMP_DIR = APP_DIR / "tmp"
THUMB_DIR = APP_DIR / "thumbs"
PLUGINS_DIR = APP_DIR / "plugins"          # 所有插件（运行时/模型）统一放这里，删目录即卸载
OCR_MODELS_DIR = PLUGINS_DIR / "ocr-models"
CONFIG_FILE = APP_DIR / "config.json"
REGISTRY_FILE = APP_DIR / "registry.json"
TASKS_FILE = APP_DIR / "tasks.json"

DEFAULT_SETTINGS = {
    "lang": "auto",  # auto | zh | en
    "theme": "dark",
    "ai": {"configs": [], "active": None},
    "ocr": {"engine": "rapid"},
    "localai": {"auto_start": True, "default_model": None},
}


def ensure_dirs() -> None:
    for d in (APP_DIR, INBOX_DIR, OUT_DIR, TEMP_DIR, THUMB_DIR, PLUGINS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # Windows can briefly deny replacement while an indexer or scanner has
        # the existing JSON open. Keep the atomic write and retry that race.
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if os.name != "nt" or attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_settings() -> dict:
    data = load_json(CONFIG_FILE, DEFAULT_SETTINGS)
    if not isinstance(data, dict):
        return dict(DEFAULT_SETTINGS)
    merged = dict(DEFAULT_SETTINGS)
    merged.update(data)
    merged["ai"] = data.get("ai") or DEFAULT_SETTINGS["ai"]
    merged["ocr"] = data.get("ocr") or DEFAULT_SETTINGS["ocr"]
    merged["localai"] = data.get("localai") or DEFAULT_SETTINGS["localai"]
    return merged


def save_settings(settings: dict) -> None:
    save_json(CONFIG_FILE, settings)


def system_lang() -> str:
    """返回系统主语言（如 zh / en）。"""
    try:
        code = locale.getdefaultlocale()[0] or ""
    except ValueError:
        code = ""
    if not code:
        code = os.environ.get("LANG", "") or ""
    return code.split("_")[0].lower() or "en"


def display_name(settings: dict | None = None) -> str:
    """显示名：中文系统 → 湛卢，其他 → Zhanlu；可在设置中强制。"""
    if settings:
        lang = settings.get("lang", "auto")
        if lang == "zh":
            return "湛卢"
        if lang == "en":
            return "Zhanlu"
    return "湛卢" if system_lang() == "zh" else "Zhanlu"
