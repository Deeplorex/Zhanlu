import React, { useEffect, useMemo, useState } from "react";
import { AppCtx } from "../../app/AppContext";
import { openPath } from "../../shared/api";
import { FolderPicker, useJob } from "../../shared/workflow";
import type { FileEntry } from "../../shared/types";

interface PageItem { page: number; rotate: number }

/**
 * 页面模式：整页多选网格（Figma 42）。
 * 就地上移/下移、左右旋转、删除；待应用变更同屏；另存为新 PDF，原文件不变。
 */
export default function PagesGrid({ file, total }: { file: FileEntry; total: number }) {
  const { openFile, refreshFiles, setPagesDirty } = React.useContext(AppCtx);
  const job = useJob("organize");
  const [plan, setPlan] = useState<PageItem[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [dragged, setDragged] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [dir, setDir] = useState<string | null>(null);

  useEffect(() => {
    setPlan(Array.from({ length: total }, (_, i) => ({ page: i + 1, rotate: 0 })));
    setSel(new Set());
    setName(file.name.replace(/\.pdf$/i, "") + "-整理.pdf");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, total]);

  const selList = useMemo(() => [...sel].sort((a, b) => a - b), [sel]);
  const contiguous = selList.length > 0 && selList.every((v, i) => i === 0 || v === selList[i - 1] + 1);

  const summary = useMemo(() => {
    const rotated = plan.filter((p) => p.rotate % 360 !== 0);
    const kept = new Set(plan.map((p) => p.page));
    const dropped: number[] = [];
    for (let i = 1; i <= total; i++) if (!kept.has(i)) dropped.push(i);
    const reordered = plan.some((p, i) => p.page !== i + 1);
    return { rotated, dropped, reordered, changed: rotated.length > 0 || dropped.length > 0 || reordered, count: plan.length };
  }, [plan, total]);

  useEffect(() => {
    if (!plan.length) return;
    job.setParams({ id: file.id, plan, name, dir: dir || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, plan, name, dir]);

  // 未应用变更上报：阅读/页面工具组的打印须提示使用已保存版本；已生成新 PDF 后视为已应用
  const applied = job.done?.status === "done";
  useEffect(() => { setPagesDirty(summary.changed && !applied); }, [summary.changed, applied, setPagesDirty]);

  const toggle = (idx: number) => setSel((s) => {
    const n = new Set(s);
    if (n.has(idx)) n.delete(idx); else n.add(idx);
    return n;
  });

  const moveBlock = (offset: -1 | 1) => {
    if (!contiguous) return;
    const startIdx = selList[0];
    const endIdx = selList[selList.length - 1];
    if (offset === -1 && startIdx === 0) return;
    if (offset === 1 && endIdx === plan.length - 1) return;
    setPlan((old) => {
      const n = [...old];
      if (offset === -1) {
        const [prev] = n.splice(startIdx - 1, 1);
        n.splice(endIdx, 0, prev);
      } else {
        const [next] = n.splice(endIdx + 1, 1);
        n.splice(startIdx, 0, next);
      }
      return n;
    });
    setSel(new Set(selList.map((idx) => idx + offset)));
  };

  const rotateSel = (angle: number) => {
    setPlan((old) => old.map((p, i) => (sel.has(i) ? { ...p, rotate: (p.rotate + angle) % 360 } : p)));
  };
  const deleteSel = () => {
    if (plan.length - sel.size < 1) return;
    setPlan((old) => old.filter((_, i) => !sel.has(i)));
    setSel(new Set());
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const cur = Number((e.target as HTMLElement).closest<HTMLElement>("[data-idx]")?.dataset.idx ?? selList.at(-1) ?? 0);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const columns = getComputedStyle(e.currentTarget).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
      const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? columns : -columns;
      const next = Math.min(plan.length - 1, Math.max(0, cur + delta));
      setSel(new Set([next]));
      (e.currentTarget.querySelector(`[data-idx="${next}"]`) as HTMLElement | null)?.focus();
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle(cur);
    }
  };

  const run = async () => {
    const t = await job.run();
    if (t?.status === "done") await refreshFiles();
  };

  const doneFile = job.done?.status === "done" ? (job.done.result?.file as FileEntry | undefined) : undefined;
  const pct = Math.round((job.task?.progress || 0) * 100);

  const selLabel = selList.length === 0 ? "" : `已选择：${selList.map((i) => plan[i]?.page).filter(Boolean).join("、")}`;

  return (
    <div className="pages-workspace">
      <section className="pages-card" aria-label="整理当前 PDF">
        <div className="pages-head">
          <h2>整理当前 PDF</h2>
          <span className="pages-count">{summary.count} 页{sel.size ? ` · 已选 ${sel.size} 页` : ""}</span>
        </div>

        {sel.size > 0 && (
          <div className="pages-selection" role="toolbar" aria-label="所选页面操作">
            <span className="pages-sel-label">{selLabel}</span>
            <div className="pages-sel-actions">
              <button type="button" disabled={!contiguous} title={contiguous ? "" : "仅连续多页可整体移动"} onClick={() => moveBlock(-1)}>上移</button>
              <button type="button" disabled={!contiguous} title={contiguous ? "" : "仅连续多页可整体移动"} onClick={() => moveBlock(1)}>下移</button>
              <button type="button" onClick={() => rotateSel(-90)}>↺ 左转</button>
              <button type="button" onClick={() => rotateSel(90)}>↻ 右转</button>
              <button type="button" disabled={plan.length - sel.size < 1} onClick={deleteSel}>删除所选</button>
            </div>
          </div>
        )}

        <div className="pgrid pages-grid" role="listbox" aria-multiselectable="true" aria-label="页面网格" onKeyDown={onGridKey}>
          {plan.map((p, idx) => (
            <div key={`${p.page}-${idx}`}
                 className={"pg" + (sel.has(idx) ? " on" : "")}
                 data-idx={idx}
                 tabIndex={0}
                 role="option"
                 aria-selected={sel.has(idx)}
                 aria-label={`第 ${p.page} 页${p.rotate ? `，旋转 ${p.rotate}°` : ""}`}
                 draggable
                 onDragStart={() => setDragged(idx)}
                 onDragOver={(e) => e.preventDefault()}
                 onDrop={(e) => { e.preventDefault(); if (dragged != null && dragged !== idx) {
                   setPlan((old) => { const n = [...old]; n.splice(idx, 0, ...n.splice(dragged, 1)); return n; });
                   setSel(new Set());
                 } setDragged(null); }}
                 onDragEnd={() => setDragged(null)}
                 onClick={() => toggle(idx)}
                 onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(idx); } }}>
              <span className="box">
                {sel.has(idx) && <span className="check" aria-hidden="true">✓</span>}
                <img src={`/api/files/${file.id}/thumb?page=${p.page}&dpi=26`} alt="" loading="lazy"
                     style={p.rotate % 360 !== 0 ? { transform: `rotate(${p.rotate}deg)` } : undefined} />
              </span>
              <span className="no">{idx + 1}<small>{p.page !== idx + 1 ? `原${p.page}` : ""}</small></span>
            </div>
          ))}
          {!plan.length && <div className="note">等待文档打开…</div>}
        </div>

        {summary.changed && !job.busy && !doneFile && (
          <div className="pages-summary">
            <span>
              待应用变更：
              {[
                summary.reordered ? "页序有调整" : "",
                summary.dropped.length ? `删除 ${summary.dropped.length} 页（${summary.dropped.slice(0, 8).join(",")}${summary.dropped.length > 8 ? "…" : ""}）` : "",
                summary.rotated.length ? `旋转 ${summary.rotated.length} 页` : "",
              ].filter(Boolean).join("；")}
            </span>
            <span className="pages-summary-actions">
              <button type="button" onClick={() => { setPlan(Array.from({ length: total }, (_, i) => ({ page: i + 1, rotate: 0 }))); setSel(new Set()); }}>取消变更</button>
              <button type="button" className="accent" onClick={() => setSaving(true)}>应用并另存为新 PDF →</button>
            </span>
          </div>
        )}
        {job.busy && (
          <div className="pages-summary busy" role="status">
            <span>{job.submitting ? "正在提交整理任务…" : `正在生成新 PDF · ${pct}%`}</span>
            <button type="button" onClick={() => job.cancel()} disabled={!job.task?.id || job.task.status === "cancelling"}>取消</button>
          </div>
        )}
      </section>

      {saving && (
        <div className="pages-save-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !job.busy) setSaving(false); }}>
          <div className="pages-save" role="dialog" aria-modal="true" aria-label="另存为新 PDF">
            {doneFile ? (
              <>
                <h2>整理完成</h2>
                <p className="pages-save-sub">{doneFile.name} 已生成；原文件保持不变。</p>
                <div className="pages-save-actions">
                  <button type="button" className="btn" onClick={() => openPath({ id: doneFile.id }).catch(() => {})}>打开位置</button>
                  <button type="button" className="btn primary" onClick={() => { openFile(doneFile); setSaving(false); }}>打开阅读</button>
                </div>
              </>
            ) : (
              <>
                <h2>另存为新 PDF</h2>
                <p className="pages-save-sub">
                  将生成 {summary.count} 页
                  {summary.dropped.length ? `（删除 ${summary.dropped.length} 页）` : ""}
                  {summary.rotated.length ? `（旋转 ${summary.rotated.length} 页）` : ""}
                  ；原 PDF 不修改。
                </p>
                <label className="field"><span>文件名</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="输出文件名" />
                </label>
                <div className="field"><span>保存位置</span><FolderPicker dir={dir} onPick={setDir} /></div>
                {job.previewError && <p className="wf-error">{job.previewError}</p>}
                {job.runError && <p className="wf-error" role="alert">{job.runError}</p>}
                {job.preview && !job.preview.ok && job.preview.error && <p className="wf-error">{job.preview.error}</p>}
                {job.preview?.warnings?.map((w, i) => <p key={i} className="wf-warn">⚠ {w}</p>)}
                <div className="pages-save-actions">
                  <button type="button" className="btn" disabled={job.busy} onClick={() => setSaving(false)}>取消</button>
                  <button type="button" className="btn primary" disabled={!job.preview?.ok || job.busy || !file} onClick={run}>
                    {job.busy ? `生成中 ${pct}%` : "开始生成"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
