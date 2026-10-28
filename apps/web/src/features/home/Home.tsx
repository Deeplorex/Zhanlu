import React, { useEffect, useRef, useState } from "react";
import { AppCtx } from "../../app/AppContext";
import { fmtSize, fmtTime, get, uploadFiles } from "../../shared/api";
import { openRegistered, pickPdfsNative } from "../../shared/nativeOpen";
import { swordPct } from "../../shared/SwordProgress";
import { useNativeDrop } from "../../shared/nativeDrag";
import type { FileEntry, Task, TaskKind } from "../../shared/types";

type PickerKind = "convert" | "merge" | "split";

/** 首页（Figma 67，2026-10-26）：打开 PDF + 直接开始三行（合并/转换/拆分）+ 最近文件 + 最近任务。
 *  AI 快捷卡并入右下湛卢气泡，不在首页重复摆放。 */
const ENTRIES: { kind: PickerKind; label: string }[] = [
  { kind: "merge", label: "合并 PDF" },
  { kind: "convert", label: "转换文件" },
  { kind: "split", label: "拆分 PDF" },
];

const ENTRY_TITLES: Record<PickerKind, string> = {
  convert: "转换 · 选择文件", merge: "合并 PDF · 选择文件",
  split: "拆分 PDF · 选择文件",
};

function pickerHint(k: PickerKind): string {
  return k === "convert"
    ? "PDF 单选转换；多张 PNG/JPG 合成一个 PDF，二者分开进行。"
    : k === "merge" ? "可连续添加；进入合并页后可排序、选页并设置输出。"
    : "进入拆分页选择规则；原文件保留。";
}

const TASK_KIND_LABELS: Record<string, string> = {
  merge: "合并", split: "拆分", convert_pdf: "转换", images_pdf: "图片转 PDF", ocr: "OCR", ai_analyze: "AI", organize: "页面整理",
};

