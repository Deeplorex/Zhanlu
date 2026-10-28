"""会话令牌与请求来源校验。

- 令牌随引擎启动生成（或由桌面壳通过 --token 注入），只在内存与启动 URL 中出现。
- 首次访问 /?token=… 时种下 HttpOnly + SameSite=Strict Cookie；API 要求
  Cookie 或 X-Zhanlu-Token 请求头二选一。
- Origin/Host 校验：请求带 Origin 时，其主机必须是本机回环地址，否则直接拒绝。
  本地恶意页面即使同机也没有令牌，令牌才是最终闸门；Origin 校验挡外部网页。
"""

from __future__ import annotations

import secrets
from http.cookies import SimpleCookie
from urllib.parse import urlparse

COOKIE_NAME = "zl_token"
_LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}


class Auth:
    def __init__(self, token: str | None = None, dev_mode: bool = False):
        self.token = token or secrets.token_urlsafe(24)
        self.dev_mode = dev_mode  # 仅本机开发（vite 代理）放宽令牌，Origin/Host 仍校验

    # ---- 请求检查 ----

    def origin_ok(self, origin_header: str | None) -> bool:
        if not origin_header:
            return True
        host = (urlparse(origin_header).hostname or "").lower()
        return host in _LOOPBACK

    def host_ok(self, host_header: str | None) -> bool:
        """挡 DNS 重绑定：Host 必须是本机回环名。"""
        if not host_header:
            return False
        host = host_header.strip().lower()
        if host.startswith("["):  # [::1]:8741
            host = host.split("]")[0].lstrip("[")
        else:
            host = host.split(":")[0]
        return host in _LOOPBACK

    def authorized(self, headers, query_token: str | None) -> bool:
        """headers: email.message.Message 或等价 .get() 接口。"""
        if self.dev_mode:
            return True
        if headers.get("X-Zhanlu-Token") == self.token:
            return True
        if query_token and secrets.compare_digest(query_token, self.token):
            return True
        cookie = SimpleCookie()
        try:
            cookie.load(headers.get("Cookie") or "")
        except Exception:  # noqa: BLE001
            return False
        morsel = cookie.get(COOKIE_NAME)
        return bool(morsel and secrets.compare_digest(morsel.value, self.token))

    def entry_url(self, host: str, port: int) -> str:
        return f"http://{host}:{port}/?token={self.token}"
