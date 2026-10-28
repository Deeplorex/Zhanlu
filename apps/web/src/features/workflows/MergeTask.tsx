import React, { useEffect, useRef, useState } from "react";
import SwordProgress, { swordPct } from "../../shared/SwordProgress";
import { AppCtx } from "../../app/AppContext";
import { openPath, uploadFiles } from "../../shared/api";
import { pickPdfsNative } from "../../shared/nativeOpen";
import { useNativeDrop } from "../../shared/nativeDrag";
import { useJob } from "../../shared/workflow";
import SaveLocationSelect, { type SaveMode } from "../../shared/SaveLocationSelect";
import type { FileEntry } from "../../shared/types";

/** 独立合并任务标签：文件行排序与逐份页范围、生成前核对。 */
export default function MergeTask() {
  const { taskSeed, taskTabId, setTaskTabTitle, files, refreshFiles, openFile, toast } = React.useContext(AppCtx);
  const job = useJob("merge");
  const [items, setItems] = useState<{ file: FileEntry; range: string }[]>([]);
  const [name, setName] = useState("资料汇编.pdf");
  const [dir, setDir] = useState<string | null>(null);
  const [saveMode, setSaveMode] = useState<SaveMode>("default");
  const dirParam = saveMode === "source" ? "@source" : saveMode === "custom" ? dir || undefined : undefined;
  const [dragged, setDragged] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addDropRef = useRef<HTMLButtonElement>(null);

  useNativeDrop(addDropRef, (result) => {
    if (result.errors.length) toast(`部分文件未能打开：${result.errors[0]}`, true);
    const pdfs = result.files.filter((f) => f.kind === "pdf");
    if (pdfs.length !== result.files.length) toast("合并只支持 PDF", true);
    setItems((old) => [...old, ...pdfs.filter((f, i, all) => !old.some((x) => x.file.id === f.id)
      && all.findIndex((x) => x.id === f.id) === i).map((file) => ({ file, range: "" }))]);
    void refreshFiles();
  });

  useEffect(() => {
    if (taskSeed?.kind === "merge" && taskSeed.files.length) {
      setItems(taskSeed.files.map((f) => ({ file: f, range: "" })));
      setName("资料汇编.pdf");
    }
  }, [taskSeed?.key]);

  useEffect(() => {
    if (!items.length) { job.setParams({}); return; }
    const params: Record<string, unknown> = {
      items: items.map((it) => ({ id: it.file.id, pages: it.range.trim() || undefined })),
      name, dir: dirParam,
    };
    job.setParams(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, name, dirParam]);

  const pageCount = job.preview?.outputs?.[0]?.pages;
  useEffect(() => {
    if (!taskTabId) return;
    setTaskTabTitle(taskTabId, items.length ? `合并 · ${items.length} 份` : "合并");
  }, [taskTabId, items.length, setTaskTabTitle]);

  const add = async (list: File[]) => {
    const pdfs = list.filter((f) => /\.pdf$/i.test(f.name));
    if (!pdfs.length) return toast("合并只支持 PDF", true);
    try {
      const r = await uploadFiles(pdfs);
      await refreshFiles();
      const ok = r.files.filter((f) => f.kind === "pdf");
      setItems((old) => [...old, ...ok.filter((f) => !old.some((x) => x.file.id === f.id)).map((f) => ({ file: f, range: "" }))]);
    } catch (e) { toast(`添加失败：${(e as Error).message}`, true); }
  };

  const pick = async () => {
    try {
      const r = await pickPdfsNative();
      if (r === null) { inputRef.current?.click(); return; }
      if (r.cancelled) return;
      if (r.errors.length) toast(`部分文件未能打开：${r.errors[0]}`, true);
      await refreshFiles();
      setItems((old) => [...old, ...r.files.filter((f) => f.kind === "pdf" && !old.some((x) => x.file.id === f.id)).map((file) => ({ file, range: "" }))]);
    } catch (e) { toast(`添加失败：${(e as Error).message}`, true); }
  };

  const move = (from: number | null, to: number) => {
    if (from === null || from === to || from < 0 || to < 0 || to >= items.length) return;
    setItems((old) => { const n = [...old]; n.splice(to, 0, ...n.splice(from, 1)); return n; });
  };

  const run = async () => {
    const t = await job.run();
    if (t?.status === "done") await refreshFiles();
  };

  const doneFile = job.done?.status === "done" ? (job.done.result?.file as FileEntry | undefined) : undefined;
  const pct = Math.round((job.task?.progress || 0) * 100);

  return (
    <div className="task-pad rise">
      <p className="page-kicker">合并 / 独立任务</p>
      <h1 className="page-title">合并 PDF</h1>
      <div className="task-grid">
        <section className="task-main-card">
          <h2>输入文件</h2>

          {items.map((it, i) => (
            <div key={it.file.id} className="merge-row"
                 draggable onDragStart={() => setDragged(i)}
                 onDragOver={(e) => e.preventDefault()}
                 onDrop={(e) => { e.preventDefault(); move(dragged, i); setDragged(null); }}
                 onDragEnd={() => setDragged(null)}>
              <div className="merge-row-main">
                <div className="merge-row-copy">
                  <strong title={it.file.name}>{it.file.name}</strong>
                  <small>{it.file.pages || "?"} 页 · {it.range.trim() ? `选取 ${it.range}` : "选取全部页面"}</small>
                </div>
                <div className="merge-row-ops">
                  <button type="button" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`上移 ${it.file.name}`}>↑</button>
                  <button type="button" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} aria-label={`下移 ${it.file.name}`}>↓</button>
                  <button type="button" className="merge-edit" aria-expanded={editing === it.file.id}
                          onClick={() => setEditing(editing === it.file.id ? null : it.file.id)}>
                    {it.range.trim() ? "改页码" : "选页码"}
                  </button>
                  <button type="button" className="merge-remove" aria-label={`移除 ${it.file.name}`}
                          onClick={() => setItems((old) => old.filter((x) => x.file.id !== it.file.id))}>×</button>
                </div>
              </div>
              {editing === it.file.id && (
                <input className="input merge-range" value={it.range} placeholder={`全部 ${it.file.pages || "?"} 页；或输入 1-10`}
                       aria-label={`${it.file.name} 取用页码`}
                       onChange={(e) => setItems((old) => old.map((x) => x.file.id === it.file.id ? { ...x, range: e.target.value } : x))} />
              )}
            </div>
          ))}

          <button ref={addDropRef} type="button" className="merge-add" onClick={pick}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void add(Array.from(e.dataTransfer.files)); }}>＋ 添加 PDF</button>
          <input ref={inputRef} type="file" hidden multiple accept=".pdf" onChange={(e) => { add(Array.from(e.target.files || [])); e.target.value = ""; }} />
          {files.some((f) => f.kind === "pdf" && !items.some((x) => x.file.id === f.id)) && (
            <div className="merge-recent">
              {files.filter((f) => f.kind === "pdf" && !items.some((x) => x.file.id === f.id)).slice(0, 4).map((f) => (
                <button type="button" key={f.id} onClick={() => setItems((old) => [...old, { file: f, range: "" }])}>＋ {f.name}</button>
              ))}
            </div>
          )}
        </section>

        <aside className="task-side-card merge-check">
          <h2>生成前核对</h2>
          {doneFile ? (
            <div className="convert-done" role="status">
              <h3>合并完成</h3>
              <p>{doneFile.name} 已生成{doneFile.path ? ` · ${doneFile.path}` : ""}；原文件保持不变。</p>
              <div className="pages-save-actions">
                <button type="button" className="btn" onClick={() => openPath({ id: doneFile.id }).catch(() => {})}>打开位置</button>
                <button type="button" className="btn primary" onClick={() => openFile(doneFile)}>打开阅读</button>
              </div>
              <button type="button" className="btn sm ghost" onClick={() => { job.reset(); job.setParams({ ...job.params }); }} style={{ marginTop: 8 }}>再合并一次</button>
            </div>
          ) : job.busy ? (
            <div className="convert-running" role="status">
              <h3>{job.submitting ? "正在提交合并任务…" : job.task ? `合并中 · ${swordPct(job.task)}` : "合并中"}</h3>
              {!job.submitting && <SwordProgress value={job.task?.progress || 0} unknown={job.task?.progressKnown === false} label="合并 PDF" />}
              <button type="button" className="btn sm" onClick={() => job.cancel()} disabled={!job.task?.id || job.task.status === "cancelling"}>取消</button>
            </div>
          ) : (
            <>
              <p className="merge-estimate">预计生成 {pageCount || "—"} 页</p>
              {job.previewError && <p className="wf-error">{job.previewError}</p>}
              {job.runError && <p className="wf-error" role="alert">{job.runError}</p>}
              {job.preview && !job.preview.ok && job.preview.error && <p className="wf-error">{job.preview.error}</p>}
              {job.preview?.warnings?.map((w, i) => <p key={i} className="wf-warn">⚠ {w}</p>)}
              <label className="field"><span>文件名</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="输出文件名" />
              </label>
              <div className="field"><span>保存位置</span>
                <SaveLocationSelect mode={saveMode} customDir={dir} onMode={setSaveMode} onCustomDir={setDir} />
                {saveMode === "source" && items[0]?.file.source_dir && <p className="save-dir-hint" title={items[0].file.source_dir}>{items[0].file.source_dir}</p>}
              </div>
              {job.preview?.outputs?.[0] && <p className="convert-preview">输出预览：{job.preview.outputs[0].name} · {job.preview.dir}</p>}
              <div className="merge-divider" />
              <button type="button" className="merge-run" disabled={!job.preview?.ok || items.length < 2} onClick={run}>
                开始合并
              </button>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
