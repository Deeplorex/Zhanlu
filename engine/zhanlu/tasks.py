"""后台任务中心：取消、失败重试、跨重启恢复。

任务 = kind（任务类型）+ params（可重放参数）+ 运行状态。
执行体由 jobs.JOBS[kind] 提供，TaskHub 只负责生命周期：

- 状态机：pending → running → cancelling → done / error / cancelled；
  启动时上一进程留下的 running 任务标记为 interrupted（可重试）。
- 取消：协作式。任务体在步骤边界检查 task["cancel"].is_set()，
  收到后抛 CancelledError，已生成但未交付的临时产物会被清理。
- 持久化：tasks.json 保存最近 N 条（含 params 与输出登记），
  供重启后查看失败原因、重试或清理。
"""

from __future__ import annotations

import shutil
import hashlib
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config

MAX_HISTORY = 120
PERSIST_FIELDS = ("id", "kind", "name", "params", "status", "progress", "progress_known", "error",
                  "created", "finished", "outputs", "pending_outputs", "retry_of", "detail")


def cleanup_stale_temps() -> None:
    """启动时清掉上次运行残留的任务临时目录（正常退出已即时清理）。"""
    if config.TEMP_DIR.is_dir():
        shutil.rmtree(config.TEMP_DIR, ignore_errors=True)
    config.TEMP_DIR.mkdir(parents=True, exist_ok=True)


class Cancelled(Exception):
    """任务被用户取消。"""


class TaskContext:
    """任务体拿到的句柄：上报进度、检查取消、登记输出、申请临时目录。"""

    def __init__(self, task: dict, record_output=None, record_pending=None, forget_pending=None):
        self._task = task
        self._temp_root: Path | None = None
        self._record_output = record_output
        self._record_pending = record_pending
        self._forget_pending = forget_pending

    def reserve_output(self, source: Path, target: Path, *, staged: bool = False) -> None:
        """交付前持久化路径和指纹；崩溃后只回收相同内容的文件。"""
        digest = hashlib.sha256()
        with source.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        pending = {"path": str(target.resolve()), "size": source.stat().st_size,
                   "sha256": digest.hexdigest()}
        if staged:
            stat = source.stat()
            pending.update({"staged_path": str(source.resolve()), "device": stat.st_dev, "inode": stat.st_ino})
        if self._record_pending:
            self._record_pending(pending)
        else:
            self._task.setdefault("pending_outputs", []).append(pending)

    def discard_reservation(self, source: Path, target: Path) -> None:
        stat = source.stat()
        path = str(target.resolve())
        if self._forget_pending:
            self._forget_pending(path, stat.st_dev, stat.st_ino)
        else:
            self._task["pending_outputs"] = [p for p in self._task.get("pending_outputs", [])
                if (p.get("path"), p.get("device"), p.get("inode")) != (path, stat.st_dev, stat.st_ino)]

    def check(self) -> None:
        if self._task["cancel"].is_set():
            raise Cancelled()

    def progress(self, value: float | None, detail: str | None = None) -> None:
        """上报进度。value=None 表示当前阶段无法估算（如模型拉取的无总量输出）：
        保留最后一个已知数值并标记 progress_known=False；数值恢复后重新标记可确定。"""
        if value is None:
            self._task["progress_known"] = False
        else:
            self._task["progress"] = max(0.0, min(1.0, float(value)))
            self._task["progress_known"] = True
        if detail is not None:
            self._task["detail"] = str(detail)

    def output(self, entry: dict) -> None:
        """登记一个已交付到目标位置的输出文件（store entry）。"""
        output = {
            "id": entry.get("id"), "name": entry.get("display") or entry.get("name"),
            "path": entry.get("path"), "kind": entry.get("kind"), "pages": entry.get("pages"),
        }
        if self._record_output:
            self._record_output(output)
        else:
            self._task["outputs"].append(output)

    @property
    def temp_root(self) -> Path:
        """本任务专属临时目录；取消/失败时由 TaskHub 清空。"""
        if self._temp_root is None:
            self._temp_root = config.TEMP_DIR / self._task["id"]
            self._temp_root.mkdir(parents=True, exist_ok=True)
        return self._temp_root


