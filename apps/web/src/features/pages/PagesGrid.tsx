import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppCtx } from "../../app/AppContext";
import { useJob } from "../../shared/workflow";
import type { FileEntry } from "../../shared/types";
import * as P from "./plan";
import OrganizeModal, { type ModalKind } from "./OrganizeModal";
import { dropDraft, loadDraft, saveDraft, type Draft } from "./draftStore";

type Sizes = Array<[number, number]> | null | undefined;
type ModalState = ModalKind | null;

/** 拖动中的落点：raw＝指针所在间隙在当前网格中的位置（含被拖动的页） */
interface DragState { ids: Set<string>; raw: number; bar: { left: number; top: number; height: number } | null }

const DRAG_THRESHOLD = 5;

/** 指针落在第几张卡片之前（＝卡片数时为末尾）：按行优先比较，先看纵向再看横向中线 */
function gapIndexAt(grid: HTMLElement, clientX: number, clientY: number): number | null {
  const bounds = grid.getBoundingClientRect();
  if (clientX < bounds.left || clientX >= bounds.left + grid.clientWidth
      || clientY < bounds.top || clientY >= bounds.bottom) return null;
  const cards = grid.querySelectorAll<HTMLElement>(".pg");
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (clientY < r.top) return i;
    if (clientY <= r.bottom && clientX < r.left + r.width / 2) return i;
  }
  return cards.length;
}

/** 落点指示条（168：3 px 铜色竖条，位于两张卡片之间；行首行尾贴近相邻卡片外侧） */
function dropBarAt(grid: HTMLElement, raw: number): DragState["bar"] {
  const cards = grid.querySelectorAll<HTMLElement>(".pg");
  const before = cards[raw - 1];
  const after = cards[raw];
  const ref = before ?? after;
  if (!ref) return null;
  const top = ref.offsetTop + 4;
  const height = ref.offsetHeight - 8;
  let left: number;
  if (before && after && before.offsetTop === after.offsetTop) {
    left = (before.offsetLeft + before.offsetWidth + after.offsetLeft) / 2 - 1.5;
  } else if (after) {
    left = after.offsetLeft - 6;
  } else {
    left = (before as HTMLElement).offsetLeft + (before as HTMLElement).offsetWidth + 3;
  }
  // 网格区左右内边距（840 下为 0）决定落点条可放的范围，避免被滚动容器裁掉
  const pad = getComputedStyle(grid.parentElement as Element);
  const lo = 1 - (parseFloat(pad.paddingLeft) || 0);
  const hi = grid.clientWidth + (parseFloat(pad.paddingRight) || 0) - 4;
  return { left: Math.min(hi, Math.max(lo, left)), top, height };
}

/** 拖动时操作栏的落点说明：「移到第 2 页前」，落点两侧只剩被拖动的页时为文档首尾 */
function describeDrop(plan: P.PageInstance[], ids: Set<string>, raw: number): string | null {
  const before = plan.slice(0, raw).filter((it) => !ids.has(it.id));
  const after = plan.slice(raw).filter((it) => !ids.has(it.id));
  if (!before.length && !after.length) return null;
  if (!before.length) return "移到文档开头";
  if (!after.length) return "移到文档末尾";
  return `移到第 ${plan.indexOf(after[0]) + 1} 页前`;
}

/**
 * 页面模式（06 改版 137–168）：当前 PDF 的整页网格与常驻操作栏。
 * 插入、复制、移动、旋转、删除即时反映在草稿上；底部显示摘要、撤销、取消变更与另存。
 * 另存生成新 PDF，原文件不变。拖动用指针事件实现（桌面壳的原生文件拖放会拦截网页内 HTML5 拖放）。
 */
