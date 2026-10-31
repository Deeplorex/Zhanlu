import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppCtx } from "./AppContext";
import { getAppInfo, get } from "../shared/api";
import type { AppInfo, DocMode, FileEntry, ReaderView, SelectionPayload, TaskKind, TaskSeed, WorkspaceTaskTab } from "../shared/types";
import Spine from "./Spine";
import Home from "../features/home/Home";
import Reader from "../features/reader/Reader";
import PagesGrid from "../features/pages/PagesGrid";
import Convert from "../features/convert/Convert";
import SplitTask from "../features/workflows/SplitTask";
import MergeTask from "../features/workflows/MergeTask";
import Settings from "../features/settings/Settings";
import AiChat from "../features/ai/AiChat";
import AiLauncher from "../features/ai/AiLauncher";
import { startNativeDropBridge } from "../shared/nativeDrag";

const SCREENS: Record<string, React.ComponentType> = {
  split: SplitTask,
  merge: MergeTask,
  convert: Convert,
};

const TASK_ROUTES = new Set(["split", "merge", "convert"]);
const TASK_TITLES: Record<TaskKind, string> = { split: "拆分", merge: "合并", convert: "转换" };

/** 文档模式与 AI 侧栏都属于当前 PDF 标签，不建任务标签（交互说明 §1）。 */
function newTaskTab(kind: TaskKind, files: FileEntry[] = []): WorkspaceTaskTab {
  const detail = files.length === 1 ? ` · ${files[0].name}` : files.length > 1 ? ` · ${files.length} 份` : "";
  return {
    id: Math.random().toString(36).slice(2, 10), kind,
    title: `${TASK_TITLES[kind]}${detail}`,
    seed: files.length ? { kind, files, key: Date.now() } : null,
  };
}

