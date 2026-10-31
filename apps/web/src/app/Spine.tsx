import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppCtx } from "./AppContext";
import { cancelTask, clearFinishedTasks, clearTask, get, openPath, retryTask, uploadFiles } from "../shared/api";
import { openRegistered, pickPdfsNative } from "../shared/nativeOpen";
import Icon, { type IconName } from "../shared/Icon";
import SwordProgress, { swordPct } from "../shared/SwordProgress";
import type { DocMode, FileEntry, Task, TaskStatus } from "../shared/types";

export const STATUS_TEXT: Record<TaskStatus, string> = {
  running: "运行中",
  cancelling: "取消中",
  done: "已完成",
  error: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

/** 文档模式仅三项（2026-10-26 基线）：AI 阅读由工具栏按钮与右下气泡打开浮层，不占模式位 */
const MODES: { id: DocMode; label: string; icon: IconName }[] = [
  { id: "reader", label: "阅读", icon: "read" },
  { id: "pages", label: "页面", icon: "pages" },
  { id: "convert", label: "转换", icon: "convert" },
];

interface FindCmd { key: string; title: string; hint: string; run: () => void }

/** 组合方案几何常量（Figma 99–103 · 用户 2026-10-27 重申）：208–104 等宽缩放，间距 8；放不下时 32×38 下拉入口 */
const TAB_GAP = 8;
const TAB_MIN = 104;
const TAB_MAX = 208;
const MORE_W = 32;
interface WorkTab {
  key: string;
  kind: "pdf" | "task";
  id: string;
  name: string;
  title: string;
  active: boolean;
  file?: FileEntry;
  taskId?: string;
}

export default function Spine({ route }: { route: string }) {
  const {
    files, current, openFile, openAiForFile, tabs, closeTab, closeWorkTabs, taskTabs, activeTaskTabId,
    switchTaskTab, closeTaskTab, startTask, docMode, setDocMode, setDocStatus, toast, pagesDirty,
  } = React.useContext(AppCtx);
  const [showTasks, setShowTasks] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [tasks, setTasks] = useState<Task[]>([]);
  const findReturnFocus = useRef<HTMLElement | null>(null);
  const findListRef = useRef<HTMLDivElement>(null);
  const findKeyboardMove = useRef(false);
  const homeTabRef = useRef<HTMLButtonElement>(null);

  // ── 工作标签自适应与溢出（Figma 99–103 · 用户 2026-10-27 重申）──────────────
  const stripRef = useRef<HTMLDivElement>(null);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [stripW, setStripW] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [showAllTabs, setShowAllTabs] = useState(false);
  const [allIdx, setAllIdx] = useState(0);
  // 840 断点（125/127）：打开入口换有边界按钮，多标签时收成 36×36「＋」
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 840px)").matches);
  const openInputRef = useRef<HTMLInputElement>(null);

  /** 测量动态区实际可用宽度：首页与「打开 PDF」之间，不用窗口总宽估算 */
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setStripW(entries[0].contentRect.width));
    ro.observe(el);
    setStripW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  /** 兜底：ResizeObserver 回调可能延迟（节流/后台标签），渲染后校验宽度并监听 resize */
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (el && Math.abs(el.clientWidth - stripW) > 1) setStripW(el.clientWidth);
  });
  useEffect(() => {
    const onResize = () => {
      const el = stripRef.current;
      if (el) setStripW(el.clientWidth);
    };
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
  // 断点双保险：matchMedia change 之外再随 resize 复核（视口程序化调整可能不派发 change）
  useEffect(() => {
    const mq = matchMedia("(max-width: 840px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    addEventListener("resize", on);
    return () => { mq.removeEventListener("change", on); removeEventListener("resize", on); };
  }, []);

  const onPdfTab = route === "reader" && (current?.kind === "pdf" || current?.kind === "ofd");
  const workTabs: WorkTab[] = [
    ...tabs.map((file): WorkTab => ({
      key: `p-${file.id}`, kind: "pdf", id: file.id, name: file.name, file,
      title: file.path ? `${file.name}\n${file.path}` : file.name,
      active: onPdfTab && current?.id === file.id,
    })),
    ...taskTabs.map((tab): WorkTab => ({
      key: `t-${tab.id}`, kind: "task", id: tab.id, name: tab.title, taskId: tab.id,
      title: tab.title, active: activeTaskTabId === tab.id,
    })),
  ];
  const tabCount = workTabs.length;
  const activeIdx = workTabs.findIndex((t) => t.active);

  /** 全部放得下：在 208–104 间等宽缩放；放不下：按 104 定可见数，其余进「全部标签」 */
  const share = tabCount ? Math.floor((stripW - TAB_GAP * (tabCount - 1)) / tabCount) : TAB_MAX;
  const fitAll = tabCount === 0 || share >= TAB_MIN;
  const tabW = fitAll ? Math.min(TAB_MAX, share) : TAB_MIN;
  const visibleCount = fitAll ? tabCount
    : Math.max(1, Math.min(tabCount - 1, Math.floor((stripW - MORE_W) / (TAB_MIN + TAB_GAP))));
  const overflow = tabCount > 0 && !fitAll;

  /** 当前项始终可见：窗口随激活标签滑动，顺序不变 */
  useEffect(() => {
    if (!overflow) { setWindowStart(0); return; }
    setWindowStart((start) => {
      const last = Math.max(0, tabCount - visibleCount);
      let s = Math.min(start, last);
      if (activeIdx >= 0) {
        if (activeIdx < s) s = activeIdx;
        if (activeIdx >= s + visibleCount) s = Math.min(activeIdx - visibleCount + 1, last);
      }
      return s;
    });
  }, [overflow, visibleCount, activeIdx, tabCount]);

  const visibleTabs = workTabs.slice(windowStart, windowStart + visibleCount);

  const closeAllTabsMenu = (refocus = true) => {
    setShowAllTabs(false);
    if (refocus) setTimeout(() => moreBtnRef.current?.focus(), 10);
  };
  const selectAllTab = (t: WorkTab) => {
    setShowAllTabs(false);
    if (t.kind === "pdf" && t.file) openFile(t.file);
    else if (t.taskId) switchTaskTab(t.taskId);
    // 切换的隐藏标签随窗口滑动出现在顶栏，焦点落到该标签
    setTimeout(() => {
      stripRef.current?.querySelector<HTMLElement>(`[data-tab-key="${t.key}"] > button[role="tab"]`)?.focus();
    }, 60);
  };

  /** 下拉外点击收起 */
  useEffect(() => {
    if (!showAllTabs) return;
    const onDown = (e: MouseEvent) => {
      if (moreWrapRef.current && !moreWrapRef.current.contains(e.target as Node)) setShowAllTabs(false);
    };
    addEventListener("mousedown", onDown);
    return () => removeEventListener("mousedown", onDown);
  }, [showAllTabs]);

  /** 打开或移动键盘焦点时聚焦对应选项；preventScroll 防止浏览器顺带滚动其他容器 */
  useEffect(() => {
    if (!showAllTabs) return;
    const opts = moreWrapRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']");
    const btn = opts?.[allIdx];
    if (!btn) return;
    btn.focus({ preventScroll: true });
    btn.scrollIntoView({ block: "nearest" });
  }, [showAllTabs, allIdx]);

  /** 关闭后激活邻近标签并保持焦点可达 */
  const closePdfTab = (id: string) => {
    closeTab(id);
    setTimeout(() => {
      const strip = stripRef.current;
      if (!strip) return;
      const nextBtn = strip.querySelector<HTMLElement>(".workspace-tab.on > button[role='tab']")
        || strip.querySelector<HTMLElement>(".workspace-tab.wtab > button[role='tab']");
      (nextBtn || homeTabRef.current)?.focus();
    }, 90);
  };

  // ── 工作标签右键菜单（Figma 104–106）─────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; targetKey: string | null } | null>(null);
  const [ctxIdx, setCtxIdx] = useState(0);
  const [closeConfirm, setCloseConfirm] = useState<{ pdfIds: string[]; taskIds: string[] } | null>(null);
  const ctxReturnRef = useRef<HTMLElement | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  const ctxTarget = ctxMenu?.targetKey ? (workTabs.find((t) => t.key === ctxMenu.targetKey) ?? null) : null;
  const ctxTargetIdx = ctxTarget ? workTabs.findIndex((t) => t.key === ctxTarget.key) : -1;
  const ctxItems: { id: string; label: string; disabled: boolean }[] = ctxMenu ? (ctxTarget ? [
    { id: "self", label: "关闭标签", disabled: false },
    { id: "others", label: "关闭其他标签", disabled: tabCount <= 1 },
    { id: "left", label: "关闭左侧标签", disabled: ctxTargetIdx <= 0 },
    { id: "right", label: "关闭右侧标签", disabled: ctxTargetIdx >= tabCount - 1 },
    { id: "all", label: "关闭全部标签", disabled: false },
  ] : [
    { id: "all", label: "关闭全部标签", disabled: tabCount === 0 },
  ]) : [];

  const closeCtxMenu = (refocus = true) => {
    setCtxMenu(null);
    if (refocus) setTimeout(() => {
      if (ctxReturnRef.current?.isConnected) ctxReturnRef.current.focus();
      else homeTabRef.current?.focus();
    }, 10);
  };

  const runCloseTabs = (pdfIds: string[], taskIds: string[]) => {
    closeWorkTabs(pdfIds, taskIds);
    setCtxMenu(null);
    setTimeout(() => {
      const strip = stripRef.current;
      const nextBtn = strip?.querySelector<HTMLElement>(".workspace-tab.on > button[role='tab']");
      (nextBtn || homeTabRef.current)?.focus();
    }, 90);
  };

  /** 执行关闭：按执行瞬间的逻辑顺序快照取目标集合；当前文档有未应用页面变更时先确认 */
  const executeCtx = (itemId: string) => {
    if (!ctxMenu) return;
    let targets: WorkTab[];
    if (itemId === "all") targets = workTabs;
    else if (!ctxTarget) return;
    else if (itemId === "self") targets = [ctxTarget];
    else if (itemId === "others") targets = workTabs.filter((t) => t.key !== ctxTarget.key);
    else if (itemId === "left") targets = workTabs.slice(0, ctxTargetIdx);
    else if (itemId === "right") targets = workTabs.slice(ctxTargetIdx + 1);
    else return;
    const pdfIds = targets.filter((t) => t.kind === "pdf").map((t) => t.id);
    const taskIds = targets.filter((t) => t.kind === "task").map((t) => t.taskId!);
    if (current && pagesDirty && pdfIds.includes(current.id)) {
      setCloseConfirm({ pdfIds, taskIds });
      setCtxMenu(null);
      return;
    }
    runCloseTabs(pdfIds, taskIds);
  };

  /** 菜单位置：靠近触发点，越界收进可视范围 */
  const ctxMenuPos = (() => {
    if (!ctxMenu) return {};
    const h = ctxItems.length * 38 + 12;
    const x = Math.max(8, Math.min(ctxMenu.x, window.innerWidth - 248));
    const y = ctxMenu.y + h > window.innerHeight - 8
      ? Math.max(8, window.innerHeight - h - 8) : ctxMenu.y;
    return { left: `${x}px`, top: `${y}px` };
  })();

  /** 外部点击关闭；目标标签消失时收起 */
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) closeCtxMenu(false);
    };
    addEventListener("mousedown", onDown);
    return () => removeEventListener("mousedown", onDown);
  }, [ctxMenu]);
  useEffect(() => {
    if (ctxMenu?.targetKey && !workTabs.some((t) => t.key === ctxMenu.targetKey)) setCtxMenu(null);
  }, [workTabs, ctxMenu?.targetKey]);
  useEffect(() => {
    if (!ctxMenu) return;
    const btns = ctxMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']");
    btns?.[ctxIdx]?.focus({ preventScroll: true });
  }, [ctxMenu, ctxIdx]);

  const openFind = () => {
    if (!showFind && document.activeElement instanceof HTMLElement) {
      findReturnFocus.current = document.activeElement;
    }
    setShowTasks(false);
    setShowAllTabs(false);
    setFindQ("");
    setFindIdx(0);
    setShowFind(true);
  };

  useEffect(() => {
    if (showFind) return;
    const previous = findReturnFocus.current;
    findReturnFocus.current = null;
    if (previous?.isConnected) requestAnimationFrame(() => previous.focus());
  }, [showFind]);

  // 任务面板常驻轮询：运行中更快
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const r = await get<{ tasks: Task[] }>("/api/tasks");
        if (!alive) return;
        setTasks(r.tasks || []);
        const running = (r.tasks || []).some((t) => t.status === "running" || t.status === "cancelling");
        timer = window.setTimeout(load, running ? 800 : 3000);
      } catch {
        if (alive) timer = window.setTimeout(load, 3000);
      }
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!findReturnFocus.current && document.activeElement instanceof HTMLElement) {
          findReturnFocus.current = document.activeElement;
        }
        setShowTasks(false);
        setShowAllTabs(false);
        setFindQ("");
        setFindIdx(0);
        setShowFind(true);
      }
      if (e.key === "Escape") { setShowTasks(false); setShowFind(false); setShowAllTabs(false); setCtxMenu(null); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const openPdfFromBar = async (list: FileList | null) => {
    const pdfs = Array.from(list || []).filter((f) => /\.(pdf|ofd)$/i.test(f.name));
    if (!pdfs.length) return;
    try {
      const r = await uploadFiles(pdfs);
      // 多选全部打开为标签；第一个文件保持为当前激活（重复文件由上传去重合并为原标签）
      const opened = r.files.filter((f) => f.kind === "pdf" || f.kind === "ofd");
      opened.forEach((f) => openFile(f));
      if (opened[0]) openFile(opened[0]);
    } catch (e) { toast(`打开失败：${(e as Error).message}`, true); }
  };

  // 桌面优先走原生选择：引擎登记真实路径（与源文件同目录可用）；旧引擎回退网页选择
  const openViaNative = async () => {
    try {
      const r = await pickPdfsNative();
      if (r === null) { openInputRef.current?.click(); return; }
      if (r.cancelled) return;
      openRegistered(openFile, r.files);
      if (r.errors.length) toast(`部分文件未能打开：${r.errors[0]}`, true);
    } catch (e) { toast(`打开失败：${(e as Error).message}`, true); }
  };

  const running = tasks.filter((t) => t.status === "running" || t.status === "cancelling").length;
  // 可被一键清理的终态任务数（运行中/取消中除外）
  const clearableCount = tasks.length - running;

  const isOfd = current?.kind === "ofd";
  const hasDoc = !!current && (current.kind === "pdf" || isOfd);
  // 分组命令（Figma 56/58）：当前 PDF / 应用命令 / 最近文件；OFD 无页面整理/拆分/OCR
  const docCmds: FindCmd[] = hasDoc ? [
    { key: "find-text", title: `查找当前${isOfd ? " OFD" : " PDF"}中的文字`, hint: "打开左栏搜索并定位文字",
      run: () => { setShowFind(false); setDocMode("reader"); setDocStatus(null);
        setTimeout(() => window.dispatchEvent(new CustomEvent("zhanlu:focus-find")), 30); } },
    { key: "convert-doc", title: isOfd ? "当前 OFD 另存为 PDF" : "转换当前 PDF", hint: "保留原文，在右侧核对输出",
      run: () => { setShowFind(false); setDocMode("convert"); setDocStatus(null); } },
    ...(!isOfd ? [{ key: "pages", title: "整理当前 PDF 页面", hint: "整页网格多选、移动、旋转和删除",
      run: () => { setShowFind(false); setDocMode("pages"); setDocStatus(null); } },
    { key: "ai", title: "AI 阅读当前 PDF", hint: "右侧栏提问，回答来源可返回原页",
      run: () => { setShowFind(false); openAiForFile(current!); } },
    { key: "ocr", title: "文字识别 OCR", hint: "扫描页在本机识别，生成可搜索副本",
      run: () => { setShowFind(false); setDocMode("reader"); setDocStatus(null);
        setTimeout(() => window.dispatchEvent(new CustomEvent("zhanlu:ocr-current")), 30); } },
    { key: "split-doc", title: "拆分当前 PDF", hint: "在任务标签中选择规则并另存",
      run: () => { setShowFind(false); startTask("split", [current!]); } }] : []),
    { key: "fullscreen", title: `全屏预览当前${isOfd ? "文档" : " PDF"}`, hint: "沉浸阅读 · Esc 退出",
      run: () => { setShowFind(false); setTimeout(() => window.dispatchEvent(new CustomEvent("zhanlu:fullscreen-read")), 30); } },
    { key: "present", title: `放映当前${isOfd ? "文档" : " PDF"}`, hint: "整页居中逐页演示 · ← → 翻页",
      run: () => { setShowFind(false); setTimeout(() => window.dispatchEvent(new CustomEvent("zhanlu:present")), 30); } },
    ...(!isOfd ? [{ key: "convert-task", title: "创建转换任务", hint: "独立任务标签核对后另存",
      run: () => { setShowFind(false); startTask("convert", [current!]); } }] : []),
  ] : [];
  const appCmds: FindCmd[] = [
    { key: "merge", title: "合并 PDF", hint: "多份文件合成一份 · 独立任务", run: () => { setShowFind(false); location.hash = "#/merge"; } },
    { key: "split", title: "拆分 PDF", hint: "按页生成新文件 · 独立任务", run: () => { setShowFind(false); location.hash = "#/split"; } },
    { key: "open", title: "打开 PDF", hint: "从本机选择文件", run: () => { setShowFind(false); void openViaNative(); } },
    { key: "settings", title: "设置", hint: "模型与 AI、文字识别、文件与输出", run: () => { setShowFind(false); location.hash = "#/settings"; } },
  ];
  const q = findQ.trim().toLowerCase();
  const match = (c: FindCmd) => !q || c.title.toLowerCase().includes(q) || c.hint.includes(q);
  const recentPdfs = files.filter((f) => f.kind === "pdf");
  const fileCmds: FindCmd[] = recentPdfs.slice(0, 4).map((f) => ({
    key: `file-${f.id}`, title: `打开 · ${f.name}`, hint: `最近文件 · ${f.pages ? `${f.pages} 页` : "最近文件"}`,
    run: () => { setShowFind(false); openFile(f); },
  }));
  const shownDocCmds = docCmds.filter(match).slice(0, q ? 8 : 4);
  const shownAppCmds = appCmds.filter(match).slice(0, 8 - shownDocCmds.length);
  const findGroups: { label: string; items: FindCmd[] }[] = [
    { label: `当前 PDF · ${current?.name || ""}`, items: shownDocCmds },
    { label: "应用命令", items: shownAppCmds },
    { label: "最近文件", items: fileCmds.filter(match) },
  ].filter((g) => g.items.length > 0);
  const flatHits = findGroups.flatMap((g) => g.items);
  const findIdxSafe = flatHits.length ? findIdx % flatHits.length : 0;

  useLayoutEffect(() => {
    if (!showFind || !findKeyboardMove.current) return;
    findKeyboardMove.current = false;
    const list = findListRef.current;
    const selected = list?.querySelector<HTMLElement>("button.on");
    if (!list || !selected) return;
    const listBounds = list.getBoundingClientRect();
    const itemBounds = selected.getBoundingClientRect();
    if (itemBounds.top < listBounds.top) list.scrollTop -= listBounds.top - itemBounds.top;
    else if (itemBounds.bottom > listBounds.bottom) list.scrollTop += itemBounds.bottom - listBounds.bottom;
  }, [showFind, findIdxSafe]);

  const setMode = (m: DocMode) => {
    if (!current || (current.kind !== "pdf" && current.kind !== "ofd")) return;
    if (current.kind === "ofd" && m === "pages") return; // OFD 无整页整理
    setDocMode(m);
    setDocStatus(null);
  };

  return (
    <header className="spine">
      <div className="spine-top">
        <button type="button" className="brand" onClick={() => (location.hash = "#/home")} aria-label="回到首页工作台">
          <img className="brand-mark" src="./brand/mark.svg" alt="" width={26} height={26} /><span>湛卢 PDF</span>
        </button>
        <div className={route === "home" ? "workspace-tab on" : "workspace-tab"}>
          <button type="button" ref={homeTabRef} role="tab" aria-selected={route === "home"} onClick={() => (location.hash = "#/home")}>首页</button>
        </div>
        <div className="workspace-tabs" role="tablist" aria-label="文件与任务标签" ref={stripRef}
             onContextMenu={(e) => {
               if ((e.target as HTMLElement).closest(".workspace-tab, .tabs-more")) return;
               e.preventDefault();
               ctxReturnRef.current = homeTabRef.current;
               setCtxMenu({ x: e.clientX, y: e.clientY, targetKey: null });
               setCtxIdx(0);
             }}>
          {visibleTabs.map((t) => (
            <div key={t.key} data-tab-key={t.key}
                 style={{ width: `${tabW}px` }}
                 className={t.active ? "workspace-tab wtab on" : "workspace-tab wtab"}
                 onContextMenu={(e) => {
                   e.preventDefault();
                   ctxReturnRef.current = e.currentTarget.querySelector("button[role='tab']");
                   setCtxMenu({ x: e.clientX, y: e.clientY, targetKey: t.key });
                   setCtxIdx(0);
                 }}>
              <button type="button" role="tab" aria-selected={t.active} title={t.title}
                      onClick={() => { if (t.kind === "pdf" && t.file) openFile(t.file); else if (t.taskId) switchTaskTab(t.taskId); }}
                      onKeyDown={(e) => {
                        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                          e.preventDefault();
                          const r = e.currentTarget.getBoundingClientRect();
                          ctxReturnRef.current = e.currentTarget;
                          setCtxMenu({ x: r.left, y: r.bottom + 2, targetKey: t.key });
                          setCtxIdx(0);
                        }
                      }}>
                {t.name}
              </button>
              <button type="button" className="workspace-tab-close" aria-label={`关闭 ${t.name}`}
                      onClick={() => { if (t.kind === "pdf") closePdfTab(t.id); else if (t.taskId) closeTaskTab(t.taskId); }}>×</button>
            </div>
          ))}
          {overflow && (
            <div className="tabs-more" ref={moreWrapRef}>
              <button type="button" ref={moreBtnRef} className="tabs-more-btn"
                      aria-label={`全部标签，共 ${tabCount} 个`} aria-haspopup="listbox" aria-expanded={showAllTabs}
                      onClick={() => {
                        if (showAllTabs) { closeAllTabsMenu(); return; }
                        setAllIdx(Math.max(0, activeIdx));
                        setShowAllTabs(true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                          e.preventDefault();
                          setAllIdx(e.key === "ArrowDown" ? Math.min(tabCount - 1, Math.max(0, activeIdx))
                                                          : Math.max(0, Math.min(tabCount - 1, activeIdx)));
                          setShowAllTabs(true);
                        }
                      }}>
                <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true" focusable="false">
                  <path d="M1.5 1.5 6 6l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8"
                        strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {showAllTabs && (
                <div className="all-tabs" role="listbox" aria-label="全部标签"
                     onKeyDown={(e) => {
                       if (e.key === "ArrowDown") { e.preventDefault(); setAllIdx((i) => (i + 1) % tabCount); }
                       else if (e.key === "ArrowUp") { e.preventDefault(); setAllIdx((i) => (i - 1 + tabCount) % tabCount); }
                       else if (e.key === "Home") { e.preventDefault(); setAllIdx(0); }
                       else if (e.key === "End") { e.preventDefault(); setAllIdx(tabCount - 1); }
                       else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectAllTab(workTabs[allIdx]); }
                       else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeAllTabsMenu(); }
                       else if (e.key === "Tab") { setShowAllTabs(false); }
                     }}>
                  <div className="all-tabs-head"><span>已打开的标签</span><b>{tabCount}</b></div>
                  <div className="all-tabs-list">
                    {workTabs.map((t, i) => (
                      <button type="button" key={t.key} role="option" aria-selected={t.active}
                              className={i === allIdx ? "kbd" : ""} title={t.title}
                              onMouseEnter={() => setAllIdx(i)}
                              onClick={() => selectAllTab(t)}>
                        <span className="all-tabs-name">{t.name}</span>
                        {t.active && <span className="all-tabs-check" aria-hidden="true">✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <button type="button" className={`workspace-open${narrow ? " boxed" : ""}${narrow && tabCount >= 2 ? " compact" : ""}`}
                aria-label="打开 PDF" title="打开 PDF"
                onClick={() => void openViaNative()}>
          {narrow ? (tabCount >= 2 ? "＋" : "＋ 打开") : "＋ 打开 PDF"}
        </button>
        <input ref={openInputRef} type="file" hidden accept=".pdf,.ofd" multiple
               onChange={(e) => { openPdfFromBar(e.target.files); e.target.value = ""; }} />
        <div className="spine-actions" role="group" aria-label="全局操作">
          <button type="button" className="gact gact-find" title="查找功能（Ctrl+K）" onClick={openFind}>
            <Icon name="search" /> 查找功能
          </button>
          <button type="button" className={`gact gact-tasks${running >= 10 ? " many" : ""}`}
                  aria-expanded={showTasks}
                  title={running > 0 ? `任务与结果 · ${running} 个进行中` : "任务与结果"}
                  onClick={() => { setShowFind(false); setShowTasks((v) => !v); }}>
            {running > 0 ? `任务 · ${running}` : "任务"}
          </button>
          <button type="button" className="gact gact-settings" aria-current={route === "settings" ? "page" : undefined}
                  onClick={() => (location.hash = "#/settings")}>设置</button>
        </div>
      </div>
      {onPdfTab ? (
        <nav className="doc-modes" aria-label="文档模式">
          {MODES.filter((m) => current?.kind !== "ofd" || m.id !== "pages").map((m) => (
            <button key={m.id} type="button" title={m.label} className={docMode === m.id ? "on" : ""}
                    aria-current={docMode === m.id ? "page" : undefined} onClick={() => setMode(m.id)}>
              <Icon name={m.icon} /><span>{m.label}</span>
            </button>
          ))}
        </nav>
      ) : null}
      {showFind && (
        <div className="finder-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowFind(false); }}>
          <div className="finder" role="dialog" aria-modal="true" aria-label="查找功能">
            <div className="finder-head">
              <h2>查找功能</h2>
              <span className="finder-esc">Esc 关闭</span>
            </div>
            <input className="input" autoFocus placeholder={hasDoc ? "搜索当前 PDF 操作或应用命令…" : "搜索应用命令或最近文件…"}
                   value={findQ}
                   onChange={(e) => { setFindQ(e.target.value); setFindIdx(0); }}
                   onKeyDown={(e) => {
                     if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                     if (e.key === "ArrowDown") { e.preventDefault(); findKeyboardMove.current = true; setFindIdx((i) => (flatHits.length ? (i + 1) % flatHits.length : 0)); }
                     if (e.key === "ArrowUp") { e.preventDefault(); findKeyboardMove.current = true; setFindIdx((i) => (flatHits.length ? (i - 1 + flatHits.length) % flatHits.length : 0)); }
                     if (e.key === "Enter" && flatHits[findIdxSafe]) { e.preventDefault(); flatHits[findIdxSafe].run(); }
                   }} />
            <p className="finder-caption">{hasDoc
              ? <>当前 PDF：{current?.name} · 文内文字请使用 Ctrl+F</>
              : <>查找应用操作与最近文件；当前 PDF 的文字请用「查找文字」</>}</p>
            {flatHits.length > 0 ? (
              <div className="finder-list" ref={findListRef}>
                {findGroups.map((g) => (
                  <div className="finder-group" key={g.label}>
                    <span className="finder-group-label">{g.label}</span>
                    {g.items.map((c) => {
                      const idx = flatHits.indexOf(c);
                      return (
                        <button type="button" key={c.key} className={idx === findIdxSafe ? "on" : ""}
                                onMouseEnter={() => setFindIdx(idx)} onClick={c.run}>
                          <strong>{c.title}</strong><small>{c.hint}</small>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : (
              <div className="finder-empty">
                <strong>没有匹配的功能或最近文件</strong>
                <p>试试「转换」「OCR」；查 PDF 文字请使用 Ctrl+F。</p>
                <button type="button" onClick={() => { setFindQ(""); setFindIdx(0); }}>清除输入</button>
              </div>
            )}
            <p className="finder-kbd">{q ? "Esc 关闭 · 清除输入后查看全部命令" : "↑↓ 选择   Enter 执行   Esc 关闭"}</p>
          </div>
        </div>
      )}
      {ctxMenu && (
        <div className="tab-ctx-menu" ref={ctxMenuRef} role="menu" aria-label="工作标签操作"
             style={ctxMenuPos}
             onKeyDown={(e) => {
               const step = (dir: 1 | -1) => {
                 let i = ctxIdx;
                 for (let k = 0; k < ctxItems.length; k++) {
                   i = (i + dir + ctxItems.length) % ctxItems.length;
                   if (!ctxItems[i].disabled) { setCtxIdx(i); return; }
                 }
               };
               const firstEnabled = ctxItems.findIndex((i) => !i.disabled);
               const lastEnabled = ctxItems.length - 1 - [...ctxItems].reverse().findIndex((i) => !i.disabled);
               if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
               else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
               else if (e.key === "Home" && firstEnabled >= 0) { e.preventDefault(); setCtxIdx(firstEnabled); }
               else if (e.key === "End" && lastEnabled >= 0) { e.preventDefault(); setCtxIdx(lastEnabled); }
               else if (e.key === "Enter" || e.key === " ") {
                 e.preventDefault();
                 const item = ctxItems[ctxIdx];
                 if (item && !item.disabled) executeCtx(item.id);
               }
               else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCtxMenu(); }
               else if (e.key === "Tab") setCtxMenu(null);
             }}>
          {ctxItems.map((item, i) => (
            <React.Fragment key={item.id}>
              {i === 1 && ctxTarget && <div className="tab-ctx-sep" role="separator" />}
              <button type="button" role="menuitem" disabled={item.disabled} aria-disabled={item.disabled}
                      className={i === ctxIdx ? "kbd" : ""}
                      onMouseEnter={() => setCtxIdx(i)}
                      onClick={() => !item.disabled && executeCtx(item.id)}>
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      {closeConfirm && (
        <div className="finder-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setCloseConfirm(null); }}>
          <div className="reader-password-dialog" role="dialog" aria-modal="true" aria-label="关闭前确认">
            <h2>关闭前确认</h2>
            <p className="reader-password-file">{current?.name} 有未应用的页面整理变更</p>
            <p className="note">关闭标签将丢弃这些变更，原 PDF 文件不受影响。如需保留整理结果，请先在页面模式「应用并另存为新 PDF」。</p>
            <div className="reader-password-actions">
              <button type="button" className="btn" onClick={() => setCloseConfirm(null)}>取消</button>
              <button type="button" className="btn primary" onClick={() => {
                const c = closeConfirm;
                setCloseConfirm(null);
                if (c) runCloseTabs(c.pdfIds, c.taskIds);
              }}>放弃变更并关闭</button>
            </div>
          </div>
        </div>
      )}
      {showTasks && (
        <div className="task-popover" role="dialog" aria-label="任务与结果">
          <div className="task-popover-head">
            <strong>任务与结果</strong>
            <span className="spacer" />
            <button type="button" className="task-popover-clear"
                    title="清理全部已完成与失败的任务记录，不影响运行中任务和已生成文件"
                    disabled={!clearableCount}
                    onClick={() => {
                      clearFinishedTasks()
                        .then((r) => {
                          setTasks((old) => old.filter((t) => t.status === "running" || t.status === "cancelling"));
                          toast(r.count ? `已清理 ${r.count} 条任务记录` : "没有可清理的任务记录");
                        })
                        .catch((e) => toast(`清理失败：${(e as Error).message}`, true));
                    }}>
              <Icon name="trash" size={14} /> 全部清理
            </button>
            <button type="button" aria-label="关闭任务面板" onClick={() => setShowTasks(false)}>×</button>
          </div>
          {tasks.length === 0 && <p className="note">暂无任务。合并、拆分、转换、OCR 和 AI 的进度都在这里。</p>}
          {tasks.slice(0, 14).map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      )}
    </header>
  );
}

function TaskRow({ task }: { task: Task }) {
  const { appInfo, files, openFile, toast } = React.useContext(AppCtx);
  const pct = Math.round((task.progress || 0) * 100);
  const firstOut = task.outputs?.[0];
  const resultFile = task.result?.file || task.result?.files?.find((f) => f.kind === "pdf");
  const openResult = () => {
    const target = resultFile || firstOut;
    if (target?.id && target.kind === "pdf") openFile(target as any);
    else if (firstOut?.id) openPath({ id: firstOut.id }).catch(() => {});
  };
  const canCancel = task.status === "running";
  const canRetry = ["error", "cancelled", "interrupted"].includes(task.status);
  const paramRows = taskParameterRows(task, files, appInfo?.out_dir);
  return (
    <div className="task-popover-row">
      <strong title={task.name}>{task.name}</strong>
      <span className={task.status === "error" || task.status === "interrupted" ? "error" : task.status === "done" ? "done" : ""}>
        {STATUS_TEXT[task.status]}{task.status === "running" && ` · ${swordPct(task)}`}
      </span>
      {(task.status === "running" || task.status === "cancelling") && (
        <SwordProgress value={task.progress || 0} unknown={task.progressKnown === false}
                       label={`任务 ${task.name}`} className="task-sword" />
      )}
      {task.detail && task.status === "running" && <p className="task-detail">{task.detail}</p>}
      {task.error && task.status !== "cancelled" && <p>{task.error}</p>}
      {canRetry && paramRows.length > 0 && (
        <details className="task-params">
          <summary>查看原任务参数</summary>
          <dl>{paramRows.map(([label, value]) => (
            <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>
          ))}</dl>
        </details>
      )}
      <div className="task-row-actions">
        {canCancel && <button type="button" onClick={() => cancelTask(task.id).catch((e) => toast(e.message, true))}>取消</button>}
        {canRetry && <button type="button" onClick={() => retryTask(task.id).then(() => toast("已重新提交任务")).catch((e) => toast(e.message, true))}>重试</button>}
        {["done", "error", "cancelled", "interrupted"].includes(task.status) && (
          <button type="button" onClick={() => clearTask(task.id).catch(() => {})}>清理</button>
        )}
        {task.status === "done" && (resultFile || firstOut) && (
          <button type="button" className="task-popover-open" onClick={openResult}>
            {resultFile?.kind === "pdf" ? "打开结果 ›" : "打开位置 ›"}
          </button>
        )}
      </div>
    </div>
  );
}

function taskParameterRows(task: Task, files: FileEntry[], defaultDir?: string): [string, string][] {
  const p = task.params || {};
  const rows: [string, string][] = [];
  const fileName = (id: unknown) => files.find((f) => f.id === String(id))?.name || `文件 ${String(id).slice(0, 10)}`;
  const add = (label: string, value: unknown) => {
    if (value !== undefined && value !== null && String(value).trim()) rows.push([label, String(value)]);
  };
  if (p.id) add("源文件", fileName(p.id));
  if (Array.isArray(p.ids)) add("源文件", p.ids.map(fileName).join("、"));
  if (Array.isArray(p.items)) add("源文件与页码", p.items.map((item) => {
    const part = item as { id?: unknown; pages?: unknown };
    return `${fileName(part.id)}（${part.pages || "全部页"}）`;
  }).join(" → "));
  if (p.mode) add("处理规则", ({ single: "拆成单页", boundary: "按页拆分", every: "每 N 页", ranges: "自定义范围" } as Record<string, string>)[String(p.mode)] || p.mode);
  if (p.boundary) add("分割页码", p.boundary);
  if (p.every) add("每份页数", p.every);
  if (p.ranges) add("自定义范围", p.ranges);
  if (p.pages) add("页码范围", p.pages);
  if (p.target) add("输出格式", String(p.target).toUpperCase());
  if (p.dpi) add("清晰度", `${p.dpi} DPI`);
  if (p.prefix) add("文件名前缀", p.prefix);
  if (p.name) add("输出文件名", p.name);
  if (p.stem) add("文件名前缀", p.stem);
  if (p.tier) add("识别档位", p.tier);
  if (p.action) add("AI 操作", p.action);
  if (p.depth) add("回答深度", p.depth);
  add("保存位置", p.dir === "@source" ? "与源文件同目录" : p.dir || defaultDir || "应用输出目录（默认）");
  return rows;
}