export default function Home() {
  const { files, startTask, refreshFiles, toast, openFile } = React.useContext(AppCtx);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [chosen, setChosen] = useState<FileEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dragOpen, setDragOpen] = useState(false);
  const openInputRef = useRef<HTMLInputElement>(null);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const homeDropRef = useRef<HTMLElement>(null);
  const pickerDropRef = useRef<HTMLDivElement>(null);
  const recentPdfs = files.filter((f) => f.kind === "pdf");

  const openPicker = (k: PickerKind) => { setChosen([]); setPicker(k); };

  const addEntries = (filesToAdd: FileEntry[]) => {
    setChosen((old) => {
      const accepted = filesToAdd.filter((f, i, all) =>
        (picker === "convert" ? ["pdf", "image"].includes(f.kind) : f.kind === "pdf")
        && !old.some((x) => x.id === f.id) && all.findIndex((x) => x.id === f.id) === i);
      if (!accepted.length) return old;
      if (picker === "convert") {
        const kind = old[0]?.kind || accepted[0].kind;
        const sameKind = accepted.filter((f) => f.kind === kind);
        if (accepted.some((f) => f.kind !== kind)) toast("一次转换只能选同类文件。", true);
        if (kind === "pdf") return old.length ? old : sameKind.slice(0, 1);
        return [...old, ...sameKind];
      }
      if (picker === "split") return accepted.slice(0, 1);
      return [...old, ...accepted];
    });
  };

  const add = async (list: File[]) => {
    if (!list.length) return;
    setUploading(true);
    try {
      const r = await uploadFiles(list);
      await refreshFiles();
      addEntries(r.files);
    } catch (e) {
      toast(`添加失败：${(e as Error).message}`, true);
    } finally {
      setUploading(false);
    }
  };

  const pickTaskFiles = async () => {
    setUploading(true);
    try {
      const result = await pickPdfsNative(picker === "convert" ? "convert" : "pdf");
      if (result === null) { pickerInputRef.current?.click(); return; }
      if (result.cancelled) return;
      await refreshFiles();
      addEntries(result.files);
      if (result.errors.length) toast(`部分文件未能打开：${result.errors[0]}`, true);
    } catch (e) {
      toast(`添加失败：${(e as Error).message}`, true);
    } finally { setUploading(false); }
  };

  useNativeDrop(homeDropRef, (result) => {
    if (result.errors.length) toast(`部分文件未能打开：${result.errors[0]}`, true);
    const pdfs = result.files.filter((f) => f.kind === "pdf");
    if (pdfs.length !== result.files.length) toast("阅读只支持 PDF。", true);
    if (pdfs.length) { openRegistered(openFile, pdfs); void refreshFiles(); }
  });
  useNativeDrop(pickerDropRef, (result) => {
    if (result.errors.length) toast(`部分文件未能打开：${result.errors[0]}`, true);
    if (picker !== "convert" && result.files.some((f) => f.kind !== "pdf")) toast("请选择 PDF 文件。", true);
    addEntries(result.files);
    void refreshFiles();
  }, picker);

  const proceed = () => {
    if (!picker) return;
    const min = picker === "merge" ? 2 : 1;
    if (chosen.length < min) return;
    startTask(picker as TaskKind, chosen);
    setPicker(null);
    setChosen([]);
  };

  const openPdfs = async (list: File[]) => {
    const pdfs = list.filter((f) => /\.pdf$/i.test(f.name));
    if (!pdfs.length) { toast("请选择 PDF。", true); return; }
    setUploading(true);
    try {
      const r = await uploadFiles(pdfs);
      await refreshFiles();
      // 多选全部打开为标签；第一个文件保持为当前激活（重复文件由上传去重合并为原标签）
      const opened = r.files.filter((f) => f.kind === "pdf");
      opened.forEach((f) => openFile(f));
      if (opened[0]) openFile(opened[0]);
    } catch (e) {
      toast(`打开失败：${(e as Error).message}`, true);
    } finally { setUploading(false); }
  };

  // 桌面优先走原生选择：引擎登记真实路径（与源文件同目录可用）；旧引擎回退网页选择
  const openPdfsNative = async () => {
    if (uploading) return;
    setUploading(true);
    try {
      const r = await pickPdfsNative();
      if (r === null) { openInputRef.current?.click(); return; }
      if (r.cancelled) return;
      await refreshFiles();
      openRegistered(openFile, r.files);
      if (r.errors.length) toast(`部分文件未能打开：${r.errors[0]}`, true);
    } catch (e) {
      toast(`打开失败：${(e as Error).message}`, true);
    } finally { setUploading(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPicker(null); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const r = await get<{ tasks: Task[] }>("/api/tasks");
        if (!alive) return;
        setTasks(r.tasks || []);
      } catch { /* 保留上一次状态，稍后重试 */ }
      if (alive) timer = window.setTimeout(load, 3000);
    };
    void load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  return (
    <div className="home-start rise">
      <p className="page-kicker">首页 / 工作台</p>
      <h1 className="page-title">开始处理文档</h1>
      <div className="home-grid">
        <section ref={homeDropRef} className={"home-card home-open" + (dragOpen ? " over" : "")} aria-label="打开 PDF"
                 onDragOver={(e) => { e.preventDefault(); setDragOpen(true); }}
                 onDragLeave={() => setDragOpen(false)}
                 onDrop={(e) => { e.preventDefault(); setDragOpen(false); openPdfs(Array.from(e.dataTransfer.files)); }}>
          <h2>打开 PDF</h2>
          <button type="button" className="home-drop" onClick={() => void openPdfsNative()} disabled={uploading}>
            <span className="home-drop-plus" aria-hidden="true">＋</span>
            <span className="home-drop-text">拖入 PDF 或点击选择文件</span>
          </button>
          <input ref={openInputRef} type="file" hidden accept=".pdf" multiple
                 onChange={(e) => { openPdfs(Array.from(e.target.files || [])); e.target.value = ""; }} />
        </section>

        <section className="home-card" aria-label="直接开始">
          <h2>直接开始</h2>
          <div className="home-entries">
            {ENTRIES.map((entry) => (
              <button type="button" key={entry.kind} className="home-entry" onClick={() => openPicker(entry.kind)}>
                <span className="home-entry-copy">
                  <strong>{entry.label}</strong>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="home-card" aria-label="最近文件">
          <h2>最近文件</h2>
          {recentPdfs.length ? recentPdfs.slice(0, 4).map((file) => (
            <button type="button" key={file.id} className="home-file-row" onClick={() => openFile(file)} title={file.path || file.name}>
              <span className="home-file-copy">
                <strong>{file.name}</strong>
                <small>{file.pages ? `${file.pages} 页` : fmtSize(file.size)} · {fmtTime(file.mtime)}</small>
              </span>
              <span className="home-file-open">打开 ↗</span>
            </button>
          )) : <p className="home-empty">打开第一个 PDF 后会显示在这里。</p>}
        </section>

        <section className="home-card" aria-label="最近任务">
          <h2>最近任务</h2>
          {tasks.length ? tasks.slice(0, 4).map((task) => {
            const label = TASK_KIND_LABELS[task.kind] || task.kind;
            const running = task.status === "running" || task.status === "cancelling";
            const bad = task.status === "error" || task.status === "interrupted";
            return (
              <div key={task.id} className="home-task-row">
                <strong>{label} · {task.outputs?.[0]?.name || task.name}</strong>
                <span className={task.status === "done" ? "ok" : bad ? "bad" : running ? "run" : ""}>
                  {task.status === "done" ? "已完成" : bad ? "失败" : running ? `${task.status === "cancelling" ? "取消中" : "进行中"} · ${swordPct(task)}` : "已取消"}
                </span>
              </div>
            );
          }) : <p className="home-empty">还没有处理任务。</p>}
        </section>
      </div>

      {picker && (
        <div className="task-picker-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setPicker(null); }}>
          <div className="task-picker" role="dialog" aria-modal="true" aria-label={ENTRY_TITLES[picker]}>
            <div className="task-picker-head2">
              <div>
                <h2>{ENTRY_TITLES[picker]}</h2>
                <p>{chosen.length
                  ? `已选 ${chosen.length} ${chosen[0].kind === "image" ? "张图片" : "份 PDF"}${picker === "merge" ? "；可在下一步继续添加" : ""}`
                  : pickerHint(picker)}</p>
              </div>
              <button type="button" className="task-picker-x" onClick={() => setPicker(null)} aria-label="关闭">×</button>
            </div>

            {chosen.length > 0 && (
              <div className="picker-files">
                {chosen.map((f) => (
                  <div key={f.id} className="picker-file">
                    <strong title={f.name}>{f.name}</strong>
                    <small>{f.pages ? `${f.pages} 页 · ` : ""}{fmtSize(f.size)}</small>
                    <button type="button" onClick={() => setChosen((old) => old.filter((x) => x.id !== f.id))} aria-label={`移除 ${f.name}`}>×</button>
                  </div>
                ))}
              </div>
            )}

            <div ref={pickerDropRef} className="picker-add"
                   onDragOver={(e) => e.preventDefault()}
                   onDrop={(e) => { e.preventDefault(); add(Array.from(e.dataTransfer.files)); }}>
              <button type="button" disabled={uploading} onClick={() => void pickTaskFiles()}>
                {uploading ? "正在加入…" : picker === "merge" ? "＋  从本机添加更多 PDF，或拖入此处" : picker === "convert" ? "＋  从本机添加 PDF 或图片，或拖入此处" : "＋  从本机选择 PDF，或拖入此处"}
              </button>
              <input ref={pickerInputRef} type="file" hidden multiple={picker === "merge" || picker === "convert"}
                     accept={picker === "convert" ? ".pdf,.png,.jpg,.jpeg" : ".pdf"}
                     onChange={(e) => { add(Array.from(e.target.files || [])); e.target.value = ""; }} />
            </div>
            {(() => {
              const wanted = picker === "convert" ? ["pdf", "image"] : ["pdf"];
              const recent = files.filter((f) => wanted.includes(f.kind))
                .filter((f) => !chosen.some((x) => x.id === f.id));
              const candidates = picker === "convert"
                ? [...recent.filter((f) => f.kind === "pdf").slice(0, 4), ...recent.filter((f) => f.kind === "image").slice(0, 3)]
                : recent.slice(0, 4);
              if (!candidates.length) return null;
              return (
                <div className="picker-recent">
                  <small>或从最近文件选择：</small>
                  {candidates.map((f) => (
                    <button type="button" key={f.id} title={f.path || f.name} onClick={() => {
                      if (picker === "split" || (picker === "convert" && f.kind === "pdf")) setChosen([f]);
                      else if (picker === "convert") setChosen((old) => [...old.filter((x) => x.kind === "image"), f]);
                      else setChosen((old) => [...old, f]);
                    }}>＋ {f.name}</button>
                  ))}
                </div>
              );
            })()}
            <p className="task-picker-hint">文件仅在本机处理。</p>

            <div className="task-picker-actions2">
              <button type="button" className="btn" onClick={() => setPicker(null)}>取消</button>
              <button type="button" className="btn primary" disabled={uploading || chosen.length < (picker === "merge" ? 2 : 1)} onClick={proceed}>
                下一步 · 继续
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
