import React, { useEffect, useState } from "react";
import { AppCtx } from "../../app/AppContext";
import { openPath } from "../../shared/api";
import { useJob } from "../../shared/workflow";
import SaveLocationSelect, { type SaveMode } from "../../shared/SaveLocationSelect";
import type { FileEntry } from "../../shared/types";
import DropZone from "../../shared/components/DropZone";
import SwordProgress, { swordPct } from "../../shared/SwordProgress";

type Mode = "single" | "boundary" | "every" | "ranges";

const MODE_LABELS: Record<Mode, string> = {
  single: "拆成单页",
  boundary: "在第 N 页后拆分",
  every: "每 N 页一份",
  ranges: "自定义范围",
};

/** 独立拆分任务标签（Figma 43）：源文件入口、规则、源页预览与生成前核对同屏。 */
export default function SplitTask() {
  const { taskSeed, taskTabId, setTaskTabTitle, refreshFiles, openFile, tabs, toast } = React.useContext(AppCtx);
  const job = useJob("split");
  const [file, setFile] = useState<FileEntry | null>(null);
  const [mode, setMode] = useState<Mode>("boundary");
  const [boundary, setBoundary] = useState("3");
  const [every, setEvery] = useState("4");
  const [ranges, setRanges] = useState("");
  const [stem, setStem] = useState("");
  const [dir, setDir] = useState<string | null>(null);
  const [saveMode, setSaveMode] = useState<SaveMode>("default");
  const dirParam = saveMode === "source" ? "@source" : saveMode === "custom" ? dir || undefined : undefined;

  useEffect(() => {
    if (taskSeed?.kind === "split" && taskSeed.files[0]) {
      setFile(taskSeed.files[0]);
      setStem(taskSeed.files[0].name.replace(/\.pdf$/i, ""));
    }
  }, [taskSeed?.key]);

  useEffect(() => {
    if (!file) return;
    const params: Record<string, unknown> = { id: file.id, mode, stem };
    if (mode === "boundary") params.boundary = Number(boundary) || 0;
    if (mode === "every") params.every = Number(every) || 0;
    if (mode === "ranges") params.ranges = ranges;
    if (dirParam) params.dir = dirParam;
    job.setParams(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, mode, boundary, every, ranges, stem, dirParam]);

  const outCount = job.preview?.outputs?.length || 0;
  useEffect(() => {
    if (!taskTabId) return;
    setTaskTabTitle(taskTabId, outCount > 0 ? `拆分 · ${outCount} 份` : "拆分");
  }, [taskTabId, outCount, setTaskTabTitle]);

  const added = (entries: FileEntry[]) => {
    const pdf = entries.find((f) => f.kind === "pdf");
    if (!pdf) { toast("拆分只支持 PDF", true); return; }
    setFile(pdf);
    setStem(pdf.name.replace(/\.pdf$/i, ""));
    refreshFiles();
  };

  const run = async () => {
    const t = await job.run();
    if (t?.status === "done") await refreshFiles();
  };

  const backToSource = () => {
    const src = taskSeed?.files?.[0];
    if (src && tabs.some((t) => t.id === src.id)) openFile(src);
    else location.hash = "#/home";
  };

  const total = file?.pages || 0;
  const doneFiles = job.done?.status === "done" ? (job.done.result?.files as FileEntry[]) || [] : [];
  const pct = Math.round((job.task?.progress || 0) * 100);
  const rangeText = job.preview?.outputs?.map((o) => o.range).filter(Boolean).join(" ＋ ") || "";

  const rangeLabel = mode === "boundary"
    ? (Number(boundary) > 0 && total ? `第 1-${boundary} 页 | 第 ${Number(boundary) + 1}-${total} 页` : "")
    : mode === "single" ? `${total || "?"} 个单页`
    : mode === "every" ? `每 ${every} 页一份`
    : ranges ? ranges : "按填写的区间导出";

  return (
    <div className="task-full">
      <div className="task-context-row">
        <span className="task-crumb"><strong>拆分任务</strong><span className="task-crumb-sep">/</span>源文件：{file?.name || "未选择"}</span>
        <button type="button" className="task-crumb-back" onClick={backToSource}>返回源文档 ↗</button>
      </div>
      <div className="task-toolbar-row">
        <button type="button" className="tlink" onClick={() => { if (file) openFile(file); else location.hash = "#/home"; }}>整理当前 PDF</button>
        <button type="button" className="tlink on" aria-current="page">拆分成多个 PDF</button>
        <button type="button" className="tlink" onClick={() => (location.hash = "#/merge")}>合并多份 PDF</button>
        <span className="spacer" />
        <span className="tnote accent-note">独立任务标签 · 源文件不变</span>
      </div>

      <div className="task-content">
        <section className="task-main-card">
          <h2>拆分成多个 PDF</h2>
          <p className="task-card-sub">{file ? `${file.name} · 共 ${total || "?"} 页` : "先选择要拆分的 PDF"}</p>

          {!file ? (
            <DropZone multiple={false} accept=".pdf" formats="PDF" onAdded={added} note="拆分不打开阅读器；可从最近文件更换" />
          ) : (
            <>
              <span className="convert-label">拆分位置</span>
              <div className="split-rule" role="radiogroup" aria-label="拆分规则">
                <select className="input" value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label="拆分方式">
                  {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
                    <option key={m} value={m}>{MODE_LABELS[m]}</option>
                  ))}
                </select>
                {mode === "boundary" && (
                  <label className="split-rule-inline">在第
                    <input className="input" type="number" min="1" max={Math.max(1, total - 1)} value={boundary}
                           aria-label="分割页码" onChange={(e) => setBoundary(e.target.value)} /> 页后拆分
                  </label>
                )}
                {mode === "every" && (
                  <label className="split-rule-inline">每
                    <input className="input" type="number" min="1" max={total || 1} value={every}
                           aria-label="每份页数" onChange={(e) => setEvery(e.target.value)} /> 页一份
                  </label>
                )}
                {mode === "ranges" && (
                  <input className="input" value={ranges} onChange={(e) => setRanges(e.target.value)}
                         placeholder="例如 1-5,6-12,13-24" aria-label="页码范围" />
                )}
                <span className="split-rule-ranges">{rangeLabel || rangeText}</span>
              </div>

              <span className="convert-label">源页预览</span>
              <div className="split-preview-row">
                {(job.preview?.outputs || []).slice(0, 2).map((o, i) => {
                  const first = Number(String(o.range || "").split(/[-–,，]/)[0]) || i * 8 + 1;
                  const shown = Math.min(3, o.pages || 0);
                  return (
                    <div className="split-preview-card" key={i}>
                      <p className="split-preview-head">文件 {i + 1} · {o.range || `共 ${o.pages ?? "?"} 页`}</p>
                      <div className="split-thumbs">
                        {Array.from({ length: shown }, (_, k) => (
                          <figure key={k}>
                            <img src={`/api/files/${file.id}/thumb?page=${first + k}&dpi=26`} alt="" loading="lazy" />
                            <figcaption>{first + k}</figcaption>
                          </figure>
                        ))}
                        {(o.pages || 0) > 3 && <span className="split-more">… 第 {first + (o.pages || 0) - 1} 页</span>}
                      </div>
                    </div>
                  );
                })}
                {!job.preview && <div className="note">填写规则后这里显示各份的页码。</div>}
              </div>
              <p className="task-card-note">原 PDF 不修改。生成前可在右侧核对文件名、页数和保存位置。</p>
            </>
          )}
        </section>

        <aside className="task-side-card">
          <h2>生成前核对</h2>
          <p className="task-card-sub">{job.preview?.summary || `将生成 ${outCount || "?"} 个 PDF`}</p>

          {doneFiles.length ? (
            <div className="convert-done" role="status">
              <h3>拆分完成 · {doneFiles.length} 个文件</h3>
              <p>{rangeText || "均已保存"}；原文件保持不变。</p>
              <div className="pages-save-actions">
                <button type="button" className="btn" onClick={() => openPath({ id: doneFiles[0].id }).catch(() => {})}>打开结果位置</button>
                <button type="button" className="btn primary" onClick={() => openFile(doneFiles[0])}>打开阅读</button>
              </div>
              <button type="button" className="btn sm ghost" onClick={job.reset} style={{ marginTop: 8 }}>再拆一次</button>
            </div>
          ) : job.busy ? (
            <div className="convert-running" role="status">
              <h3>{job.submitting ? "正在提交拆分任务…" : job.task ? `拆分中 · ${swordPct(job.task)}` : "拆分中"}</h3>
              {!job.submitting && <SwordProgress value={job.task?.progress || 0} unknown={job.task?.progressKnown === false} label="拆分 PDF" />}
              <button type="button" className="btn sm" onClick={() => job.cancel()} disabled={!job.task?.id || job.task.status === "cancelling"}>取消</button>
            </div>
          ) : (
            <>
              <div className="split-outputs">
                {(job.preview?.outputs || []).slice(0, 6).map((o, i) => (
                  <div className="split-output-row" key={i}>
                    <strong>{String(i + 1).padStart(2, "0")} {o.name}</strong>
                    <span>{o.range ? `第 ${o.range} 页` : ""}{o.pages ? ` · ${o.pages} 页` : ""}</span>
                  </div>
                ))}
                {(job.preview?.outputs?.length || 0) > 6 && (
                  <p className="note">其余 {outCount - 6} 份按相同规则命名。</p>
                )}
              </div>
              {job.previewError && <p className="wf-error">{job.previewError}</p>}
              {job.runError && <p className="wf-error" role="alert">{job.runError}</p>}
              {job.preview && !job.preview.ok && job.preview.error && <p className="wf-error">{job.preview.error}</p>}
              {job.preview?.warnings?.map((w, i) => <p key={i} className="wf-warn">⚠ {w}</p>)}

              <div className="field"><span>保存位置</span>
                <SaveLocationSelect mode={saveMode} customDir={dir} onMode={setSaveMode} onCustomDir={setDir} />
                {saveMode === "source" && file?.source_dir && <p className="save-dir-hint" title={file.source_dir}>{file.source_dir}</p>}
              </div>
              <p className="task-card-note">{saveMode === "source"
                ? "与源文件同目录保存；同名自动追加编号，不会覆盖已有文件。"
                : "若文件同名，请更名或换目录；不会覆盖已有文件。"}</p>

              <button type="button" className="convert-run" disabled={!job.preview?.ok || !file} onClick={run}>
                开始拆分 →
              </button>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