class TaskHub:
    def __init__(self, workers: int = 3):
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="zhanlu-task")
        self._tasks: dict[str, dict] = {}
        self._lock = threading.RLock()
        self._builders = {}  # kind -> fn(params, TaskContext) -> result dict
        self._names = {}     # kind -> fn(params) -> 显示名
        self.cleanup_outputs = None  # jobs 注册：清理已交付输出（取消/失败时不留半成品）
        self.cleanup_pending = None  # jobs 注册：按指纹清理交付中的输出
        cleanup_stale_temps()
        self._load()

    # ---- 注册与提交 ----

    def register(self, kind: str, name_fn, run_fn) -> None:
        self._builders[kind] = run_fn
        self._names[kind] = name_fn

    def submit(self, kind: str, params: dict, retry_of: str | None = None) -> dict:
        if kind not in self._builders:
            raise KeyError(f"未知任务类型: {kind}")
        tid = uuid.uuid4().hex[:10]
        task = {
            "id": tid, "kind": kind, "name": self._names[kind](params),
            "params": params, "status": "running", "progress": 0.0, "progress_known": True, "detail": None,
            "error": None, "created": time.time(), "finished": None,
            "outputs": [], "pending_outputs": [], "result": None, "retry_of": retry_of,
            "cancel": threading.Event(),
        }
        with self._lock:
            self._tasks[tid] = task
            self._persist_locked()

        def _run():
            ctx = TaskContext(task, lambda output: self._record_output(task, output),
                              lambda pending: self._record_pending(task, pending),
                              lambda path, dev, ino: self._forget_pending(task, path, dev, ino))
            try:
                task["result"] = self._builders[kind](params, ctx)
                ctx.check()
                task["status"] = "done"
                task["progress"] = 1.0
                task["progress_known"] = True
                task["pending_outputs"] = []
            except Cancelled:
                task["status"] = "cancelled"
                task["error"] = "已取消"
                task["result"] = None
                self._rollback_outputs(task)
            except Exception as exc:  # noqa: BLE001 — 任务错误要原样带给前端
                task["status"] = "error"
                task["error"] = f"{type(exc).__name__}: {exc}"
                task["result"] = None
                self._rollback_outputs(task)
            finally:
                if ctx._temp_root is not None:
                    shutil.rmtree(ctx._temp_root, ignore_errors=True)
                task["finished"] = time.time()
                with self._lock:
                    self._trim_locked()
                    self._persist_locked()

        self._pool.submit(_run)
        return self._public(task)

    def _record_output(self, task: dict, output: dict) -> None:
        """每交付一个文件即落盘，供进程意外退出后回收半成品。"""
        with self._lock:
            task["outputs"].append(output)
            self._persist_locked()

    def _record_pending(self, task: dict, pending: dict) -> None:
        with self._lock:
            task["pending_outputs"].append(pending)
            self._persist_locked()

    def _forget_pending(self, task: dict, path: str, device: int, inode: int) -> None:
        with self._lock:
            task["pending_outputs"] = [p for p in task["pending_outputs"]
                if (p.get("path"), p.get("device"), p.get("inode")) != (path, device, inode)]
            self._persist_locked()

    # ---- 查询与控制 ----

    def get(self, tid: str) -> dict | None:
        with self._lock:
            t = self._tasks.get(tid)
            return self._public(t) if t else None

    def list(self) -> list[dict]:
        with self._lock:
            return [self._public(t) for t in sorted(self._tasks.values(), key=lambda x: -x["created"])]

    def cancel(self, tid: str) -> bool:
        with self._lock:
            t = self._tasks.get(tid)
            if not t or t["status"] != "running":
                return False
            t["status"] = "cancelling"
            t["cancel"].set()
            self._persist_locked()
            return True

    def retry(self, tid: str) -> dict:
        with self._lock:
            t = self._tasks.get(tid)
        if not t:
            raise KeyError("任务不存在")
        if t["status"] not in ("error", "cancelled", "interrupted"):
            raise ValueError("只有失败、已取消或中断的任务可以重试")
        return self.submit(t["kind"], t["params"], retry_of=t["id"])

    def clear(self, tid: str) -> bool:
        with self._lock:
            t = self._tasks.get(tid)
            if t and t["status"] in ("pending", "running", "cancelling"):
                return False
            if t:
                del self._tasks[tid]
                self._persist_locked()
                return True
            return False

    def clear_finished(self) -> int:
        """一键清理全部终态任务记录（不影响运行中任务，也不改动已生成的文件）。"""
        with self._lock:
            doomed = [tid for tid, t in self._tasks.items()
                      if t["status"] not in ("pending", "running", "cancelling")]
            for tid in doomed:
                del self._tasks[tid]
            if doomed:
                self._persist_locked()
            return len(doomed)

    # ---- 持久化 ----

    def _rollback_outputs(self, task: dict) -> None:
        """取消/失败时收回已交付到目标位置的输出：不把半成品留在用户目录。"""
        delivered = task.get("outputs") or []
        pending = task.get("pending_outputs") or []
        pending_paths = {item.get("path") for item in pending}
        unresolved = pending
        if pending and self.cleanup_pending:
            try:
                unresolved = self.cleanup_pending(pending)
            except Exception:  # noqa: BLE001 — 清理失败不掩盖原错误
                pass
        legacy = [item for item in delivered if item.get("path") not in pending_paths]
        if legacy and self.cleanup_outputs:
            try:
                self.cleanup_outputs(legacy)
            except Exception:  # noqa: BLE001 — 清理失败不掩盖原错误
                pass
        unresolved_paths = {item.get("path") for item in unresolved}
        task["outputs"] = [item for item in delivered if item.get("path") in unresolved_paths]
        task["pending_outputs"] = unresolved
        if unresolved:
            task["error"] = (task.get("error") or "任务中断") + "；部分输出未自动清理，请核对保存位置。"

    def reconcile_interrupted(self) -> None:
        """注册清理器后，回收上次运行中断任务已经登记的部分输出。"""
        with self._lock:
            changed = False
            for task in self._tasks.values():
                if task["status"] == "interrupted":
                    if task.get("outputs") or task.get("pending_outputs"):
                        self._rollback_outputs(task)
                    changed = True
            if changed:
                self._persist_locked()

    def _public(self, t: dict) -> dict:
        out = {k: t.get(k) for k in PERSIST_FIELDS}
        # 前端任务协议使用驼峰字段；保留持久化的下划线字段兼容已有记录。
        out["progressKnown"] = t.get("progress_known")
        out["detail"] = t.get("detail")
        out["result"] = t.get("result")  # 运行时结果随查询返回，不写入 tasks.json
        return out

    def _persist_locked(self) -> None:
        rows = [{k: t.get(k) for k in PERSIST_FIELDS} for t in self._tasks.values()]
        rows.sort(key=lambda x: -x["created"])
        config.save_json(config.TASKS_FILE, rows[:MAX_HISTORY])

    def _trim_locked(self) -> None:
        if len(self._tasks) <= MAX_HISTORY:
            return
        finished = sorted(
            (t for t in self._tasks.values() if t["status"] in ("done", "error", "cancelled", "interrupted")),
            key=lambda t: t["finished"] or 0,
        )
        for t in finished[: len(self._tasks) - MAX_HISTORY]:
            self._tasks.pop(t["id"], None)

    def _load(self) -> None:
        rows = config.load_json(config.TASKS_FILE, [])
        if not isinstance(rows, list):
            return
        for row in rows:
            if not isinstance(row, dict) or not row.get("kind"):
                continue
            if row.get("status") in ("running", "cancelling", "pending"):
                row["status"] = "interrupted"
                row["error"] = "程序退出时任务被中断，可重试或清理。"
            row.setdefault("outputs", [])
            row.setdefault("pending_outputs", [])
            row["cancel"] = threading.Event()
            row["result"] = None
            self._tasks[row["id"]] = row