export default function PagesGrid({ file, total, sizes }: { file: FileEntry; total: number; sizes: Sizes }) {
  const { appInfo, openFile, refreshFiles, setPagesDirty, setPagesSavedAs } = React.useContext(AppCtx);
  const job = useJob("organize");
  // 切到别的标签再回来（组件重新挂载）时恢复该文件的草稿、撤销记录与输出参数
  const [draft, setDraft] = useState<Draft>(() => loadDraft(file.id)?.draft ?? { plan: P.initialPlan(total), sel: new Set(), last: null });
  const [history, setHistory] = useState<Draft[]>(() => loadDraft(file.id)?.history ?? []);
  const [appliedKey, setAppliedKey] = useState<string | null>(() => loadDraft(file.id)?.appliedKey ?? null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [name, setName] = useState(() => loadDraft(file.id)?.name ?? P.defaultName(file.name));
  const [dir, setDir] = useState<string | null>(() => loadDraft(file.id)?.dir ?? null);
  const [lastSource, setLastSource] = useState<FileEntry | null>(() => loadDraft(file.id)?.lastSource ?? null);
  const [importSizes, setImportSizes] = useState<Record<string, Array<[number, number]>>>(() => loadDraft(file.id)?.importSizes ?? {});
  const [drag, setDrag] = useState<DragState | null>(null);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dragRef = useRef<Set<string> | null>(null);
  const finishPointer = useRef<(() => void) | null>(null);
  useEffect(() => () => finishPointer.current?.(), []);
  const anchorRef = useRef<string | null>(null);
  const focusRequest = useRef(false);
  const focusIdRef = useRef<string | null>(null);
  focusIdRef.current = focusId;

  // 文档页数通常在挂载后才取到（挂载瞬间为 0）：草稿为空而页数已知时建立初始草稿。
  // 已有草稿——包括从仓库恢复的——不因页数迟到而被清掉。
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !total) return;
    seeded.current = true;
    if (draftRef.current.plan.length) return;
    const fresh: Draft = { plan: P.initialPlan(total), sel: new Set(), last: null };
    draftRef.current = fresh;
    setDraft(fresh);
  }, [total]);

  /** 应用一步草稿变更；record＝把变更前的草稿压入撤销栈（仅调整选区时不记录） */
  const commit = useCallback((update: (d: Draft) => Draft, record = true) => {
    const d = draftRef.current;
    if (record) setHistory((h) => [...h, d]);
    const next = update(d);
    draftRef.current = next;
    setDraft(next);
  }, []);

  const focusCard = useCallback((id: string) => {
    setFocusId(id);
    focusRequest.current = true;
  }, []);

  // 操作后的焦点：等新草稿渲染出来再把焦点交给目标卡片；工作区隐藏时不抢焦点
  useEffect(() => {
    if (!focusRequest.current) return;
    focusRequest.current = false;
    if (!focusId) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`.pg[data-id="${focusId}"]`);
    if (!el || !el.offsetParent) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusId, draft.plan, modal]);

  const plan = draft.plan;
  const sel = draft.sel;
  const selIdx = useMemo(() => P.selectedIndices(plan, sel), [plan, sel]);
  const contiguous = P.isContiguous(selIdx);
  const key = useMemo(() => P.contentKey(plan), [plan]);
  const original = P.isOriginal(plan, total);
  // 已另存：当前草稿与成功生成那一版内容相同（撤销回到该版本同样算已另存）
  const applied = !original && appliedKey !== null && key === appliedKey;
  const dirty = !original && !applied;

  useEffect(() => { setPagesDirty(dirty); }, [dirty, setPagesDirty]);
  useEffect(() => { setPagesSavedAs(applied); }, [applied, setPagesSavedAs]);

  const canMoveTo = sel.size > 0 && sel.size < plan.length;
  const canUp = contiguous && selIdx.length > 0 && selIdx.length < plan.length && selIdx[0] > 0;
  const canDown = contiguous && selIdx.length > 0 && selIdx.length < plan.length && selIdx[selIdx.length - 1] < plan.length - 1;
  const canDelete = sel.size > 0 && plan.length - sel.size >= 1;

  // 另存核对期间才向引擎要预览：预览与执行共用同一套页面计划校验（权限、页号、导入源、保存位置）
  useEffect(() => {
    if (modal !== "save") return;
    job.setParams({ id: file.id, plan: P.toJobPlan(plan), name: name.trim(), dir: dir || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, file.id, plan, name, dir]);

  // 预览未通过，而原因可能已在外部解决（源文件恢复、目录恢复可写）：另存核对打开期间每 3 秒重新核对一次
  const previewFailed = !!(job.previewError || (job.preview && !job.preview.ok));
  useEffect(() => {
    if (modal !== "save" || !previewFailed) return undefined;
    const timer = setTimeout(() => job.setParams({ ...job.params }), 3000);
    return () => clearTimeout(timer);
  }, [modal, previewFailed, job.preview, job.previewError, job]);

  const resolveSize = useCallback((src: P.PageSource): [number, number] | null | undefined =>
    src.kind === "doc" ? sizes?.[src.page - 1] : src.kind === "import" ? importSizes[src.file]?.[src.page - 1] : null,
  [sizes, importSizes]);
  const rememberImportSizes = useCallback((fileId: string, pageSizes: Array<[number, number]>) => {
    setImportSizes((old) => ({ ...old, [fileId]: pageSizes }));
  }, []);

  // 草稿留在仓库里，切到别的标签再回来时恢复；已是原始页序且无可撤销步骤时不保留
  useEffect(() => {
    if (original && !history.length && appliedKey === null) dropDraft(file.id);
    else saveDraft(file.id, { draft, history, appliedKey, dirty, name, dir, lastSource, importSizes });
  }, [file.id, draft, history, appliedKey, dirty, name, dir, lastSource, importSizes, original]);

  // 漫游焦点：只有焦点卡片在 Tab 顺序里；尚无焦点卡片时由第一张承担
  const tabStopId = focusId && plan.some((it) => it.id === focusId) ? focusId : plan[0]?.id;

  // ---- 草稿操作 ----

  /** 撤销：恢复上一步的页序与选区；焦点落到恢复后的第一张选中页（无选区则保持原焦点） */
  const undo = useCallback(() => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    draftRef.current = prev;
    setDraft(prev);
    const target = prev.plan.find((it) => prev.sel.has(it.id))
      ?? prev.plan.find((it) => it.id === focusIdRef.current) ?? prev.plan[0];
    if (target) focusCard(target.id);
  }, [history, focusCard]);

  const cancelChanges = () => {
    const fresh: Draft = { plan: P.initialPlan(total), sel: new Set(), last: null };
    draftRef.current = fresh;
    setDraft(fresh);
    setHistory([]);
    setFocusId(fresh.plan[0]?.id ?? null);
    focusRequest.current = true;
  };

  const insert = (items: P.PageInstance[], at: number) => {
    commit((d) => ({
      plan: P.insertAt(d.plan, at, items),
      sel: new Set(items.map((it) => it.id)),
      last: { kind: items[0].source.kind === "blank" ? "blank" : "insert", n: items.length },
    }));
    setModal(null);
    focusCard(items[0].id);
  };

  const copySel = () => {
    const d = draftRef.current;
    const result = P.copySelected(d.plan, d.sel);
    if (!result) return;
    commit(() => ({ plan: result.plan, sel: new Set(result.copies.map((it) => it.id)), last: { kind: "copy", n: result.copies.length } }));
    focusCard(result.copies[0].id);
  };

  const moveSel = (to: number) => {
    const d = draftRef.current;
    const next = P.moveTo(d.plan, d.sel, to);
    if (P.sameOrder(next, d.plan)) return;
    commit(() => ({ plan: next, sel: d.sel, last: { kind: "move", n: d.sel.size } }));
    setModal(null);
    focusCard(next.find((it) => d.sel.has(it.id))!.id);
  };

  const shift = (offset: -1 | 1) => {
    const d = draftRef.current;
    const next = P.shiftSelection(d.plan, d.sel, offset);
    if (!next) return;
    commit(() => ({ plan: next, sel: d.sel, last: { kind: "move", n: d.sel.size } }));
    focusCard(next.find((it) => d.sel.has(it.id))!.id);
  };

  const rotateSel = (angle: number) => {
    const d = draftRef.current;
    commit((cur) => ({ plan: P.rotateSelection(cur.plan, cur.sel, angle), sel: cur.sel, last: { kind: "rotate", n: d.sel.size } }));
  };

  const deleteSel = () => {
    const d = draftRef.current;
    if (!d.sel.size || d.plan.length - d.sel.size < 1) return;
    const next = P.removeSelection(d.plan, d.sel);
    if (!next) return;
    // 焦点落到第一处删除位置之后的可用页；末尾删除时为前一张
    const focus = next[Math.min(selIdx[0], next.length - 1)].id;
    commit(() => ({ plan: next, sel: new Set(), last: { kind: "delete", n: d.sel.size } }));
    focusCard(focus);
  };

  const toggle = (id: string) => {
    commit((d) => {
      const n = new Set(d.sel);
      if (n.has(id)) n.delete(id); else n.add(id);
      return { ...d, sel: n };
    }, false);
    anchorRef.current = id;
  };

  // ---- 生成 ----

  /** 点击「开始生成」时冻结当前草稿与输出参数；之后以任务的实际结果更新状态 */
  const start = async () => {
    setModal("running");
    const usedKey = P.contentKey(draftRef.current.plan);
    const task = await job.run();
    const outcome = job.outcome.current;
    if (task?.status === "done") {
      await refreshFiles();
      setAppliedKey(usedKey);
      setHistory([]);
      setModal("done");
    } else if (outcome?.status === "cancelled") {
      // 用户取消：回到网格，草稿与参数原样保留
      setModal(null);
    } else {
      setModal("failed");
    }
  };

  // ---- 键盘 ----

  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".pg");
    if (!card) return;
    const idx = Number(card.dataset.idx);
    const current = draftRef.current.plan;
    if (!Number.isInteger(idx) || !current[idx]) return;
    const cols = getComputedStyle(e.currentTarget).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
    const step = (delta: number, extend: boolean) => {
      e.preventDefault();
      const next = Math.min(current.length - 1, Math.max(0, idx + delta));
      const id = current[next].id;
      if (extend) {
        // Shift＋方向键：把锚点到新焦点之间并入连续选区，替换上一次扩展出的区间
        const anchor = current.find((it) => it.id === anchorRef.current)?.id ?? current[idx].id;
        anchorRef.current = anchor;
        const oldRange = P.rangeBetween(current, anchor, current[idx].id);
        const newRange = P.rangeBetween(current, anchor, id);
        commit((d) => {
          const n = new Set([...d.sel].filter((x) => !oldRange.has(x)));
          newRange.forEach((x) => n.add(x));
          return { ...d, sel: n };
        }, false);
      }
      focusCard(id);
    };
    const id = current[idx].id;
    switch (e.key) {
      case "ArrowRight": step(1, e.shiftKey); break;
      case "ArrowLeft": step(-1, e.shiftKey); break;
      case "ArrowDown": step(cols, e.shiftKey); break;
      case "ArrowUp": step(-cols, e.shiftKey); break;
      case "Home": step(-idx, e.shiftKey); break;
      case "End": step(current.length - 1 - idx, e.shiftKey); break;
      case " ": case "Enter": e.preventDefault(); toggle(id); break;
      case "Delete": case "Backspace": e.preventDefault(); deleteSel(); break;
      case "a": case "A":
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); commit((d) => ({ ...d, sel: new Set(d.plan.map((it) => it.id)) }), false); }
        break;
      default:
    }
  };

  /** 页面工作区内 Ctrl/Cmd+Z 撤销；输入框、选择框保留原生编辑键，弹窗打开时不作用于背后的草稿 */
  const onWorkspaceKey = (e: React.KeyboardEvent) => {
    if (modal) return;
    if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && !e.shiftKey
        && !(e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) {
      e.preventDefault();
      undo();
    }
  };

  // ---- 指针拖动（按住选中的页成组拖动；按下未选中的页则以它为唯一选中页）----

  const press = (e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || modal || finishPointer.current) return;
    const grid = gridRef.current;
    if (!grid) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const range = e.shiftKey;
    const additive = e.ctrlKey || e.metaKey;
    const wasSelected = draftRef.current.sel.has(id);
    let active = false;
    let scrollTimer: number | undefined;
    let scrollWay = 0;

    const stopScroll = () => {
      if (scrollTimer !== undefined) clearInterval(scrollTimer);
      scrollTimer = undefined;
      scrollWay = 0;
    };
    const showDrop = (clientX: number, clientY: number) => {
      const raw = gapIndexAt(grid, clientX, clientY);
      setDrag((d) => d && (d.raw === (raw ?? -1) ? d : {
        ids: d.ids, raw: raw ?? -1, bar: raw === null ? null : dropBarAt(grid, raw),
      }));
      return raw;
    };
    let pointer = { x: startX, y: startY };
    const track = (clientX: number, clientY: number) => {
      pointer = { x: clientX, y: clientY };
      const raw = showDrop(clientX, clientY);
      if (raw === null) { stopScroll(); return; }
      // 仅在网格内靠近边缘时滚动，并随滚动更新插入落点。
      const rect = grid.getBoundingClientRect();
      const edge = Math.min(36, rect.height / 3);
      const way = clientY < rect.top + edge ? -1 : clientY > rect.bottom - edge ? 1 : 0;
      if (way === scrollWay) return;
      stopScroll();
      if (way) {
        scrollWay = way;
        scrollTimer = window.setInterval(() => {
          grid.scrollTop += way * 12;
          showDrop(pointer.x, pointer.y);
        }, 30);
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      // 指针在窗口外松开时收不到 pointerup：没有按键按着的移动一律视为取消，避免之后误触发拖动
      if (!(ev.buttons & 1)) { onCancel(); return; }
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        active = true;
        const ids = wasSelected ? new Set(draftRef.current.sel) : new Set([id]);
        dragRef.current = ids;
        setDrag({ ids, raw: -1, bar: null });
      }
      track(ev.clientX, ev.clientY);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      stopScroll();
      finishPointer.current = null;
    };
    const onBlur = () => { cleanup(); dragRef.current = null; setDrag(null); };
    const onCancel = (ev?: PointerEvent) => {
      if (!ev || ev.pointerId === e.pointerId) onBlur();
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      cleanup();
      const ids = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      const raw = gapIndexAt(grid, ev.clientX, ev.clientY);
      if (raw === null) return;
      if (ids) {
        // 落点换算到剩余（未被拖动）序列；落回原处不产生变更
        const d = draftRef.current;
        const to = d.plan.slice(0, raw).filter((it) => !ids.has(it.id)).length;
        const next = P.moveTo(d.plan, ids, to);
        if (P.sameOrder(next, d.plan)) return;
        commit(() => ({ plan: next, sel: ids, last: { kind: "move", n: ids.size } }));
        focusCard(next.find((it) => ids.has(it.id))!.id);
        return;
      }
      // 没有拖动即点击（与 WPS／Acrobat 缩略图一致）：
      // 单击只选这一页；Ctrl/Cmd＋单击切换该页；Shift＋单击选中锚点到该页的连续区间
      const anchor = anchorRef.current;
      const current = draftRef.current.plan;
      if (range && anchor && current.some((it) => it.id === anchor)) {
        commit((d) => ({ ...d, sel: P.rangeBetween(d.plan, anchor, id) }), false);
        setFocusId(id);
        return;
      }
      if (additive) toggle(id);
      else {
        commit((d) => ({ ...d, sel: new Set([id]) }), false);
        anchorRef.current = id;
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    finishPointer.current = cleanup;
  };

  // ---- 呈现 ----

  const selInfo = P.selectionLabel(plan, sel);
  let dropLabel: string | null = null;
  if (drag && drag.raw >= 0) {
    const to = plan.slice(0, drag.raw).filter((it) => !drag.ids.has(it.id)).length;
    if (!P.sameOrder(P.moveTo(plan, drag.ids, to), plan)) dropLabel = describeDrop(plan, drag.ids, drag.raw);
  }
  const summary = original ? "暂无变更"
    : applied ? `已另存为新 PDF · 共 ${plan.length} 页`
    : draft.last ? P.describeChange(draft.last, plan.length) : "";
  const saveSummary = useMemo(() => modal === "save" ? P.describeOutput(plan, total) : summary, [modal, plan, total, summary]);

  return (
    <div className="pages-workspace" ref={workspaceRef} onKeyDown={onWorkspaceKey}>
      <section className="pages-card" aria-label="整理当前 PDF">
        <div className="pages-head">
          <h2>整理当前 PDF</h2>
          <span className="pages-count">共 {plan.length} 页{sel.size ? ` · 已选 ${sel.size} 页` : ""}</span>
        </div>

        <div className="pages-actions" role="toolbar" aria-label="页面操作">
          <div className="pages-actions-label">
            {dropLabel ? <span aria-live="polite">{dropLabel}</span>
              : selInfo ? (<><span>{selInfo.main}</span>{selInfo.note && <span className="pages-actions-note">{selInfo.note}</span>}</>)
              : <span>未选中页面</span>}
          </div>
          <div className="pages-actions-buttons">
            <button type="button" className="pgtool always" disabled={!plan.length} onClick={() => setModal("insert")}>插入页</button>
            <button type="button" className="pgtool" disabled={!sel.size} onClick={copySel}>复制页</button>
            <button type="button" className="pgtool" disabled={!canMoveTo} onClick={() => setModal("move")}>移动到…</button>
            <button type="button" className="pgtool" disabled={!canUp} title={sel.size && !contiguous ? "仅连续多页可整体移动" : undefined} onClick={() => shift(-1)}>上移</button>
            <button type="button" className="pgtool" disabled={!canDown} title={sel.size && !contiguous ? "仅连续多页可整体移动" : undefined} onClick={() => shift(1)}>下移</button>
            <button type="button" className="pgtool" disabled={!sel.size} onClick={() => rotateSel(-90)}>左转</button>
            <button type="button" className="pgtool" disabled={!sel.size} onClick={() => rotateSel(90)}>右转</button>
            <button type="button" className="pgtool" disabled={!canDelete} title={!canDelete && sel.size ? "至少保留 1 页" : undefined} onClick={deleteSel}>删除页</button>
          </div>
        </div>

        <div className="pages-scroll" ref={gridRef}>
          <div className="pages-grid" role="listbox" aria-multiselectable="true" aria-label="页面网格" onKeyDown={onGridKey}>
            {plan.map((it, idx) => {
              const selected = sel.has(it.id);
              const deg = P.norm(it.rotate);
              const quarter = deg === 90 || deg === 270;
              const thumb = P.thumbSource(it, file.id);
              const s = it.source;
              const origin = s.kind === "blank" ? "，空白页"
                : s.kind === "import" ? `，导入自 ${s.name} 第 ${s.page} 页`
                : it.copy ? `，原第 ${s.page} 页的副本` : it.moved ? `，原第 ${s.page} 页` : "";
              const rotated = P.rotateLabel(deg);
              return (
                <div key={it.id} className={"pg" + (selected ? " on" : "")} data-id={it.id} data-idx={idx}
                     role="option" aria-selected={selected}
                     aria-label={`第 ${idx + 1} 页${origin}${rotated ? `，${rotated}` : ""}`}
                     tabIndex={it.id === tabStopId ? 0 : -1}
                     onFocus={() => setFocusId(it.id)}
                     onPointerDown={(e) => press(e, it.id)}
                     onClick={(e) => { if (e.detail === 0) toggle(it.id); }}>
                  <span className="box">
                    {/* 缩略图取自卡片对应的源页；转 90°/270° 后外接框宽高互换，按互换后的边界适配（CSS .quarter），旋转结果不被卡片裁切 */}
                    {thumb ? (
                      <img className={quarter ? "quarter" : undefined}
                           src={`/api/files/${thumb.fileId}/thumb?page=${thumb.page}&dpi=26`} alt="" loading="lazy" draggable={false}
                           style={deg ? { transform: `rotate(${deg}deg)` } : undefined} />
                    ) : s.kind === "blank" ? (
                      // 空白页：按登记的纸张比例画一张白纸，同样遵守待应用旋转的适配规则
                      <span className={"paper" + (quarter ? " quarter" : "")}
                            style={{ "--ar": `${s.width} / ${s.height}`, transform: deg ? `rotate(${deg}deg)` : undefined } as React.CSSProperties} />
                    ) : null}
                  </span>
                  <span className="no" title={P.cardLabel(it, idx)}>{P.cardLabel(it, idx)}</span>
                </div>
              );
            })}
          {/* 落点条放在网格内部：它的坐标按卡片在网格中的偏移计算 */}
          {dropLabel && drag?.bar && <span className="pg-drop" style={drag.bar} aria-hidden="true" />}
          </div>
        </div>

        <div className="pages-foot">
          <span className={"pages-foot-summary" + (original ? " idle" : "")} role="status">{summary}</span>
          <div className="pages-foot-actions">
            <button type="button" className="pgfoot undo" disabled={!dirty || !history.length} onClick={undo}
                    title="撤销上一步（Ctrl+Z）">撤销</button>
            <button type="button" className="pgfoot outlined" disabled={!dirty} onClick={cancelChanges}>取消变更</button>
            <button type="button" className="pgfoot primary" disabled={!dirty} onClick={() => setModal("save")}>应用并另存为新 PDF →</button>
          </div>
        </div>
      </section>

      {modal && (
        <OrganizeModal
          modal={modal} file={file} plan={plan} sel={sel}
          resolveSize={resolveSize} initialSource={lastSource} onRememberSource={setLastSource}
          onImportSizes={rememberImportSizes}
          name={name} onName={setName} dir={dir} onDir={setDir} outDir={appInfo?.out_dir ?? null}
          job={job} summary={saveSummary}
          onClose={() => setModal(null)}
          onInsert={insert}
          onMove={moveSel}
          onStart={() => void start()}
          onCancelRun={() => void job.cancel()}
          onBackToSave={() => setModal("save")}
          onRetry={() => void start()}
          onOpenFile={(f) => { setModal(null); openFile(f); }}
        />
      )}
    </div>
  );
}
