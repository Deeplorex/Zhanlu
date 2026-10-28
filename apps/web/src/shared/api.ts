import type { AiConfig, AppInfo, FileEntry, JobPreview, Task } from "./types";

async function handle(resp: Response): Promise<any> {
  if (!resp.ok) {
    let msg = `${resp.status} ${resp.statusText}`;
    try {
      const body = await resp.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    const err = new Error(msg) as Error & { status: number };
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export function get<T = any>(path: string): Promise<T> {
  return fetch(path).then(handle);
}

export function post<T = any>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then(handle);
}

export function del<T = any>(path: string): Promise<T> {
  return fetch(path, { method: "DELETE" }).then(handle);
}

export async function uploadFiles(files: File[] | FileList): Promise<{ files: FileEntry[] }> {
  const fd = new FormData();
  for (const f of Array.from(files)) fd.append("file", f, f.name);
  return fetch("/api/files/upload", { method: "POST", body: fd }).then(handle);
}

export function rawUrl(id: string, download?: boolean): string {
  return `/api/files/${id}/raw${download ? "?dl=1" : ""}`;
}

export function thumbUrl(id: string, page: number, dpi = 60): string {
  return `/api/files/${id}/thumb?page=${page}&dpi=${dpi}`;
}

export async function waitTask(
  taskId: string,
  { onTick, interval = 400, timeout = 3_600_000 }: { onTick?: (t: Task) => void; interval?: number; timeout?: number } = {},
): Promise<Task> {
  const t0 = Date.now();
  for (;;) {
    const t = await get<Task>(`/api/tasks/${taskId}`);
    if (onTick) onTick(t);
    if (t.status === "done") return t;
    if (t.status === "error") throw new Error(t.error || "任务失败");
    if (t.status === "cancelled") throw new Error("已取消");
    if (t.status === "interrupted") throw new Error(t.error || "任务已中断");
    if (Date.now() - t0 > timeout) throw new Error("任务超时");
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ---- 任务 / 工作流 ----

export function jobsPreview(kind: string, params: Record<string, unknown>): Promise<JobPreview> {
  return post("/api/jobs/preview", { kind, params });
}

export function jobsRun(kind: string, params: Record<string, unknown>): Promise<Task> {
  return post("/api/jobs/run", { kind, params });
}

export function cancelTask(id: string): Promise<{ ok: boolean }> {
  return post(`/api/tasks/${id}/cancel`);
}

export function retryTask(id: string): Promise<Task> {
  return post(`/api/tasks/${id}/retry`);
}

export function clearTask(id: string): Promise<{ ok: boolean }> {
  return post(`/api/tasks/${id}/clear`);
}

/** 一键清理全部终态任务记录（运行中任务与已生成文件不受影响） */
export function clearFinishedTasks(): Promise<{ ok: boolean; count: number }> {
  return post("/api/tasks/clear");
}

// ---- 系统 ----

export function pickFolder(): Promise<{ path: string | null; cancelled: boolean }> {
  return post("/api/sys/pick-folder");
}

/** 原生文件选择（多选 PDF）：引擎登记真实路径后返回条目（与源文件同目录可用） */
export function pickPdfs(kind: "pdf" | "convert" = "pdf"): Promise<{ files: FileEntry[]; errors: string[]; cancelled: boolean }> {
  return post("/api/sys/pick-pdfs", { kind });
}

export function openPath(payload: { id: string }): Promise<{ ok: boolean }> {
  return post("/api/sys/open-path", payload);
}

// ---- 应用信息 ----

export function getAppInfo(): Promise<AppInfo> {
  return get("/api/app-info");
}

export function getAiConfigs(): Promise<{ configs: AiConfig[] }> {
  return get("/api/ai/configs");
}

export function fmtSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `今日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
