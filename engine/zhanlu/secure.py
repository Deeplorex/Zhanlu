"""本机凭据保护：Windows DPAPI（CryptProtectData），失败时拒绝保存新密钥。

密文带 b"DP1|" 前缀标识；无前缀的旧值按历史 XOR 混淆解析，保存时自动升级为 DPAPI。
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wt
import os
import sys
import uuid as uuidlib

_PREFIX = b"DP1|"

_is_windows = sys.platform == "win32" and not os.environ.get("ZHANLU_NO_DPAPI")


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> tuple[_DATA_BLOB, ctypes.Array]:
    buf = ctypes.create_string_buffer(data, len(data))
    return _DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


def _unblob(blob: _DATA_BLOB) -> bytes:
    out = ctypes.string_at(blob.pbData, blob.cbData)
    ctypes.windll.kernel32.LocalFree(blob.pbData)
    return out


def _dpapi_protect(data: bytes) -> bytes:
    source, buffer = _blob(data)
    out = _DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(source), "Zhanlu", None, None, None, 0x01, ctypes.byref(out)
    )
    del buffer
    if not ok:
        raise OSError("CryptProtectData 失败")
    return _PREFIX + _unblob(out)


def _dpapi_unprotect(data: bytes) -> bytes:
    source, buffer = _blob(data)
    out = _DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0x01, ctypes.byref(out)
    )
    del buffer
    if not ok:
        raise OSError("CryptUnprotectData 失败")
    return _unblob(out)


def _xor_salt() -> bytes:
    return uuidlib.getnode().to_bytes(6, "big") * 4


def _legacy_obfuscate(secret: str) -> str:
    salt = _xor_salt()
    raw = secret.encode("utf-8")
    return base64.b64encode(bytes(b ^ salt[i % len(salt)] for i, b in enumerate(raw))).decode("ascii")


def _legacy_deobfuscate(token: str) -> str:
    try:
        xored = base64.b64decode(token.encode("ascii"))
        salt = _xor_salt()
        return bytes(b ^ salt[i % len(salt)] for i, b in enumerate(xored)).decode("utf-8")
    except Exception:  # noqa: BLE001 — 换机器/损坏时返回空，让用户重填
        return ""


def protect_secret(secret: str) -> str:
    """加密保存模型密钥；Windows 上 DPAPI 不可用时拒绝保存。"""
    if not secret:
        return ""
    if _is_windows:
        return base64.b64encode(_dpapi_protect(secret.encode("utf-8"))).decode("ascii")
    return _legacy_obfuscate(secret)


def unprotect_secret(token: str) -> str:
    """解密密钥。DPAPI 密文失败（换机器等）与旧混淆值都返回可重填的空串或明文。"""
    if not token:
        return ""
    try:
        raw = base64.b64decode(token.encode("ascii"))
    except Exception:  # noqa: BLE001
        return ""
    if raw.startswith(_PREFIX):
        try:
            return _dpapi_unprotect(raw[len(_PREFIX):]).decode("utf-8")
        except OSError:
            return ""
    return _legacy_deobfuscate(token)
