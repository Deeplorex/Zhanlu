"""python -m zhanlu 启动本地服务。

--token 由桌面壳注入会话令牌；--dev 供 vite 开发代理（放宽令牌，仍校验 Host/Origin）。
"""

import argparse
import os
import sys

from . import __version__, config, server


def _log_to_file() -> None:
    """安装版没有控制台，异常与原生崩溃必须落到 engine.log，否则崩溃无从诊断。"""
    import faulthandler
    log = config.APP_DIR / "engine.log"
    try:
        if log.exists() and log.stat().st_size > 2 * 1024 * 1024:
            rotated = config.APP_DIR / "engine.log.1"
            rotated.unlink(missing_ok=True)
            log.replace(rotated)
        stream = open(log, "a", encoding="utf-8", errors="replace", buffering=1)
    except OSError:
        return
    try:
        faulthandler.enable(stream)
    except Exception:  # noqa: BLE001 — 取证失败不影响运行
        pass
    if sys.stderr is None or not sys.stderr.isatty():
        sys.stdout = stream
        sys.stderr = stream


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="zhanlu", description="湛卢 Zhanlu — 纯本地 PDF 工作台")
    parser.add_argument("--port", type=int, default=8741, help="监听端口（默认 8741，被占用时自动顺延）")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--token", default=None, help="会话令牌（桌面壳注入）")
    parser.add_argument("--strict-port", action="store_true", help="端口被占用时报错退出（桌面壳指定端口时使用）")
    parser.add_argument("--dev", action="store_true", help="开发模式：放宽令牌校验（仅限本机回环）")
    parser.add_argument("--desktop-input", action="store_true", help="接收桌面壳的文件打开请求")
    parser.add_argument("--version", action="version", version=f"湛卢/Zhanlu {__version__}")
    args = parser.parse_args(argv)

    config.ensure_dirs()
    _log_to_file()
    if args.desktop_input:
        from . import desktop
        sys.stdin.reconfigure(encoding="utf-8")
        desktop.start(sys.stdin, server.store)
    if args.dev or os.environ.get("ZHANLU_DEV") == "1":
        server.auth.dev_mode = True
    server.serve(port=args.port, open_browser=not args.no_open, token=args.token,
                 strict_port=args.strict_port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