function parseHash(): { route: string; fileId: string | null; taskId: string | null } {
  const h = location.hash.replace(/^#\//, "");
  const path = h.split("?")[0];
  const m = path.match(/^(reader|pages)\/([A-Za-z0-9_-]+)$/);
  const task = path.match(/^task\/([A-Za-z0-9_-]+)$/);
  return { route: task ? "task" : m ? m[1] : path || "home", fileId: m ? m[2] : null, taskId: task ? task[1] : null };
}

const READER_TABS_KEY = "zhanlu.tabs";

export default function App() {
  const [hashState, setHashState] = useState(parseHash);
  const [pendingOpen, setPendingOpen] = useState(hashState.fileId);
  const [taskTabs, setTaskTabs] = useState<WorkspaceTaskTab[]>([]);
  const activeTaskTab = taskTabs.find((t) => t.id === hashState.taskId) || null;
  const route = hashState.route === "task" ? activeTaskTab?.kind || "home" : hashState.route;

  useEffect(() => {
    const onHash = () => {
      const s = parseHash();
      // 旧深链：页面/转换曾是任务路由，现在改为当前 PDF 的文档模式
      if (s.route === "pages" || s.route === "convert" || s.route === "ai") {
        const mode: DocMode = s.route === "ai" ? "reader" : (s.route as DocMode);
        if (s.fileId) setPendingOpen(s.fileId);
        if (mode !== "reader") setPendingMode(mode);
        history.replaceState(null, "", s.fileId ? `#/reader/${s.fileId}` : "#/reader");
        setHashState({ route: "reader", fileId: s.fileId, taskId: null });
        return;
      }
      if (TASK_ROUTES.has(s.route)) {
        const tab = newTaskTab(s.route as TaskKind);
        setTaskTabs((old) => [...old, tab]);
        const query = location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?")) : "";
        history.replaceState(null, "", `#/task/${tab.id}${query}`);
        setHashState({ route: "task", fileId: null, taskId: tab.id });
      } else setHashState(s);
      if (s.fileId) setPendingOpen(s.fileId);
      document.querySelector(".screen")?.scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    const init = parseHash();
    if (TASK_ROUTES.has(init.route) || init.route === "pages" || init.route === "convert" || init.route === "ai") onHash();
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [engines, setEngines] = useState<any>(null);
  const [current, setCurrent] = useState<FileEntry | null>(null);
  const [tabs, setTabs] = useState<FileEntry[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(READER_TABS_KEY) || "[]");
      return Array.isArray(saved) ? saved.filter((f) => f && f.id && (f.kind === "pdf" || f.kind === "ofd")) : [];
    } catch {
      return [];
    }
  });
  const [readerView, setReaderView] = useState<Record<string, ReaderView>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("zhanlu.readerView") || "{}");
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  });
  const [readerJump, setReaderJump] = useState<{ id: string; page: number; key: number } | null>(null);
  const [selection, setSelection] = useState<SelectionPayload | null>(null);
  const [docStatus, setDocStatus] = useState<string | null>(null);
  const [pagesDirty, setPagesDirty] = useState(false);
  const [aiGuideOpen, setAiGuideOpen] = useState(false);
  const aiTriggerRef = useRef<HTMLElement | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; err?: boolean }[]>([]);
  const [pendingMode, setPendingMode] = useState<DocMode | null>(null);

  useEffect(() => {
    try { localStorage.setItem(READER_TABS_KEY, JSON.stringify(tabs.slice(-8))); } catch { /* ignore */ }
  }, [tabs]);

  // 标签由本地会话恢复，可能缺新字段（如同名文件区分用的 path）：随文件列表刷新回填
  useEffect(() => {
    if (!files.length) return;
    setTabs((old) => old.map((t) => {
      const f = files.find((x) => x.id === t.id);
      return f && (f.path !== t.path || f.name !== t.name) ? { ...t, ...f } : t;
    }));
  }, [files]);

  const toast = useCallback((msg: string, err = false) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-4), { id, msg, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 7000 : 3200);
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      const r = await get<{ files: FileEntry[] }>("/api/files");
      setFiles(r.files || []);
    } catch { /* 引擎未就绪时静默 */ }
  }, []);

  const refreshEngines = useCallback(async () => {
    try { setEngines(await get("/api/engines")); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    getAppInfo().then(setAppInfo).catch(() => {});
    refreshFiles();
    refreshEngines();
    const t = setInterval(refreshFiles, 10_000); // 最近文件轻量同步
    return () => clearInterval(t);
  }, [refreshFiles, refreshEngines]);

  const openFile = useCallback((entry: FileEntry, page?: number) => {
    if (entry.kind !== "pdf" && entry.kind !== "ofd") return;
    setCurrent(entry);
    try { localStorage.setItem("zhanlu.current", entry.id); } catch { /* ignore */ }
    setTabs((old) => (old.some((f) => f.id === entry.id) ? old : [...old, entry]));
    if (page) setReaderJump({ id: entry.id, page, key: Date.now() });
    location.hash = "#/reader";
  }, []);

  // 桌面文件关联：冷启动与已运行时的打开请求都复用文档标签。
  useEffect(() => {
    if (!appInfo?.desktop_input) return;
    return startNativeDropBridge();
  }, [appInfo?.desktop_input]);

  useEffect(() => {
    if (!appInfo?.desktop_input) return;
    let active = true;
    let timer: number;
    const load = async () => {
      try {
        const result = await get<{ files: FileEntry[]; errors: string[] }>("/api/desktop/open-files");
        if (!active) return;
        if (result.files.length) {
          await refreshFiles();
          result.files.forEach(entry => openFile(entry));
        }
        result.errors.forEach(error => toast(error, true));
      } catch { /* 引擎暂不可用时重试 */ }
      if (active) timer = window.setTimeout(load, 500);
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [appInfo?.desktop_input, openFile, refreshFiles, toast]);

  // 深链 #/reader/<id>：定位文件并恢复标签
  useEffect(() => {
    if (!pendingOpen || !files.length) return;
    const f = files.find((x) => x.id === pendingOpen);
    if (f && (f.kind === "pdf" || f.kind === "ofd")) {
      setCurrent(f);
      try { localStorage.setItem("zhanlu.current", f.id); } catch { /* ignore */ }
      setTabs((old) => (old.some((x) => x.id === f.id) ? old : [...old, f]));
      setPendingOpen(null);
    }
  }, [pendingOpen, files]);

  // 深链带来的模式切换（如 #/convert）
  useEffect(() => {
    if (!pendingMode || !current) return;
    saveReaderView(current.id, { mode: pendingMode });
    setPendingMode(null);
  }, [pendingMode, current]); // eslint-disable-line react-hooks/exhaustive-deps

  // R02：重启后恢复上次打开的文档（标签已持久化，这里补 current）
  useEffect(() => {
    if (pendingOpen || current || !tabs.length || !files.length) return;
    let savedId: string | null = null;
    try { savedId = localStorage.getItem("zhanlu.current"); } catch { /* ignore */ }
    const target = tabs.find((t) => t.id === savedId) || tabs.at(-1);
    if (target && files.some((f) => f.id === target.id)) setCurrent(target);
    else if (target && !files.some((f) => f.id === target.id)) setTabs((old) => old.filter((t) => t.id !== target.id));
  }, [current, tabs, files, pendingOpen]);

  const startTask = useCallback((kind: TaskKind, selected: FileEntry[]) => {
    const tab = newTaskTab(kind, selected);
    setTaskTabs((old) => [...old, tab]);
    location.hash = `#/task/${tab.id}`;
  }, []);

  const setTaskTabTitle = useCallback((id: string, title: string) => {
    setTaskTabs((old) => old.map((t) => (t.id === id ? { ...t, title } : t)));
  }, []);

  const switchTaskTab = useCallback((id: string) => { location.hash = `#/task/${id}`; }, []);

  /** 批量关闭工作标签（右键菜单与单个关闭共用）：
   *  激活项未在关闭集合 → 保持；被关 → 逻辑顺序（PDF→任务）中右侧优先的相邻幸存标签；无幸存 → 回首页。
   *  关闭任务标签不取消任务（任务继续执行，可从任务入口查看）。 */
  const closeWorkTabs = useCallback((pdfIds: string[], taskIds: string[]) => {
    const closePdfs = new Set(pdfIds);
    const closeTasks = new Set(taskIds);
    const nextTabs = tabs.filter((f) => !closePdfs.has(f.id));
    const nextTaskTabs = taskTabs.filter((t) => !closeTasks.has(t.id));
    const active = hashState.route === "task" && hashState.taskId
      ? { kind: "task" as const, id: hashState.taskId }
      : current ? { kind: "pdf" as const, id: current.id } : null;
    const isClosed = (k: { kind: string; id: string }) =>
      k.kind === "pdf" ? closePdfs.has(k.id) : closeTasks.has(k.id);
    const order = [
      ...tabs.map((f) => ({ kind: "pdf" as const, id: f.id })),
      ...taskTabs.map((t) => ({ kind: "task" as const, id: t.id })),
    ];
    let nextActive: { kind: "pdf" | "task"; id: string } | null = null;
    if (active && !isClosed(active)) nextActive = active;
    else if (active) {
      const ai = order.findIndex((o) => o.kind === active.kind && o.id === active.id);
      nextActive = order.slice(ai + 1).find((o) => !isClosed(o))
        || [...order.slice(0, ai)].reverse().find((o) => !isClosed(o)) || null;
    }
    setTabs(nextTabs);
    setTaskTabs(nextTaskTabs);
    if (!nextActive) {
      if (active) {
        setCurrent(null);
        try { localStorage.removeItem("zhanlu.current"); } catch { /* ignore */ }
        location.hash = "#/home";
      }
      return;
    }
    if (nextActive.kind === "pdf") {
      const f = nextTabs.find((t) => t.id === nextActive.id);
      if (!f) return;
      setCurrent(f);
      try { localStorage.setItem("zhanlu.current", f.id); } catch { /* ignore */ }
      if (active) location.hash = "#/reader";
    } else if (active) {
      location.hash = `#/task/${nextActive.id}`;
    }
  }, [tabs, taskTabs, current, hashState.route, hashState.taskId]);

  const closeTaskTab = useCallback((id: string) => closeWorkTabs([], [id]), [closeWorkTabs]);

  const closeTab = useCallback((id: string) => closeWorkTabs([id], []), [closeWorkTabs]);

  const saveReaderView = useCallback((id: string, view: ReaderView) => {
    setReaderView((old) => {
      const next = { ...old, [id]: { ...old[id], ...view } };
      try { localStorage.setItem("zhanlu.readerView", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const docMode: DocMode = (current?.id && readerView[current.id]?.mode) || "reader";
  const aiOpen = !!(current?.id && readerView[current.id]?.aiOpen);
  const setDocMode = useCallback((mode: DocMode) => {
    if (current?.id) saveReaderView(current.id, { mode });
  }, [current?.id, saveReaderView]);
  const setAiOpen = useCallback((open: boolean) => {
    if (current?.id) saveReaderView(current.id, { aiOpen: open });
    if (open) setAiGuideOpen(false);
  }, [current?.id, saveReaderView]);

  // 切换文档后跟随新文档会话：上一份的未应用页面变更不带入
  useEffect(() => { setPagesDirty(false); }, [current?.id]);

  /** AI 始终属于当前 PDF：激活/建立该 PDF 标签后展开右侧 Chat 浮层，不新建任务标签、不改变当前模式 */
  const openAiForFile = useCallback((f: FileEntry, action?: "explain" | "translate") => {
    if (f.kind !== "pdf") return;
    setCurrent(f);
    try { localStorage.setItem("zhanlu.current", f.id); } catch { /* ignore */ }
    setTabs((old) => (old.some((x) => x.id === f.id) ? old : [...old, f]));
    if (action) setSelection((selected) => selected?.fileId === f.id ? { ...selected, action } : null);
    saveReaderView(f.id, { aiOpen: true });
    setAiGuideOpen(false);
    location.hash = "#/reader";
  }, [saveReaderView]);

  /** 来源引用：切回阅读、定位原页并收起 Chat；缩放与页码由 readerView 保留 */
  const gotoPage = useCallback((page: number) => {
    if (!current) return;
    saveReaderView(current.id, { mode: "reader", aiOpen: false });
    setReaderJump({ id: current.id, page, key: Date.now() });
    location.hash = "#/reader";
    setTimeout(() => window.dispatchEvent(new CustomEvent("zhanlu:focus-canvas")), 60);
  }, [current, saveReaderView]);

  const consumeReaderJump = useCallback(() => setReaderJump(null), []);

  const ctx = {
    appInfo, files, refreshFiles, engines, refreshEngines,
    current, setCurrent, openFile, tabs, closeTab, closeWorkTabs,
    taskSeed: activeTaskTab?.seed || null, startTask, setTaskTabTitle, taskTabs,
    activeTaskTabId: hashState.taskId, taskTabId: null, switchTaskTab, closeTaskTab,
    readerView, saveReaderView, docMode, setDocMode, aiOpen, setAiOpen,
    aiGuideOpen, setAiGuideOpen, aiTriggerRef, openAiForFile, gotoPage, pagesDirty, setPagesDirty,
    readerJump, consumeReaderJump, docStatus, setDocStatus, toast,
    selection, setSelection,
  };

  // 气泡与 Chat 的避让：阅读内转换面板展开时移到面板左侧（Figma 61/66）
  const convertOpen = route === "reader" && docMode === "convert" && (current?.kind === "pdf" || current?.kind === "ofd");

  return (
    <div className="app" data-route={route} data-convert-open={convertOpen ? "1" : "0"}>
      <AppCtx.Provider value={ctx}>
        <Spine route={route} />
        <main className={route === "reader" ? "screen screen-reader" : "screen"}>
          {route === "home" && <Home />}
          {route === "reader" && <Reader key={current?.id || "empty"} />}
          {route === "settings" && <Settings />}
          {taskTabs.map((tab) => {
            const TaskScreen = SCREENS[tab.kind];
            return <div key={tab.id} className="task-tab-pane" hidden={hashState.taskId !== tab.id || route !== tab.kind}>
              <AppCtx.Provider value={{ ...ctx, taskSeed: tab.seed, taskTabId: tab.id }}><TaskScreen /></AppCtx.Provider>
            </div>;
          })}
        </main>
        {(route === "home" || route === "reader") && (
          <>
            <AiChat home={route === "home"} />
            <AiLauncher home={route === "home"} />
          </>
        )}
      </AppCtx.Provider>
      <div className="toast" role="status">
        {toasts.map((t) => <div key={t.id} className={t.err ? "err" : ""}>{t.msg}</div>)}
      </div>
    </div>
  );
}
