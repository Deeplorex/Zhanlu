import React, { useCallback, useEffect, useRef, useState } from "react";
import SwordProgress, { swordPct } from "./SwordProgress";
import { cancelTask, jobsPreview, jobsRun, openPath, pickFolder, waitTask } from "./api";
import type { FileEntry, JobPreview, Task } from "./types";

/**
 * 任务页共用机制：预览（防抖）→ 执行 → 进度/取消 → 完成态。
 * 输出冲突、目录不可写、失败原因都在预览与执行两处呈现，绝不静默覆盖。
 */
export function useJob(kind: string) {
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<JobPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [done, setDone] = useState<Task | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const seq = useRef(0);

  const refreshPreview = useCallback(async (p: Record<string, unknown>) => {
    const my = ++seq.current;
    setPreviewError(null);
    try {
      const r = await jobsPreview(kind, p);
      if (my === seq.current) setPreview(r);
    } catch (e) {
      if (my === seq.current) {
        setPreview(null);
        setPreviewError((e as Error).message);
      }
    }
  }, [kind]);

  useEffect(() => {
    if (!Object.keys(params).length) return;
    ++seq.current;
    setPreview(null);
    setPreviewError(null);
    const t = setTimeout(() => refreshPreview(params), 220);
    return () => clearTimeout(t);
  }, [params, refreshPreview]);

  const update = useCallback((patch: Record<string, unknown>) => {
    setParams((old) => ({ ...old, ...patch }));
  }, []);

  const run = useCallback(async () => {
    setRunError(null);
    setDone(null);
    setTask(null);
    setSubmitting(true);
    let lastTask: Task | null = null;
    try {
      const started = await jobsRun(kind, params);
      lastTask = started;
      setTask(started);
      setSubmitting(false);
      const finished = await waitTask(started.id, { onTick: (t) => { lastTask = t; setTask(t); } });
      setDone(finished);
      setTask(finished);
      if (finished.status === "error" || finished.status === "interrupted") {
        setRunError(finished.error || (finished.status === "interrupted" ? "任务中断，请重试。" : "任务失败，请重试。"));
      }
      return finished;
    } catch (e) {
      setRunError((e as Error).message);
      setTask(lastTask);
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [kind, params]);

  const cancel = useCallback(async () => {
    if (task?.id) await cancelTask(task.id).catch(() => {});
  }, [task]);

  const reset = useCallback(() => {
    ++seq.current;
    setParams({});
    setPreview(null);
    setTask(null);
    setDone(null);
    setRunError(null);
    setSubmitting(false);
  }, []);

  const busy = submitting || task?.status === "running" || task?.status === "cancelling";
  return {
    params, update, setParams,
    preview, previewError,
    task, done, busy, submitting, runError,
    run, cancel, reset,
  };
}

/** 保存位置选择 + 当前目录显示 */
export function FolderPicker({ dir, onPick }: { dir: string | null; onPick: (d: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    setBusy(true);
    try {
      const r = await pickFolder();
      if (!r.cancelled && r.path) onPick(r.path);
    } catch (e) {
      alert(`无法打开目录选择：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wf-folder">
      <div className="wf-folder-row">
        <strong title={dir || undefined}>{dir ? shortDir(dir) : "应用输出目录（默认）"}</strong>
        <button type="button" onClick={choose} disabled={busy}>{busy ? "打开中…" : dir ? "更改" : "选择位置"}</button>
        {dir && <button type="button" className="ghost" onClick={() => onPick(null)}>恢复默认</button>}
      </div>
      {dir && <small>{dir}</small>}
    </div>
  );
}

function shortDir(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return dir;
  return `…/${parts.slice(-2).join("/")}`;
}

/** 预览卡：数量、名称、警告、冲突。任何一项不通过都不允许执行。 */
export function PreviewPanel({ preview, error, extra }: { preview: JobPreview | null; error: string | null; extra?: React.ReactNode }) {
  if (error) return <div className="wf-preview wf-invalid"><h4>输出预览</h4><p className="wf-error">{error}</p></div>;
  if (!preview) return <div className="wf-preview"><h4>输出预览</h4><p className="wf-muted">填写完成后这里核对数量与名称。</p></div>;
  const bad = !preview.ok;
  return (
    <div className={"wf-preview" + (bad ? " wf-invalid" : "")}>
      <h4>输出预览</h4>
      {preview.summary && <strong>{preview.summary}</strong>}
      {bad && preview.error && <p className="wf-error">{preview.error}</p>}
      {preview.warnings?.map((w, i) => <p key={i} className="wf-warn">⚠ {w}</p>)}
      {preview.outputs?.length > 0 && (
        <div className="wf-preview-list">
          {preview.outputs.slice(0, 8).map((o, i) => (
            <div key={i}>
              <span className="wf-no">{String(i + 1).padStart(2, "0")}</span>
              <span className="wf-name" title={o.name}>{o.name}</span>
              {o.pages != null && <span className="wf-pages">{o.pages} 页</span>}
            </div>
          ))}
          {preview.outputs.length > 8 && <div className="wf-more">共 {preview.outputs.length} 个文件（{preview.dir}）</div>}
        </div>
      )}
      {preview.outputs?.length === 1 && preview.outputs[0].order && (
        <p className="wf-order">顺序：{preview.outputs[0].order!.join(" → ")}</p>
      )}
      {extra}
    </div>
  );
}

/** 运行/进度条 + 取消 */
export function RunBar({ busy, task, ok, disabled, label, onCancel, onRun }: {
  busy: boolean; task: Task | null; ok: boolean; disabled?: boolean;
  label: string; onCancel: () => void; onRun: () => void;
}) {
  const pct = Math.round((task?.progress || 0) * 100);
  return (
    <div className="wf-runbar">
      {!busy && <button type="button" className="btn" onClick={() => (location.hash = "#/home")}>返回首页</button>}
      {busy ? (
        <div className="wf-progress">
          <strong>{task?.status === "cancelling" ? "取消中…" : `处理中 ${task ? swordPct(task) : "0%"}`}</strong>
          {task?.detail && <small>{task.detail}</small>}
          <SwordProgress value={task?.progress || 0} unknown={task?.progressKnown === false} label="任务处理进度" />
        </div>
      ) : null}
      {busy ? (
        <button type="button" className="btn" onClick={onCancel} disabled={task?.status === "cancelling"}>取消</button>
      ) : (
        <button type="button" className="btn primary big" disabled={disabled || !ok} onClick={onRun}>{label}</button>
      )}
    </div>
  );
}

/** 完成页：结果清单 + 打开阅读 / 打开位置 / 再来一次 */
export function DonePanel({ title, files, onOpen, onAgain }: {
  title: string; files: FileEntry[]; onOpen: (f: FileEntry) => void; onAgain: () => void;
}) {
  const pdfs = files.filter((f) => f.kind === "pdf");
  return (
    <div className="wf-done rise">
      <div className="wf-done-icon" aria-hidden="true">✓</div>
      <h2>{title}</h2>
      <p>已生成 {files.length} 个文件。原文件未改动。</p>
      <div className="wf-done-list">
        {files.slice(0, 60).map((f) => (
          <div key={f.id}>
            <span className="badge fmt">{(f.name.split(".").pop() || "?").toUpperCase()}</span>
            <strong title={f.name}>{f.name}</strong>
            {f.pages ? <small>{f.pages} 页</small> : null}
            <button type="button" className="btn sm ghost" onClick={() => openPath({ id: f.id }).catch(() => {})}>所在位置</button>
            {f.kind === "pdf" && <button type="button" className="btn sm" onClick={() => onOpen(f)}>打开阅读</button>}
          </div>
        ))}
        {files.length > 60 && <p>其余 {files.length - 60} 个文件可到输出目录查看。</p>}
      </div>
      <div className="wf-done-actions">
        <button type="button" className="btn" onClick={onAgain}>再做一次</button>
        {pdfs[0] && <button type="button" className="btn primary" onClick={() => onOpen(pdfs[0])}>打开{pdfs.length === 1 ? "结果" : "第一个结果"}并阅读</button>}
      </div>
    </div>
  );
}
