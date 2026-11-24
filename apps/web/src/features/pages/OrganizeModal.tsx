import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FileEntry } from "../../shared/types";
import { importProbe, openPath, parsePages, pickFolder, pickSourcePdf } from "../../shared/api";
import type { ImportProbe } from "../../shared/api";
import SwordProgress from "../../shared/SwordProgress";
import { shortDir } from "../../shared/SaveLocationSelect";
import type { useJob } from "../../shared/workflow";
import * as P from "./plan";

/** 页面整理的弹窗阶段：插入 / 移动 / 另存核对 → 生成中 → 失败（可返回核对或重试）/ 完成 */
export type ModalKind = "insert" | "move" | "save" | "running" | "failed" | "done";

type Job = ReturnType<typeof useJob>;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------- 对话框基座

/** 模态对话框（Figma 137–168 弹窗规格）：打开时焦点进入，Tab 循环在内部，
 *  Esc 等同取消，关闭后焦点回到触发控件。dismiss=false 的阶段（生成中）只保留明确按钮。 */
function OrganizeDialog({ title, context, phase, variant, dismiss = true, onClose, focusToken, children }: {
  title: string; context?: string; phase: ModalKind; variant: string; dismiss?: boolean; onClose: () => void;
  /** 变化时重新把焦点交给当前阶段的主要控件（如取消按钮由禁用变为可用） */
  focusToken?: unknown;
  children: React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const titleId = useId();

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      const box = boxRef.current;
      if (!box) return;
      if (e.key === "Escape") {
        if (!dismissRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !box.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !box.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);

  // 阶段切换（另存 → 生成中 → 失败／完成）后，焦点交给新内容的主要控件；目标此刻禁用则等它可用（focusToken）再交
  useEffect(() => {
    const box = boxRef.current;
    const target = box?.querySelector<HTMLElement>("[data-autofocus]") ?? box?.querySelector<HTMLElement>(FOCUSABLE);
    if (target && !(target as HTMLButtonElement).disabled) target.focus({ preventScroll: true });
  }, [phase, focusToken]);

  return (
    <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && dismissRef.current) closeRef.current(); }}>
      <div className={"dlg " + variant} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={boxRef}>
        <h2 className="dlg-title" id={titleId}>{title}</h2>
        {context != null && <p className="dlg-context">{context}</p>}
        {children}
      </div>
    </div>
  );
}

/** 选择框（139/143/165）：显示当前项文案与紧跟其后的箭头；原生 select 透明覆盖其上，键盘与原生弹出菜单照常可用 */
function SelectBox({ id, value, options, onChange, label, autofocus }: {
  id: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void;
  label: string; autofocus?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <div className="dlg-select">
      <span className="val">{current?.label ?? ""}</span>
      <span className="caret" aria-hidden="true">⌄</span>
      <select id={id} value={value} aria-label={label} data-autofocus={autofocus ? "" : undefined}
              onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

type Tone = "info" | "error";

// ---------------------------------------------------------------- 插入页

type ImportSource = { entry: FileEntry; probe: ImportProbe | null };
type Parsed = { state: "ok"; pages: number[] } | { state: "invalid"; message: string };

function InsertDialog({ file, plan, sel, resolveSize, initialSource, onRememberSource, onImportSizes, onClose, onInsert }: {
  file: FileEntry; plan: P.PageInstance[]; sel: Set<string>;
  resolveSize: (src: P.PageSource) => [number, number] | null | undefined;
  initialSource: FileEntry | null; onRememberSource: (entry: FileEntry) => void;
  onImportSizes: (fileId: string, sizes: Array<[number, number]>) => void;
  onClose: () => void; onInsert: (items: P.PageInstance[], at: number) => void;
}) {
  const [mode, setMode] = useState<"blank" | "pdf">("blank");
  const [position, setPosition] = useState(() => {
    const lastSelected = P.selectedIndices(plan, sel).at(-1);
    return lastSelected === undefined ? "end" : `after-${plan[lastSelected].id}`;
  });
  const [source, setSource] = useState<ImportSource | null>(
    () => initialSource ? { entry: initialSource, probe: null } : null,
  );
  const [pagesText, setPagesText] = useState("");
  const [checked, setChecked] = useState<{ source: ImportSource; text: string; result: Parsed } | null>(null);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const mounted = useRef(false);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // 只对这次选中的来源更新探测结果。再次打开弹窗也会重验记住的来源。
  useEffect(() => {
    if (!source || source.probe) return;
    const { entry } = source;
    let alive = true;
    void importProbe(entry.id).then((probe) => {
      if (!alive) return;
      setSource({ entry, probe });
      if (probe.ok && probe.sizes) onImportSizes(entry.id, probe.sizes);
    }).catch((e: Error) => {
      if (alive) setSource({ entry, probe: { ok: false, pages: null, error: e.message, name: entry.name } });
    });
    return () => { alive = false; };
  }, [source, onImportSizes]);

  const choose = async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    setPicking(true);
    try {
      const r = await pickSourcePdf();
      // 取消系统对话框：保留当前选择，不打断整理
      if (!mounted.current || r.cancelled) return;
      const entry = r.files[0];
      if (r.errors.length || !entry) {
        setPickError(r.errors[0] || "无法读取所选 PDF，请重新选择。");
        return;
      }
      setPickError(null);
      setSource({ entry, probe: null });
      onRememberSource(entry);
    } catch (e) {
      if (mounted.current) setPickError((e as Error).message);
    } finally {
      pickingRef.current = false;
      if (mounted.current) setPicking(false);
    }
  };

  // 页范围交给引擎解析（与预览、执行同一套语法与校验）；空范围＝全部页
  const sourceReady = !!source?.probe?.ok;
  const rangeText = pagesText.trim();
  const parsed = checked?.source === source && checked.text === rangeText ? checked.result : null;
  useEffect(() => {
    if (mode !== "pdf" || !source?.probe?.ok || !rangeText) return;
    let alive = true;
    const t = setTimeout(() => {
      const finish = (result: Parsed) => { if (alive) setChecked({ source, text: rangeText, result }); };
      void parsePages(source.entry.id, rangeText)
        .then((r) => finish(r.ok && r.pages?.length
          ? { state: "ok", pages: r.pages }
          : { state: "invalid", message: r.error || "页码范围无效" }))
        .catch((e: Error) => finish({ state: "invalid", message: e.message }));
    }, 180);
    return () => { alive = false; clearTimeout(t); };
  }, [mode, source, rangeText]);

  const positionOptions = useMemo(() => P.positionOptions(plan), [plan]);
  const current = positionOptions.find((o) => o.value === position) ?? positionOptions.at(-1)!;

  // 反馈行：空白页说明沿用的尺寸；从 PDF 插入说明将插入的页与预览总页数（139/157/165）
  const refSize = P.pageSizeOf(current.anchor, resolveSize);
  const blankFeedback: { tone: Tone; text: string } = {
    tone: "info",
    text: refSize ? `插入 1 页 · 沿用第 ${current.page} 页显示尺寸` : "参考页尺寸尚不可用，可稍候或选择其他位置。",
  };
  const pdfFeedback = useMemo<{ tone: Tone; text: string }>(() => {
    if (pickError) return { tone: "error", text: pickError };
    if (!source) return { tone: "info", text: "请选择要插入的 PDF" };
    if (!source.probe) return { tone: "info", text: "正在读取…" };
    if (!source.probe.ok) return { tone: "error", text: `无法提取此 PDF 的页面：${source.probe.error || "无法读取"}。请选择允许提取的文件。` };
    if (rangeText && !parsed) return { tone: "info", text: "正在核对页范围…" };
    if (parsed?.state === "invalid") return { tone: "error", text: parsed.message };
    const count = parsed?.pages.length ?? source.probe.pages ?? 0;
    const what = parsed ? `将插入第 ${P.pageListText(parsed.pages)} 页` : `将插入全部 ${count} 页`;
    return { tone: "info", text: `${what} · 预览共 ${plan.length + count} 页` };
  }, [pickError, source, rangeText, parsed, plan.length]);
  const feedback = mode === "blank" ? blankFeedback : pdfFeedback;
  const canInsert = plan.length > 0 && !picking && (mode === "blank"
    ? !!refSize
    : sourceReady && !pickError && (!rangeText || parsed?.state === "ok"));

  const submit = () => {
    if (!canInsert) return;
    if (mode === "blank") {
      if (refSize) onInsert([P.makeBlank(...refSize)], current.at);
      return;
    }
    const probe = source?.probe;
    if (!source || !probe) return;
    const pages = parsed?.state === "ok" ? parsed.pages : Array.from({ length: probe.pages ?? 0 }, (_, i) => i + 1);
    if (!pages.length) return;
    onInsert(P.importInstances(source.entry, pages, file.id), current.at);
  };

  return (
    <form className="dlg-form" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="dlg-seg" role="radiogroup" aria-label="插入内容">
        <label className={"dlg-seg-opt" + (mode === "blank" ? " on" : "")}>
          <input type="radio" name="organize-insert-mode" value="blank" checked={mode === "blank"}
                 data-autofocus={mode === "blank" ? "" : undefined} onChange={() => setMode("blank")} />
          <i aria-hidden="true" />空白页
        </label>
        <label className={"dlg-seg-opt" + (mode === "pdf" ? " on" : "")}>
          <input type="radio" name="organize-insert-mode" value="pdf" checked={mode === "pdf"}
                 data-autofocus={mode === "pdf" ? "" : undefined} onChange={() => setMode("pdf")} />
          <i aria-hidden="true" />从本机 PDF
        </label>
      </div>

      {mode === "pdf" && (
        <>
          <div className="cfield">
            <label className="convert-label" htmlFor="organize-insert-source">来源 PDF</label>
            <div className="dlg-source">
              <div className="dlg-box" id="organize-insert-source" title={source?.entry.path ?? undefined}>
                {source ? `${source.entry.name}${source.probe?.pages ? "  ·  共 " + source.probe.pages + " 页" : ""}` : "尚未选择 PDF"}
              </div>
              <button type="button" className="dlg-ghost narrow right" aria-busy={picking} onClick={() => void choose()}>
                {picking ? "…" : source ? "更换" : "选择"}
              </button>
            </div>
          </div>
          <div className="cfield">
            <label className="convert-label" htmlFor="organize-insert-pages">页范围</label>
            <input id="organize-insert-pages" className="dlg-input" value={pagesText} spellCheck={false}
                   placeholder="留空为全部页，如 2,4 或 3-5" disabled={!sourceReady}
                   onChange={(e) => setPagesText(e.target.value)} />
          </div>
        </>
      )}

      <div className="cfield">
        <label className="convert-label" htmlFor="organize-insert-at">插入位置</label>
        <SelectBox id="organize-insert-at" label="插入位置" value={current.value} options={positionOptions} onChange={setPosition} />
      </div>

      <p className={"dlg-feedback " + feedback.tone} role="status">{feedback.text}</p>
      <div className="dlg-divider" />
      <div className="dlg-actions">
        <button type="button" className="dlg-btn" onClick={onClose}>取消</button>
        <button type="submit" className="dlg-btn primary" disabled={!canInsert}>插入</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 移动页

function MoveDialog({ plan, sel, onClose, onMove }: {
  plan: P.PageInstance[]; sel: Set<string>; onClose: () => void; onMove: (to: number) => void;
}) {
  const moving = useMemo(() => plan.filter((it) => sel.has(it.id)), [plan, sel]);
  const options = useMemo(() => P.positionOptions(plan, sel), [plan, sel]);
  // 默认选中第一个会真正改变顺序的目标
  const [position, setPosition] = useState(() => {
    const first = options.find((o) => !P.sameOrder(P.moveTo(plan, sel, o.at), plan)) ?? options[0];
    return first.value;
  });
  const current = options.find((o) => o.value === position) ?? options[0];
  const next = P.moveTo(plan, sel, current.at);
  const changed = !P.sameOrder(next, plan);
  const subject = moving.length === 1 ? `将${P.instanceName(moving[0])}移到` : `将已选的 ${moving.length} 页移到`;
  const targetText = current.side && current.anchor ? `${P.instanceName(current.anchor)}${current.side}` : current.label;

  return (
    <form className="dlg-form" onSubmit={(e) => { e.preventDefault(); if (changed) onMove(current.at); }}>
      <div className="cfield">
        <label className="convert-label" htmlFor="organize-move-to">目标位置</label>
        <SelectBox id="organize-move-to" label="目标位置" value={current.value} options={options}
                   onChange={setPosition} autofocus />
      </div>
      <div className="dlg-banner" role="status">{subject}{targetText}</div>
      <div className="dlg-divider" />
      <div className="dlg-actions">
        <button type="button" className="dlg-btn" onClick={onClose}>取消</button>
        <button type="submit" className="dlg-btn primary" disabled={!changed}>移动</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 另存核对

function SaveDialog({ name, onName, dir, onDir, job, onStart, onClose }: {
  name: string; onName: (v: string) => void; dir: string | null; onDir: (v: string | null) => void;
  job: Job; onStart: () => void; onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const [pickError, setPickError] = useState<string | null>(null);
  // 预览与执行共用引擎的页面计划校验：权限、页号、导入源、保存位置都在这里给出结果
  const error = pickError || job.previewError || (job.preview && !job.preview.ok ? job.preview.error : null);
  const choose = async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    setPickError(null);
    setPicking(true);
    try {
      const r = await pickFolder();
      // 取消系统对话框：保留此前选择
      if (!r.cancelled && r.path) onDir(r.path);
    } catch (e) {
      setPickError((e as Error).message);
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  };
  return (
    <form className="dlg-form" onSubmit={(e) => { e.preventDefault(); if (job.preview?.ok && !job.busy) onStart(); }}>
      <div className="cfield">
        <label className="convert-label" htmlFor="organize-save-name">文件名</label>
        <input id="organize-save-name" className="dlg-input" data-autofocus value={name} spellCheck={false}
               onChange={(e) => onName(e.target.value)} />
      </div>
      <div className="cfield">
        <label className="convert-label" htmlFor="organize-save-dir">保存位置</label>
        <div className="dlg-source">
          <div className={"dlg-box" + (dir ? " two" : "")} id="organize-save-dir" title={dir ?? undefined}>{dir ? shortDir(dir) : "应用输出目录（默认）"}</div>
          {dir && <button type="button" className="dlg-ghost left-of-right" onClick={() => onDir(null)}>恢复默认</button>}
          <button type="button" className="dlg-ghost right" aria-busy={picking} onClick={() => void choose()}>
            {picking ? "选择中…" : dir ? "更改" : "选择位置"}
          </button>
        </div>
      </div>
      <p className={"dlg-note" + (error ? " error" : "")} role={error ? "alert" : undefined}>
        {error ?? (dir ? `${dir} · 输出为新文件，原件保留。` : "输出为新文件，原件保留。")}
      </p>
      <div className="dlg-divider" />
      <div className="dlg-actions">
        <button type="button" className="dlg-btn" onClick={onClose}>取消</button>
        <button type="submit" className="dlg-btn primary" disabled={!name.trim() || !job.preview?.ok || job.busy}>开始生成</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 生成状态

/** 失败原因归类：标题说清是哪一类，正文给具体原因与下一步（159） */
export function failureInfo(message: string): { title: string; detail: string } {
  const msg = message.replace(/^(OpError|ValueError|PdfReadError):\s*/, "").trim();
  if (msg.includes("不可写")) return { title: "目标位置不可写", detail: "草稿已保留，可换一个位置后重试。" };
  if (msg.includes("限制修改或页面整理")) return { title: "该 PDF 不允许页面整理", detail: `${msg} 草稿已保留。` };
  if (msg.includes("禁止提取")) return { title: "导入的 PDF 禁止提取页面", detail: `${msg} 草稿已保留，可撤销后重新选择导入文件。` };
  if (msg.includes("已不存在")) return { title: "源文件已失效", detail: `${msg} 草稿已保留，可撤销后重新选择文件。` };
  if (msg.includes("已加密")) return { title: "文档已加密", detail: `${msg} 草稿已保留。` };
  if (msg.includes("同名")) return { title: "目标已有同名文件", detail: `${msg} 草稿已保留，可更改文件名后重试。` };
  return { title: "生成失败", detail: `${msg} 草稿已保留，可重试。` };
}

// ---------------------------------------------------------------- 宿主

export default function OrganizeModal(props: {
  modal: ModalKind;
  file: FileEntry;
  plan: P.PageInstance[];
  sel: Set<string>;
  resolveSize: (src: P.PageSource) => [number, number] | null | undefined;
  initialSource: FileEntry | null;
  onRememberSource: (entry: FileEntry) => void;
  onImportSizes: (fileId: string, sizes: Array<[number, number]>) => void;
  name: string; onName: (v: string) => void;
  dir: string | null; onDir: (v: string | null) => void;
  outDir: string | null;
  job: Job;
  summary: string;
  onClose: () => void;
  onInsert: (items: P.PageInstance[], at: number) => void;
  onMove: (to: number) => void;
  onStart: () => void;
  onCancelRun: () => void;
  onBackToSave: () => void;
  onRetry: () => void;
  onOpenFile: (f: FileEntry) => void;
}) {
  const { modal, file, plan, job } = props;
  const count = plan.length;

  if (modal === "insert") {
    return (
      <OrganizeDialog title="插入页" context={file.name} phase="insert" variant="dlg-insert" onClose={props.onClose}>
        <InsertDialog file={file} plan={plan} sel={props.sel} resolveSize={props.resolveSize}
                      initialSource={props.initialSource} onRememberSource={props.onRememberSource}
                      onImportSizes={props.onImportSizes}
                      onClose={props.onClose} onInsert={props.onInsert} />
      </OrganizeDialog>
    );
  }
  if (modal === "move") {
    return (
      <OrganizeDialog title="移动页" context={`已选${selectionSubject(plan, props.sel)}`} phase="move" variant="dlg-move" onClose={props.onClose}>
        <MoveDialog plan={plan} sel={props.sel} onClose={props.onClose} onMove={props.onMove} />
      </OrganizeDialog>
    );
  }
  if (modal === "save") {
    return (
      <OrganizeDialog title="另存为新 PDF" context={props.summary} phase="save" variant="dlg-save" onClose={props.onClose}>
        <SaveDialog name={props.name} onName={props.onName} dir={props.dir} onDir={props.onDir}
                    job={job} onStart={props.onStart} onClose={props.onClose} />
      </OrganizeDialog>
    );
  }
  if (modal === "running") {
    const task = job.task;
    const known = task?.progressKnown !== false;
    const pct = Math.round(Math.max(0, Math.min(1, task?.progress || 0)) * 100);
    return (
      <OrganizeDialog title="正在生成新 PDF" context={`${file.name}  ·  ${count} 页`} phase="running" dismiss={false}
                      variant="dlg-running" focusToken={!!task?.id} onClose={props.onClose}>
        <div className="dlg-block dlg-progress" role="status" aria-live="polite">
          <div className="dlg-progress-head">
            <span>{task?.detail || "正在组装页面"}</span>
            <span>{known ? `${pct}%` : "进度无法估算"}</span>
          </div>
          <SwordProgress className="dlg-sword" value={task?.progress || 0} unknown={!known} label="生成进度" />
        </div>
        <div className="dlg-divider" />
        <div className="dlg-actions">
          <button type="button" className="dlg-btn" data-autofocus onClick={props.onCancelRun}
                  disabled={!task?.id || task.status === "cancelling"}>{task?.status === "cancelling" ? "取消中…" : "取消生成"}</button>
        </div>
      </OrganizeDialog>
    );
  }
  if (modal === "failed") {
    const info = failureInfo(job.runError || job.task?.error || "任务失败");
    return (
      <OrganizeDialog title="生成失败" context={`${file.name}  ·  ${count} 页`} phase="failed" variant="dlg-result-state" onClose={props.onBackToSave}>
        <div className="dlg-block dlg-result" role="alert">
          <strong className="dlg-result-title error">{info.title}</strong>
          <span className="dlg-result-detail">{info.detail}</span>
        </div>
        <div className="dlg-divider" />
        <div className="dlg-actions">
          <button type="button" className="dlg-btn" onClick={props.onBackToSave}>返回核对</button>
          <button type="button" className="dlg-btn primary" data-autofocus onClick={props.onRetry}>重试</button>
        </div>
      </OrganizeDialog>
    );
  }
  // 完成
  const doneFile: FileEntry | undefined = job.done?.status === "done" ? job.done.result?.file : undefined;
  const savedDir = job.preview?.dir;
  const location = !savedDir || savedDir === props.outDir ? "应用输出目录" : savedDir;
  return (
    <OrganizeDialog title="整理完成" context={doneFile ? `${doneFile.name}  ·  共 ${count} 页` : undefined} phase="done" variant="dlg-result-state"
                    onClose={props.onClose}>
      {doneFile && (
        <>
          <div className="dlg-block dlg-result" role="status">
            <strong className="dlg-result-title ok">文件已保存</strong>
            <span className="dlg-result-detail" title={location}>{location}</span>
          </div>
          <div className="dlg-divider" />
          <div className="dlg-actions">
            <button type="button" className="dlg-btn" onClick={() => { openPath({ id: doneFile.id }).catch(() => {}); props.onClose(); }}>打开位置</button>
            <button type="button" className="dlg-btn primary" data-autofocus onClick={() => props.onOpenFile(doneFile)}>打开阅读</button>
          </div>
        </>
      )}
    </OrganizeDialog>
  );
}

/** 移动页弹窗的上下文行：「已选第 4 页 · 1 页」 */
function selectionSubject(plan: P.PageInstance[], sel: Set<string>): string {
  const pages = P.selectedIndices(plan, sel).map((i) => i + 1);
  return pages.length === 1 ? `第 ${pages[0]} 页 · 1 页` : `第 ${P.pageListText(pages)} 页 · ${pages.length} 页`;
}
