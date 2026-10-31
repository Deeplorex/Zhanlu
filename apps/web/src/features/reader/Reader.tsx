import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { AppCtx } from "../../app/AppContext";
import { cancelTask, get, jobsRun, post, rawUrl, uploadFiles, waitTask } from "../../shared/api";
import { openRegistered, pickPdfsNative } from "../../shared/nativeOpen";
import Icon from "../../shared/Icon";
import SwordProgress, { swordRunningText } from "../../shared/SwordProgress";
import { printPdf } from "./printPdf";
import type { AiConfig, FileInfo, FileEntry, OutlineNode } from "../../shared/types";
import type { ReaderConvertTarget } from "./ReaderConvertPanel";
import ReaderConvertPanel from "./ReaderConvertPanel";
import ReaderOfdPanel from "./ReaderOfdPanel";
import PagesGrid from "../pages/PagesGrid";
import { clamp, ContinuousPages, PageView } from "./PageViews";
import ImmersiveLayer, { type ImmersiveMode } from "./ImmersiveLayer";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type PDFDoc = pdfjs.PDFDocumentProxy;
type SideTab = "thumbs" | "bookmarks" | "search";

interface SearchHit { page: number; snippet: string; spans: { itemIdx: number; start: number; len: number }[] }

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 840);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 840);
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

// ---------------- 目录 ----------------

interface AiSendScope {
  pages: number[];
  total_pages: number;
  text_pages: number;
  characters: number;
  detail: string;
}

function scopePageRanges(pages: number[]): string {
  if (!pages.length) return "所选文字";
  const ranges: string[] = [];
  for (let i = 0; i < pages.length;) {
    let end = i;
    while (end + 1 < pages.length && pages[end + 1] === pages[end] + 1) end++;
    ranges.push(i === end ? `${pages[i]}` : `${pages[i]}–${pages[end]}`);
    i = end + 1;
  }
  return `第 ${ranges.join("、")} 页`;
}

/** AI 目录条目（引擎 action=outline）按 l=1/l=2 归并为两级树 */
function buildTocTree(items: { title: string; page: number; level?: number }[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  let last: OutlineNode | null = null;
  for (const it of items) {
    const node: OutlineNode = { title: it.title, page: it.page, children: [] };
    if (it.level === 2 && last) last.children.push(node);
    else { roots.push(node); last = node; }
  }
  return roots;
}

/** 目录面板的 AI 识别区：与任务执行/远程确认逻辑（Reader 主组件）解耦，只吃状态 */
interface AiTocState {
  saved?: OutlineNode[];
  busy: boolean;
  progress: number;
  progressKnown?: boolean;
  cancelling?: boolean;
  error: string | null;
  taskId: string | null;
  onStart: () => void;
  onCancel: () => void;
}

function OutlineTree({ nodes, onJump, ai }: {
  nodes?: OutlineNode[];
  onJump: (p: number) => void;
  ai?: AiTocState;
}) {
  const walk = (list: OutlineNode[], lv: number): React.ReactNode => (
    <>
      {list.map((n, i) => (
        <React.Fragment key={`${lv}-${i}`}>
          <button type="button" className={"node" + (lv ? " lv2" : "")} onClick={() => n.page && onJump(n.page)}>
            <span>{n.title}</span><span className="leader" /><span className="p">{n.page || "?"}</span>
          </button>
          {n.children?.length ? walk(n.children, lv + 1) : null}
        </React.Fragment>
      ))}
    </>
  );
  if (nodes && nodes.length) return <div className="bm">{walk(nodes, 0)}</div>;
  const aiNodes = ai?.saved;
  return (
    <div className="bm-empty">
      <div className="note side-note">此文档没有书签目录。</div>
      {ai && ai.busy ? (
        <div className="bm-ai-busy" role="status">
          <strong>{ai.cancelling ? "正在取消识别…"
            : ai.taskId ? swordRunningText({ progress: ai.progress, progressKnown: ai.progressKnown })
            : "正在提交识别任务…"}</strong>
          {ai.taskId && <SwordProgress value={ai.progress} unknown={ai.progressKnown === false} label="AI 识别目录" />}
          {ai.taskId && !ai.cancelling && <button type="button" className="bm-ai-redo" onClick={ai.onCancel}>取消</button>}
        </div>
      ) : aiNodes && aiNodes.length > 0 ? (
        <>
          <div className="bm-ai-head">
            <span className="bm-ai-badge">AI 识别 · {aiNodes.reduce((n, r) => n + 1 + (r.children?.length || 0), 0)} 项</span>
            <button type="button" className="bm-ai-redo" onClick={ai!.onStart} disabled={ai!.busy}>重新识别</button>
          </div>
          <div className="bm">{walk(aiNodes, 0)}</div>
        </>
      ) : ai ? (
        <div className="bm-ai-start">
          {ai.error && (
            <p className="bm-ai-err">
              {ai.error}
              {/请先完成 OCR|没有可提取的文字/.test(ai.error) && (
                <button type="button" className="bm-ai-ocr"
                        onClick={() => window.dispatchEvent(new CustomEvent("zhanlu:ocr-current"))}>去 OCR</button>
              )}
            </p>
          )}
          <button type="button" className="bm-ai-btn" onClick={ai.onStart}>AI 识别目录</button>
          <p className="bm-ai-hint">使用当前模型读取文档文字生成目录；远程模型发送前需确认。</p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------- 阅读器主组件 ----------------

export default function Reader() {
  const {
    current: file, openFile, docMode, setDocMode, aiOpen, setAiOpen, aiTriggerRef, setSelection, openAiForFile, startTask,
    readerView, saveReaderView, readerJump, consumeReaderJump, docStatus, setDocStatus,
    appInfo, refreshFiles, toast, pagesDirty,
  } = React.useContext(AppCtx);

  const [doc, setDoc] = useState<PDFDoc | null>(null);
  const [docErr, setDocErr] = useState<string | null>(null);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [pageInvalid, setPageInvalid] = useState(false);
  const [scale, setScale] = useState(1);
  const [continuous, setContinuous] = useState(true);
  const [viewRotate, setViewRotate] = useState(0);
  const [jumpToken, setJumpToken] = useState(0);
  const [tab, setTab] = useState<SideTab>("thumbs");
  const [sideOpen, setSideOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeHit, setActiveHit] = useState<number | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<string | null>(null);
  const [passwordProtected, setPasswordProtected] = useState(false);
  const [passwordValue, setPasswordValue] = useState("");
  const [selPopup, setSelPopup] = useState<{ text: string; page: number; x: number; y: number } | null>(null);
  const [convertTarget, setConvertTargetState] = useState<ReaderConvertTarget>(() => {
    const saved = file ? readerView[file.id]?.convertTarget : undefined;
    return saved && ["png", "jpg", "txt", "md", "docx", "xlsx", "csv", "pptx"].includes(saved) ? saved : "png";
  });
  const setConvertTarget = useCallback((t: ReaderConvertTarget) => {
    setConvertTargetState(t);
    if (file) saveReaderView(file.id, { convertTarget: t });
  }, [file, saveReaderView]);
  const [printConfirm, setPrintConfirm] = useState(false);
  // AI 识别目录（无书签文档）：结果随 readerView 持久化；任务与确认状态随当前文件
  const [tocBusy, setTocBusy] = useState(false);
  const [tocProgress, setTocProgress] = useState(0);
  const [tocKnown, setTocKnown] = useState(true);
  const [tocCancelling, setTocCancelling] = useState(false);
  const [tocTaskId, setTocTaskId] = useState<string | null>(null);
  const [tocError, setTocError] = useState<string | null>(null);
  const [tocConsent, setTocConsent] = useState<{ scope: AiSendScope; cfg: { id: string; local: boolean }; host: string; model: string } | null>(null);
  const tocConfirmedRef = useRef<string | null>(null);
  const tocFileRef = useRef<string | null>(null);
  const tocTaskRef = useRef<string | null>(null);
  useEffect(() => { tocFileRef.current = file?.id || null; }, [file?.id]);
  const [thumbDpi] = useState(26);
  const [ocrTask, setOcrTask] = useState<{ id: string; status: string; progress: number; progressKnown?: boolean; error?: string | null } | null>(null);
  const [ocrDone, setOcrDone] = useState<FileEntry | null>(null);
  const [currentPageTextless, setCurrentPageTextless] = useState(false);
  const [restored, setRestored] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [immersive, setImmersive] = useState<ImmersiveMode | null>(null);
  // OFD：打开即自动转换 PDF 预览（缓存命中秒开），阅读/放映/搜索都作用在预览 PDF 上
  const [ofdPreview, setOfdPreview] = useState<{ file: FileEntry; note: string } | null>(null);
  const [ofdError, setOfdError] = useState<string | null>(null);
  const [ofdTask, setOfdTask] = useState<{ id: string; status: string; progress: number; progressKnown?: boolean } | null>(null);
  const printAbort = useRef<AbortController | null>(null);
  useEffect(() => () => printAbort.current?.abort(), [file?.id]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openOtherInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null);
  const pwUpdateRef = useRef<((pw: string) => void) | null>(null);
  const pwCancelled = useRef(false);
  const narrow = useNarrow();

  useEffect(() => {
    if (narrow) setSideOpen(false);
  }, [narrow]);

  // 每份文档恢复视图状态（R02）
  const v = file ? readerView[file.id] : undefined;
  useEffect(() => {
    if (!file) return;
    setPageNum(v?.page || 1);
    setScale(v?.scale ?? 1);
    setContinuous(v?.continuous ?? true);
    setTab(v?.tab || "thumbs");
    setQuery(v?.query || "");
    setViewRotate(v?.rotate || 0);
    setSideOpen(window.innerWidth > 840);
    setRestored(true);
    setDocStatus(v?.page && v.page > 1 ? `第 ${v.page} 页已恢复` : null);
    setTocBusy(false); setTocProgress(0); setTocKnown(true); setTocCancelling(false);
    setTocTaskId(null); setTocError(null); setTocConsent(null);
    if (tocTaskRef.current) { cancelTask(tocTaskRef.current).catch(() => {}); }
    const t = setTimeout(() => setDocStatus(null), 8000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  useEffect(() => { setPageDraft(String(pageNum)); }, [pageNum]);
  useEffect(() => {
    if (file?.id) saveReaderView(file.id, { page: pageNum, scale, tab, query, continuous, rotate: viewRotate });
  }, [file?.id, pageNum, scale, tab, query, continuous, viewRotate, saveReaderView]);

  useEffect(() => {
    if (readerJump && file && readerJump.id === file.id) {
      setPageNum(readerJump.page);
      setJumpToken((x) => x + 1);
      setDocStatus(`第 ${readerJump.page} 页已恢复`);
      consumeReaderJump();
    }
  }, [readerJump, file?.id, consumeReaderJump, setDocStatus]);

  // OFD：打开即自动生成 PDF 预览（每文件一次；Reader 按文件 id 重挂载）
  useEffect(() => {
    if (!file || file.kind !== "ofd") return;
    let alive = true;
    setOfdPreview(null); setOfdError(null); setOfdTask({ id: "", status: "submitting", progress: 0 });
    (async () => {
      try {
        const started = await jobsRun("ofd_preview", { id: file.id });
        if (!alive) return;
        setOfdTask({ id: started.id, status: "running", progress: 0 });
        const done = await waitTask(started.id, { onTick: (t) => {
          if (alive) setOfdTask({ id: t.id, status: t.status, progress: t.progress, progressKnown: t.progressKnown });
        } });
        if (!alive) return;
        if (done.status === "done") {
          const f = done.result?.file as FileEntry | undefined;
          if (f) setOfdPreview({ file: f, note: String((done.result as { note?: string })?.note || "") });
          else setOfdError("预览转换未返回文件。");
          setOfdTask(null);
        } else if (done.status === "cancelled") {
          setOfdTask(null);
          setOfdError("已取消预览转换，可重新打开该文件重试。");
        } else {
          setOfdTask(null);
          setOfdError(`预览转换失败：${done.error || done.status}`);
        }
      } catch (e) {
        if (!alive) return;
        setOfdTask(null);
        setOfdError(`预览转换失败：${(e as Error).message}`);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // 阅读渲染目标：PDF 是文件本身；OFD 是转换后的预览 PDF
  const viewFileId = file?.kind === "ofd" ? (ofdPreview?.file.id ?? null) : (file?.id ?? null);
  const isOfd = file?.kind === "ofd";
  // 侧栏（缩略图等）作用于预览 PDF，但展示原文件名（仅在 file 非空分支使用）
  const sideFile = file && isOfd && ofdPreview ? { ...file, id: ofdPreview.file.id, pages: ofdPreview.file.pages } : file!;

  // 载入文档
  useEffect(() => {
    setDoc(null); setDocErr(null); setInfo(null); setHits(null); setActiveHit(null);
    setPasswordPrompt(null); setPasswordProtected(false); setPasswordValue(""); setSelPopup(null); setOcrTask(null); setOcrDone(null);
    pwUpdateRef.current = null; pwCancelled.current = false;
    if (!file) return;
    if (isOfd) {
      get<FileInfo>(`/api/files/${file.id}/info`).then((r) => setInfo(r)).catch(() => {});
      if (!viewFileId) return; // 预览转换进行中
    } else if (file.kind !== "pdf") {
      setDocErr("阅读器只支持 PDF 与 OFD。"); return;
    } else {
      get<FileInfo>(`/api/files/${file.id}/info?probe=text`).then((r) => {
        setInfo(r);
      }).catch(() => {});
    }
    const task = pdfjs.getDocument({
      url: rawUrl(viewFileId || file.id),
      cMapUrl: new URL("cmaps/", document.baseURI).href, // 中文 CID 字体必需
      cMapPacked: true,
    } as never);
    loadingRef.current = task;
    let cancelled = false;
    task.onPassword = (update: (pw: string) => void, reason: number) => {
      if (cancelled) return;
      pwUpdateRef.current = update;
      setPasswordProtected(true);
      setPasswordValue("");
      setPasswordPrompt(reason === 2 ? "密码不正确，请重试。" : "此 PDF 需要打开密码。");
    };
    task.promise.then((d) => {
      if (cancelled) return;
      setDocErr(null);
      setDoc(d);
      setPageNum((p) => clamp(p, 1, d.numPages));
    }).catch((e: unknown) => {
      if (cancelled || pwCancelled.current) return;
      setDocErr(String((e as Error)?.message || e));
    });
    return () => { cancelled = true; pwCancelled.current = true; task.destroy?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, viewFileId]);

  const jump = useCallback((p: number) => {
    if (doc && p >= 1 && p <= doc.numPages) { setPageNum(p); setJumpToken((x) => x + 1); }
  }, [doc]);

  // 全屏预览/放映退出：回到 Reader 并定位到离开时的页
  const exitImmersive = useCallback((page: number) => {
    setImmersive(null);
    jump(page);
  }, [jump]);

  // 搜索：全文 + 每项命中范围（供高亮）
  const doSearch = useCallback(async (qRaw: string) => {
    if (!doc) return;
    const q = qRaw.trim().toLowerCase();
    if (!q) { setHits(null); setActiveHit(null); return; }
    setSearching(true);
    const out: SearchHit[] = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const items = (content.items as any[]).filter((it) => "str" in it);
        let text = "";
        const lengths: number[] = [];
        items.forEach((it) => { lengths.push(text.length); text += it.str; });
        const lower = text.toLowerCase();
        let idx = lower.indexOf(q);
        let guard = 0;
        while (idx >= 0 && guard++ < 200) {
          let itemIdx = lengths.findIndex((l, k) => l <= idx && (k === lengths.length - 1 || lengths[k + 1] > idx));
          if (itemIdx < 0) itemIdx = 0;
          let covered = 0;
          let cursor = idx;
          const spans: SearchHit["spans"] = [];
          while (covered < q.length && itemIdx < items.length) {
            const itemStart = lengths[itemIdx];
            const itemLen = items[itemIdx].str.length;
            const localStart = cursor - itemStart;
            const take = Math.min(q.length - covered, itemLen - localStart);
            if (take > 0) spans.push({ itemIdx, start: localStart, len: take });
            covered += take;
            cursor += take;
            itemIdx += 1;
          }
          const snippet = text.slice(Math.max(0, idx - 18), idx + q.length + 24);
          out.push({ page: i, snippet, spans });
          idx = lower.indexOf(q, idx + q.length);
        }
        if (out.length >= 300) break;
      }
      setHits(out);
      setActiveHit(null);
    } finally { setSearching(false); }
  }, [doc]);

  useEffect(() => {
    let active = true;
    setCurrentPageTextless(false);
    if (doc) void doc.getPage(pageNum).then((page) => page.getTextContent()).then((content) => {
      if (active) setCurrentPageTextless(!content.items.some((item) => "str" in item && !!item.str.trim()));
    }).catch(() => {});
    return () => { active = false; };
  }, [doc, pageNum]);

  // 输入防抖自动搜索
  useEffect(() => {
    if (!doc) return;
    const q = query.trim();
    if (!q) { setHits(null); setActiveHit(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => { void doSearch(q); }, 280);
    return () => clearTimeout(t);
  }, [query, doc, doSearch]);

  // 搜索状态反映到底栏（47：查找结果待定位）
  useEffect(() => {
    if (docMode !== "reader" || tab !== "search" || !query.trim()) { if (docStatus === "查找结果待定位") setDocStatus(null); return; }
    if (hits === null) return;
    setDocStatus(activeHit == null && hits.length > 0 ? "查找结果待定位" : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits, activeHit, tab, docMode, query]);

  const highlight: { query: string; matches: Map<number, SearchHit["spans"]> } | null = useMemo(() => {
    if (!query.trim() || activeHit == null || !hits?.length) return null;
    const hit = hits[activeHit];
    const m = new Map<number, SearchHit["spans"]>();
    m.set(hit.page, hit.spans || []);
    return { query: query.trim(), matches: m };
  }, [query, activeHit, hits]);

  const stepHit = (dir: 1 | -1) => {
    if (!hits?.length) return;
    setActiveHit((cur) => {
      const next = cur == null ? (dir === 1 ? 0 : hits.length - 1) : clamp(cur + dir, 0, hits.length - 1);
      jump(hits[next].page);
      return next;
    });
  };

  const onSelection = useCallback((text: string, page: number) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { setSelPopup(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const host = scrollRef.current?.getBoundingClientRect();
    if (!host) return;
    setSelPopup({
      text, page,
      x: rect.left - host.left + rect.width / 2 + (scrollRef.current?.scrollLeft || 0),
      y: rect.top - host.top + (scrollRef.current?.scrollTop || 0) - 8,
    });
  }, []);

  const copySelection = async () => {
    if (!selPopup) return;
    try {
      await navigator.clipboard.writeText(selPopup.text);
      toast(`已复制第 ${selPopup.page} 页选区文字`);
    } catch (e) { toast(`复制失败：${(e as Error).message}`, true); }
    setSelPopup(null);
  };

  const sendToAi = (action: "explain" | "translate") => {
    if (!file || !selPopup) return;
    setSelection({ fileId: file.id, text: selPopup.text, page: selPopup.page });
    setSelPopup(null);
    openAiForFile(file, action);
  };

  // ---- AI 识别目录（无书签文档；远程模型沿用逐文档发送确认，Figma 52/55 规则） ----
  const startAiToc = async () => {
    if (!file || tocBusy) return;
    setTocError(null);
    let picked: { id: string; local: boolean; host: string; model: string } | null = null;
    try {
      const [cfgRes, actRes] = await Promise.all([
        get<{ configs: AiConfig[] }>("/api/ai/configs"),
        get<{ effective: string | null }>("/api/ai/active"),
      ]);
      // 目录识别使用当前默认模型（与引擎通道优先级一致），不弹模型选择
      const hit = (actRes.effective && cfgRes.configs.find((c) => c.id === actRes.effective)) || null;
      if (!hit) { toast("请先在设置中连接模型，再识别目录。", true); return; }
      const host = new URL(hit.baseurl).hostname.toLowerCase();
      picked = { id: hit.id, local: ["127.0.0.1", "localhost", "[::1]"].includes(host), host, model: hit.model };
    } catch (e) { toast(`无法读取模型配置：${(e as Error).message}`, true); return; }
    if (!picked.local && tocConfirmedRef.current !== `${file.id}:${picked.id}`) {
      try {
        const scope = await post<AiSendScope>("/api/ai/scope", { id: file.id, action: "outline" });
        setTocConsent({ scope, cfg: { id: picked.id, local: picked.local }, host: picked.host, model: picked.model });
      } catch (e) { setTocError((e as Error).message); }
      return;
    }
    await runAiToc(picked);
  };

  const runAiToc = async (cfg: { id: string; local: boolean }) => {
    if (!file) return;
    const boundId = file.id;
    setTocError(null); setTocBusy(true); setTocProgress(0); setTocKnown(true); setTocCancelling(false);
    setTocTaskId(null); tocTaskRef.current = null;
    try {
      const started = await jobsRun("ai_analyze", {
        id: file.id, action: "outline", config_id: cfg.id, allow_remote: !cfg.local, depth: "high",
      });
      setTocTaskId(started.id); tocTaskRef.current = started.id;
      const done = await waitTask(started.id, {
        timeout: 1_800_000,
        onTick: (t) => { setTocProgress(t.progress); setTocKnown(t.progressKnown !== false); },
      });
      if (tocFileRef.current !== boundId) return;
      const items = done.result?.outline || [];
      if (!items.length) throw new Error("AI 未能从这份文档中识别出标题结构。");
      saveReaderView(boundId, { aiOutline: buildTocTree(items) });
      toast(`已识别目录 · ${items.length} 项`);
    } catch (e) {
      if (tocFileRef.current !== boundId) return;
      const message = (e as Error).message;
      setTocError(message === "已取消" ? "已取消识别。" : message);
    } finally {
      if (tocFileRef.current === boundId) { setTocBusy(false); setTocTaskId(null); setTocCancelling(false); }
      tocTaskRef.current = null;
    }
  };

  const cancelAiToc = async () => {
    if (!tocTaskRef.current || tocCancelling) return;
    setTocCancelling(true);
    try { await cancelTask(tocTaskRef.current); }
    catch (e) { setTocCancelling(false); toast(`取消失败：${(e as Error).message}`, true); }
  };

  const doPrint = useCallback(async () => {
    if (!file || !doc || printAbort.current) return;
    const controller = new AbortController();
    printAbort.current = controller;
    setPrinting(true);
    try {
      toast(`正在准备 ${doc.numPages} 页打印内容…`);
      await printPdf(doc, file.name, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) toast(`无法打印：${(e as Error).message}`, true);
    } finally { printAbort.current = null; setPrinting(false); }
  }, [doc, file, toast]);

  // 页面模式有未应用变更：打印前明确提示使用已保存版本（2026-10-26 基线）
  const requestPrint = useCallback(() => {
    if (!doc || printing) return;
    if (docMode === "pages" && pagesDirty) { setPrintConfirm(true); return; }
    void doPrint();
  }, [doc, printing, docMode, pagesDirty, doPrint]);

  useEffect(() => {
    const onPrint = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); requestPrint(); }
    };
    addEventListener("keydown", onPrint);
    return () => removeEventListener("keydown", onPrint);
  }, [requestPrint]);

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordValue || !pwUpdateRef.current) return;
    setPasswordPrompt(null);
    pwUpdateRef.current(passwordValue);
    setPasswordValue("");
  };
  const cancelPassword = () => {
    pwCancelled.current = true;
    pwUpdateRef.current = null;
    setPasswordPrompt(null);
    setDocErr("已取消打开受保护文档");
    loadingRef.current?.destroy?.();
  };

  const openOther = async (list: File[]) => {
    const pdfs = list.filter((f) => /\.(pdf|ofd)$/i.test(f.name));
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
  const openOtherNative = async () => {
    try {
      const r = await pickPdfsNative();
      if (r === null) { openOtherInputRef.current?.click(); return; }
      if (r.cancelled) return;
      openRegistered(openFile, r.files);
      if (r.errors.length) toast(`部分文件未能打开：${r.errors[0]}`, true);
    } catch (e) { toast(`打开失败：${(e as Error).message}`, true); }
  };

  // Ctrl+F 聚焦文内查找；Esc 关闭查找
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setDocMode("reader");
        setTab("search");
        setSideOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 30);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [setDocMode]);

  // 全局命令：聚焦查找 / 就地 OCR / 来源跳转后聚焦原文画布 / 全屏预览与放映
  useEffect(() => {
    const onFocusFind = () => { setDocMode("reader"); setTab("search"); setSideOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 30); };
    const onOcr = () => { setDocMode("reader"); void runOcr(); };
    const onFocusCanvas = () => { scrollRef.current?.focus(); };
    const onImmersiveRead = () => setImmersive("read");
    const onPresent = () => setImmersive("slideshow");
    addEventListener("zhanlu:focus-find", onFocusFind);
    addEventListener("zhanlu:ocr-current", onOcr);
    addEventListener("zhanlu:focus-canvas", onFocusCanvas);
    addEventListener("zhanlu:fullscreen-read", onImmersiveRead);
    addEventListener("zhanlu:present", onPresent);
    return () => { removeEventListener("zhanlu:focus-find", onFocusFind); removeEventListener("zhanlu:ocr-current", onOcr); removeEventListener("zhanlu:focus-canvas", onFocusCanvas); removeEventListener("zhanlu:fullscreen-read", onImmersiveRead); removeEventListener("zhanlu:present", onPresent); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  const scanned = currentPageTextless;

  const runOcr = async () => {
    if (!file) return;
    if (ocrTask && (ocrTask.status === "submitting" || ocrTask.status === "running" || ocrTask.status === "cancelling")) return;
    setOcrDone(null);
    setOcrTask({ id: "", status: "submitting", progress: 0 });
    try {
      const suffix = (doc?.numPages || info?.pages || 0) > 1 ? `-p${pageNum}` : "";
      const started = await jobsRun("ocr", { id: file.id, pages: String(pageNum), name: file.name.replace(/\.pdf$/i, "") + suffix + "-可搜索.pdf" });
      setOcrTask({ id: started.id, status: "running", progress: 0 });
      const done = await waitTask(started.id, { onTick: (t) => setOcrTask({ id: t.id, status: t.status, progress: t.progress, progressKnown: t.progressKnown, error: t.error }) });
      setOcrTask({ id: done.id, status: "done", progress: 1 });
      setOcrDone((done.result?.file as FileEntry) || null);
      await refreshFiles();
      toast(`识别完成：已生成可搜索副本（${done.result?.checked ?? "?"} 页）`);
    } catch (e) {
      const message = (e as Error).message;
      if (message === "已取消") {
        setOcrTask({ id: "", status: "cancelled", progress: 0 });
      } else {
        setOcrTask({ id: "", status: "error", progress: 0, error: message });
        toast(`识别失败：${message}`, true);
      }
    }
  };

  const cancelOcr = async () => {
    if (!ocrTask?.id || ocrTask.status !== "running") return;
    setOcrTask({ ...ocrTask, status: "cancelling" });
    try { await cancelTask(ocrTask.id); }
    catch (e) { setOcrTask(ocrTask); toast(`取消失败：${(e as Error).message}`, true); }
  };

  const total = doc ? doc.numPages : info?.pages || 0;

  const commitPageInput = () => {
    const n = Number(pageDraft);
    if (Number.isInteger(n) && n >= 1 && n <= total && total > 0) {
      jump(n);
      setPageInvalid(false);
    } else {
      setPageDraft(String(pageNum));
      setPageInvalid(true);
      setTimeout(() => setPageInvalid(false), 2500);
    }
  };

  const openPanelTab = (t: SideTab) => {
    setDocMode("reader");
    setTab(t);
    setSideOpen(true);
    if (t === "search") setTimeout(() => searchInputRef.current?.focus(), 30);
  };

  const toggleAi = (e: React.MouseEvent<HTMLButtonElement>) => {
    aiTriggerRef.current = e.currentTarget;
    setAiOpen(!aiOpen);
  };


  if (!file) {
    return (
      <div className="reader-empty rise">
        <p className="page-kicker">阅读</p>
        <h1 className="page-title">打开一份 PDF 开始</h1>
        <p className="page-lead">目录、缩略图、查找、页码与缩放常驻；多标签切换保留当前位置。</p>
        <div className="reader-empty-drop">
          <button type="button" className="btn primary" onClick={() => (location.hash = "#/home")}>到首页打开 PDF</button>
          <label className="btn" onClick={(e) => { e.preventDefault(); void openOtherNative(); }}>直接选择文件
            <input ref={openOtherInputRef} type="file" hidden accept=".pdf,.ofd" multiple
                   onClick={(e) => e.stopPropagation()}
                   onChange={(e) => { openOther(Array.from(e.target.files || [])); e.target.value = ""; }} />
          </label>
        </div>
      </div>
    );
  }

  const readerBodyMode = docMode;

  // 上下文工具组（2026-10-26 基线）：整组按窗口宽度居中，槽位固定，竖线分隔打印
  // OFD：无页面整理/转换 PDF 工具；阅读组不含 AI 与 OCR（引擎按 PDF 处理）
  const tools: React.ReactNode[] = !isOfd && readerBodyMode === "pages" ? [
    <button key="organize" type="button" className="tact on" style={{ width: 144 }} aria-current="page"><Icon name="pages" />整理当前 PDF</button>,
    <button key="split" type="button" className="tact" style={{ width: 160 }} title="在任务标签中选择规则并另存"
            onClick={() => startTask("split", [file!])}><Icon name="split" />拆分成多个 PDF</button>,
    <button key="merge" type="button" className="tact" style={{ width: 152 }} title="建立独立任务标签"
            onClick={() => startTask("merge", [])}><Icon name="merge" />合并多份 PDF</button>,
    <span key="sep" className="tsep" aria-hidden="true" />,
    <button key="print" type="button" className="tact" style={{ width: 88 }} onClick={requestPrint}
            disabled={!doc || printing} aria-busy={printing}><Icon name="print" />打印</button>,
  ] : !isOfd && readerBodyMode === "convert" ? [
    <button key="img" type="button" className={"tact" + (convertTarget === "png" || convertTarget === "jpg" ? " on" : "")} style={{ width: 144 }}
            aria-pressed={convertTarget === "png" || convertTarget === "jpg"}
            onClick={() => setConvertTarget(convertTarget === "jpg" ? "jpg" : "png")}><Icon name="images" />转换为图片</button>,
    <button key="md" type="button" className={"tact" + (convertTarget === "md" ? " on" : "")} style={{ width: 200 }}
            aria-pressed={convertTarget === "md"} onClick={() => setConvertTarget("md")}><Icon name="markdown" />转换为 Markdown</button>,
    <button key="txt" type="button" className={"tact" + (convertTarget === "txt" ? " on" : "")} style={{ width: 120 }}
            aria-pressed={convertTarget === "txt"} onClick={() => setConvertTarget("txt")}><Icon name="output" />提取 TXT</button>,
    <button key="ocr" type="button" className="tact" style={{ width: 152 }} onClick={() => void runOcr()}
            title="当前页无文字层时先在本机识别"><Icon name="search" />扫描页先 OCR</button>,
  ] : [
    <button key="thumbs" type="button" className={"tact" + (tab === "thumbs" && sideOpen ? " on" : "")} style={{ width: 96 }}
            aria-pressed={tab === "thumbs" && sideOpen} onClick={() => openPanelTab("thumbs")}><Icon name="pages" />缩略图</button>,
    <button key="bookmarks" type="button" className={"tact" + (tab === "bookmarks" && sideOpen ? " on" : "")} style={{ width: 88 }}
            aria-pressed={tab === "bookmarks" && sideOpen} onClick={() => openPanelTab("bookmarks")}><Icon name="read" />目录</button>,
    <button key="search" type="button" className={"tact" + (tab === "search" && sideOpen ? " on" : "")} style={{ width: 112 }}
            aria-pressed={tab === "search" && sideOpen} onClick={() => openPanelTab("search")}><Icon name="search" />查找文字</button>,
    ...(!isOfd ? [
      <button key="ai" type="button" className={"tact" + (aiOpen ? " on" : "")} style={{ width: 112 }}
              aria-pressed={aiOpen} title="打开当前 PDF 的 AI 对话" onClick={toggleAi}><Icon name="ai" />AI 阅读</button>,
      <span key="sep1" className="tsep" aria-hidden="true" />,
    ] : []),
    <button key="immersive" type="button" className="tact" style={{ width: 112 }} title="全屏预览：隐藏界面沉浸阅读（Esc 退出）"
            onClick={() => setImmersive("read")} disabled={!doc}><Icon name="expand" />全屏预览</button>,
    <button key="present" type="button" className="tact" style={{ width: 88 }} title="放映：整页居中逐页演示，← → 翻页"
            onClick={() => setImmersive("slideshow")} disabled={!doc}><Icon name="play" />放映</button>,
    <span key="sep" className="tsep" aria-hidden="true" />,
    <button key="print" type="button" className="tact" style={{ width: 88 }} onClick={requestPrint}
            disabled={!doc || printing} aria-busy={printing}><Icon name="print" />打印</button>,
  ];

  return (
    <div className="reader-root">
      <h1 className="sr-only">阅读 {file.name}</h1>

      {/* 工具行：整组按窗口内容宽度居中（Figma 59–61） */}
      <div className="reader-toolbar" role="toolbar" aria-label="文档工具">
        <div className="reader-tools">
          {tools.map((t, i) => (
            <React.Fragment key={i}>{t}</React.Fragment>
          ))}
        </div>
      </div>

      {/* OFD 预览横幅（v0.2 M3）：说明预览性质并提供另存入口 */}
      {isOfd && (
        <div className="ofd-banner" role="status">
          {ofdPreview ? (
            <>
              <span className="ofd-banner-text" title={ofdPreview.note || undefined}>
                已转换为 PDF 预览{ofdPreview.note && ofdPreview.note !== "缓存命中" ? ` · ${ofdPreview.note}` : ""}
              </span>
              <button type="button" className="ofd-banner-btn" onClick={() => setDocMode("convert")}>另存 PDF</button>
            </>
          ) : (
            <span className="ofd-banner-text">正在生成 PDF 预览…</span>
          )}
        </div>
      )}

      {/* 主体 */}
      <div className="reader-body">
        {readerBodyMode === "pages" ? (
          <PagesGrid file={file} total={total} />
        ) : (
          <>
            {!narrow || (narrow && sideOpen) ? (
              <SidePanel file={sideFile} tab={tab} sideOpen={sideOpen} setSideOpen={setSideOpen} passwordProtected={passwordProtected}
                         narrow={narrow} overlay={narrow} doc={doc} pageNum={pageNum} jump={jump} info={info}
                         query={query} setQuery={setQuery} hits={hits} searching={searching} activeHit={activeHit}
                         setActiveHit={setActiveHit} stepHit={stepHit} scanned={!!scanned} runOcr={runOcr}
                         ocrTask={ocrTask} ocrDone={ocrDone} searchInputRef={searchInputRef}
                         cancelOcr={cancelOcr}
                         toc={{
                           saved: readerView[file.id]?.aiOutline,
                           busy: tocBusy, progress: tocProgress, progressKnown: tocKnown,
                           cancelling: tocCancelling, error: tocError, taskId: tocTaskId,
                           onStart: () => void startAiToc(), onCancel: () => void cancelAiToc(),
                         }}
                         openOcrResult={() => { if (ocrDone) { saveReaderView(ocrDone.id, { page: pageNum, tab: "search", query }); openFile(ocrDone, pageNum); } }}
                         appOcrAvailable={!!appInfo?.ocr_available} />
            ) : (
              <aside className="side-rail" aria-label="侧栏导航">
                <button type="button" className={tab === "thumbs" ? "on" : ""} aria-label="缩略图" title="缩略图" onClick={() => openPanelTab("thumbs")}><Icon name="pages" /></button>
                <button type="button" className={tab === "bookmarks" ? "on" : ""} aria-label="目录" title="目录" onClick={() => openPanelTab("bookmarks")}><Icon name="read" /></button>
                <button type="button" className={tab === "search" ? "on" : ""} aria-label="查找文字" title="查找文字" onClick={() => openPanelTab("search")}><Icon name="search" /></button>
              </aside>
            )}
            <div className="canvas" ref={scrollRef} tabIndex={-1}>
              {docErr ? (
                <div className="ofd-note">
                  无法渲染：{docErr}
                  <div><button type="button" className="btn sm" onClick={() => (location.hash = "#/home")}>返回首页</button></div>
                </div>
              ) : doc ? (
                <div className="canvas-inner" style={{ position: "relative" }}>
                  {continuous ? (
                    <ContinuousPages doc={doc} scale={scale} viewRotate={viewRotate} pageNum={pageNum}
                                     jumpToken={jumpToken} scrollRef={scrollRef} onCurrentPage={setPageNum}
                                     needText highlight={highlight} onSelection={onSelection} />
                  ) : (
                    <div className="single-page" style={{ position: "relative" }}>
                      <PageView doc={doc} number={pageNum} scale={scale} viewRotate={viewRotate}
                                needText highlight={highlight} onSelection={onSelection} />
                      {selPopup && <SelectionPopup popup={selPopup} onCopy={copySelection} onAi={sendToAi} onClose={() => setSelPopup(null)} />}
                    </div>
                  )}
                  {continuous && selPopup && <SelectionPopup popup={selPopup} onCopy={copySelection} onAi={sendToAi} onClose={() => setSelPopup(null)} />}
                </div>
              ) : isOfd && !ofdPreview ? (
                <div className="ofd-note ofd-preview-note">
                  <p>正在生成 PDF 预览（版式级转换，缓存后秒开）…</p>
                  {ofdTask && ofdTask.status !== "submitting" && (
                    <SwordProgress value={ofdTask.progress} unknown={ofdTask.progressKnown === false} label="OFD 预览转换" />
                  )}
                  {ofdError && <p className="wf-error" role="alert">{ofdError}</p>}
                </div>
              ) : (
                <div className="ofd-note">载入中…</div>
              )}
            </div>
            {readerBodyMode === "convert" && (isOfd ? (
              <ReaderOfdPanel file={file} refreshFiles={refreshFiles} />
            ) : (
              <ReaderConvertPanel file={file} target={convertTarget} onTargetChange={setConvertTarget} refreshFiles={refreshFiles} pageNum={pageNum} />
            ))}
          </>
        )}
      </div>

      {/* 固定底栏 */}
      <footer className="reader-statusbar">
        <span className="sb-file" title={file.name}>{file.name}</span>
        <span className="sb-dot">·</span>
        <span>已保存</span>
        {(docStatus || restored) && <span className="sb-note">{docStatus || ""}</span>}
        {viewRotate ? <span className="sb-note">视图旋转 {viewRotate}°</span> : null}
        {info?.encrypted && <span className="badge danger">已加密</span>}
        <span className="spacer" />
        {pageInvalid && <span className="sb-warn">页码需在 1–{total || "?"} 之间</span>}
        <button type="button" className="sb-btn" onClick={() => jump(pageNum - 1)} disabled={pageNum <= 1} aria-label="上一页">‹</button>
        <span className="sb-page">
          <span className="sb-lbl">第 </span><input aria-label="跳转页码" value={pageDraft} onChange={(e) => setPageDraft(e.target.value)}
                    onBlur={commitPageInput}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /><span className="sb-lbl"> 页</span>
          <span className="sb-total sb-lbl2">/ 共 {total || "?"} 页</span>
        </span>
        <button type="button" className="sb-btn" onClick={() => jump(pageNum + 1)} disabled={pageNum >= total} aria-label="下一页">›</button>
        <button type="button" className="sb-btn" onClick={() => setScale((s) => Math.max(0.3, (Math.ceil(Math.round(s * 100) / 10) - 1) / 10))} aria-label="缩小">−</button>
        <button type="button" className="sb-btn sb-zoom" onClick={() => {
          setScale(1);
          setJumpToken((n) => n + 1);
          if (scrollRef.current) {
            scrollRef.current.scrollLeft = 0;
            if (!continuous) scrollRef.current.scrollTop = 0;
          }
        }} title="恢复到 100%" aria-label={`当前 ${Math.round(scale * 100)}%，恢复到 100%`}>{Math.round(scale * 100)}%</button>
        <button type="button" className="sb-btn" onClick={() => setScale((s) => Math.min(4, (Math.floor(Math.round(s * 100) / 10) + 1) / 10))} aria-label="放大">＋</button>
        <button type="button" className="sb-btn sb-fit" onClick={() => {
          const box = scrollRef.current;
          if (!box || !doc) return;
          doc.getPage(pageNum).then((p) => {
            const v1 = p.getViewport({ scale: 1, rotation: (p.rotate + viewRotate) % 360 });
            setScale(+Math.min(3, (box.clientWidth - 48) / v1.width).toFixed(2));
          });
        }}>适应宽度</button>
        <button type="button" className="sb-btn sb-quiet" onClick={() => setContinuous((c) => !c)} aria-pressed={continuous} title="浏览模式">
          {continuous ? "连续" : "单页"}
        </button>
        <button type="button" className="sb-btn sb-quiet" onClick={() => setViewRotate((r) => (r + 90) % 360)} title="视图旋转（不影响文件）">⟳</button>
      </footer>

      {/* 全屏预览 / 放映覆盖层（v0.2）：复用当前 doc，退出时回到离开时的页 */}
      {immersive && doc && (
        <ImmersiveLayer doc={doc} fileTitle={file.name} pageNum={pageNum} mode={immersive}
                        initial={{ continuous, scale, viewRotate }} onExit={exitImmersive} />
      )}

      {printConfirm && (
        <div className="reader-password-backdrop">
          <div className="reader-password-dialog" role="dialog" aria-modal="true" aria-label="打印已保存版本">
            <h2>页面模式有未应用的变更</h2>
            <p className="reader-password-state">本次打印将使用已保存的原文件版本，未应用的整理变更不会进入打印内容。</p>
            <p className="reader-password-file" title={file.name}>{file.name}</p>
            <p className="note">如需打印整理后的页面，请先在页面模式「应用并另存为新 PDF」，再打印新文件。</p>
            <div className="reader-password-actions">
              <button type="button" className="btn" onClick={() => setPrintConfirm(false)}>取消</button>
              <button type="button" className="btn primary" autoFocus onClick={() => { setPrintConfirm(false); void doPrint(); }}>仍打印已保存版本</button>
            </div>
          </div>
        </div>
      )}

      {/* AI 识别目录 · 远程模型逐文档发送确认（同 AI 阅读规则，Figma 52/55） */}
      {tocConsent && (
        <div className="ai-consent-backdrop" role="dialog" aria-modal="true" aria-label="首次向远程模型发送此文档"
             onKeyDown={(e) => { if (e.key === "Escape") setTocConsent(null); }}>
          <div className="ai-consent">
            <h2>首次向远程模型发送此文档</h2>
            <p className="ai-consent-doc">{file.name} · 仅授权当前这一份</p>
            <div className="ai-consent-divider" />
            <div className="ai-consent-row">
              <span className="ai-consent-label">目标服务</span>
              <span className="ai-consent-value">{tocConsent.host} · {tocConsent.model}</span>
            </div>
            <div className="ai-consent-row">
              <span className="ai-consent-label">本次操作</span>
              <span className="ai-consent-value">AI 识别目录</span>
            </div>
            <span className="ai-consent-scope-title">拟发送内容</span>
            <div className="ai-consent-scope">
              <strong>{scopePageRanges(tocConsent.scope.pages)} · 约 {tocConsent.scope.characters.toLocaleString()} 字。</strong>
              <p>{tocConsent.scope.detail}</p>
              <p>不发送 PDF 原文件、页面图片或其他已打开文档。</p>
            </div>
            <p className="ai-consent-rule">切换文档后需重新确认；取消后继续在本机阅读。</p>
            <div className="ai-consent-actions">
              <button type="button" className="btn" autoFocus onClick={() => setTocConsent(null)}>取消，不发送</button>
              <button type="button" className="btn copper" onClick={() => {
                if (!file) return;
                tocConfirmedRef.current = `${file.id}:${tocConsent.cfg.id}`;
                const c = tocConsent;
                setTocConsent(null);
                void runAiToc(c.cfg);
              }}>确认发送本次内容</button>
            </div>
          </div>
        </div>
      )}

      {passwordPrompt && (
        <div className="reader-password-backdrop">
          <form className="reader-password-dialog" role="dialog" aria-modal="true" aria-label="输入 PDF 密码" onSubmit={submitPassword}>
            <h2>打开受保护 PDF</h2>
            <p className="reader-password-state">{passwordPrompt}</p>
            <p className="reader-password-file" title={file.name}>{file.name}</p>
            <label htmlFor="pdf-open-password">打开密码</label>
            <input id="pdf-open-password" className="input" type="password" autoFocus value={passwordValue}
                   onChange={(e) => setPasswordValue(e.target.value)} />
            <div className="reader-password-actions">
              <button type="button" className="btn" onClick={cancelPassword}>取消</button>
              <button type="submit" className="btn primary" disabled={!passwordValue}>{passwordPrompt.startsWith("密码不正确") ? "重新输入密码" : "打开 PDF"}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------------- 左栏（缩略图 / 目录 / 查找） ----------------

function SidePanel({
  file, tab, sideOpen, setSideOpen, narrow, overlay, doc, pageNum, jump, info, passwordProtected,
  query, setQuery, hits, searching, activeHit, setActiveHit, stepHit, scanned, runOcr,
  ocrTask, ocrDone, searchInputRef, appOcrAvailable, openOcrResult, cancelOcr, toc,
}: {
  file: FileEntry;
  tab: SideTab;
  sideOpen: boolean;
  setSideOpen: (v: boolean) => void;
  narrow: boolean;
  overlay: boolean;
  doc: PDFDoc | null;
  pageNum: number;
  jump: (p: number) => void;
  info: FileInfo | null;
  passwordProtected: boolean;
  query: string;
  setQuery: (q: string) => void;
  hits: SearchHit[] | null;
  searching: boolean;
  activeHit: number | null;
  setActiveHit: (i: number) => void;
  stepHit: (d: 1 | -1) => void;
  scanned: boolean;
  runOcr: () => void;
  ocrTask: { id: string; status: string; progress: number; progressKnown?: boolean; error?: string | null } | null;
  ocrDone: FileEntry | null;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  appOcrAvailable: boolean;
  openOcrResult: () => void;
  cancelOcr: () => void;
  toc?: AiTocState;
}) {
  const cls = "reader-side" + (tab === "search" ? " side-search" : "") + (overlay ? " side-overlay" : "");
  return (
    <aside className={cls} aria-label="文档侧栏">
      {narrow && (
        <div className="side-head">
          <button type="button" className="side-close" onClick={() => setSideOpen(false)} aria-label="收起侧栏">×</button>
        </div>
      )}
      <div className="side-body">
        {tab === "thumbs" && (
          <>
            <p className="side-current">当前位置 · 第 {pageNum || 1} 页</p>
            <div className="thumbs">
              {doc && Array.from({ length: doc.numPages }, (_, i) => i + 1).map((p) => (
                <button type="button" key={p} className={"th" + (p === pageNum ? " on" : "")} onClick={() => jump(p)}>
                  <div className="mini">{passwordProtected
                    ? <ProtectedThumb doc={doc} number={p} />
                    : <img src={`/api/files/${file.id}/thumb?page=${p}&dpi=${thumbDpi(p)}`} alt="" loading="lazy" />}</div>
                  <span className="no">{p}</span>
                </button>
              ))}
              {!doc && <div className="note">等待文档打开…</div>}
            </div>
          </>
        )}
        {tab === "bookmarks" && <OutlineTree nodes={info?.outline} onJump={jump} ai={toc} />}
        {tab === "search" && (
          <div className="search-view">
            <div className="search-row">
              <input className="input" ref={searchInputRef} value={query} placeholder="在文档中查找…"
                     onChange={(e) => setQuery(e.target.value)}
                     onKeyDown={(e) => {
                       if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); stepHit(1); }
                       if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); stepHit(-1); }
                       if (e.key === "Escape") { setQuery(""); setSideOpen(false); }
                     }} />
              {query && <button type="button" className="search-clear" aria-label="清除查找" onClick={() => { setQuery(""); searchInputRef.current?.focus(); }}>×</button>}
            </div>
            {query.trim() ? (
              <>
                <p className="search-count">
                  {searching ? "查找中…" : hits === null ? "" :
                    hits.length === 0 ? "0 处结果" : `共 ${hits.length} 处结果 · ${activeHit == null ? "选择结果定位" : `当前第 ${activeHit + 1} 处`}`}
                </p>
                {!searching && hits && hits.length > 0 && (
                  <div className="hit-list">
                    {hits.slice(0, 60).map((h, i) => (
                      <button type="button" key={i} className={"hit" + (activeHit === i ? " on" : "")}
                              onClick={() => { setActiveHit(i); jump(h.page); }}>
                        <span className="p">第 {h.page} 页 · {i + 1}/{hits.length}</span>
                        <span className="s">…{h.snippet}…</span>
                      </button>
                    ))}
                  </div>
                )}
                {!searching && hits && hits.length === 0 && (
                  scanned ? (
                    <div className="scan-guide">
                      <h3>这页是扫描图片</h3>
                      <p>{(info?.text_pages_sampled || 0) > 0 ? "当前页没有可查找的文字层。" : "当前 PDF 没有可查找的文字层。"}</p>
                      <p className="scan-guide-sub">先在本机识别文字，再查找或提取 TXT。原件保持不变。</p>
                      {ocrTask?.status === "submitting" || ocrTask?.status === "running" || ocrTask?.status === "cancelling" ? (
                        <div className="ocr-progress" role="status">
                          <strong>{ocrTask.status === "submitting" ? "正在提交识别任务…" : ocrTask.status === "cancelling" ? "正在取消识别…" : swordRunningText(ocrTask)}</strong>
                          {ocrTask.status !== "submitting" && (
                            <SwordProgress value={ocrTask.progress || 0} unknown={ocrTask.progressKnown === false} label={`文字识别 ${file.name}`} />
                          )}
                          {ocrTask.status === "running" && <button type="button" className="ocr-cancel" onClick={cancelOcr}>取消识别</button>}
                        </div>
                      ) : ocrTask?.status === "cancelled" ? (
                        <div className="ocr-progress"><strong>识别已取消</strong><button type="button" className="scan-btn" onClick={runOcr}>重新识别</button></div>
                      ) : ocrTask?.status === "error" ? (
                        <div className="ocr-progress error">
                          <strong>识别失败</strong>
                          <p>{ocrTask.error}</p>
                          <button type="button" className="scan-btn" onClick={runOcr}>重试识别</button>
                        </div>
                      ) : ocrDone ? (
                        <div className="ocr-progress done">
                          <strong>识别完成</strong>
                          <p>可搜索副本已生成，原 PDF 保留。</p>
                          <button type="button" className="scan-btn" onClick={openOcrResult}>打开可搜索副本 →</button>
                        </div>
                      ) : (
                        <button type="button" className="scan-btn" disabled={!appOcrAvailable}
                                onClick={runOcr}>识别当前页 →</button>
                      )}
                      {!appOcrAvailable && <p className="note">文字识别未安装；可在设置的「文字识别」选择档位。</p>}
                    </div>
                  ) : (
                    <div className="scan-guide plain">
                      <p>全部页面都没有「{query.trim()}」。</p>
                      <p className="scan-guide-sub">换个词，或检查是否包含空格。</p>
                    </div>
                  )
                )}
                {hits && hits.length > 0 && <p className="search-kbd">Enter 下一处 · Shift+Enter 上一处</p>}
              </>
            ) : (
              <p className="search-count">输入文字后在全部页面中查找；结果可定位并高亮。</p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function thumbDpi(page: number): number {
  return page <= 200 ? 26 : 20;
}

function ProtectedThumb({ doc, number }: { doc: PDFDoc; number: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    const render = async () => {
      try {
        const page = await doc.getPage(number);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 0.18 });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) return;
        renderTask = page.render({ canvas, canvasContext: context, viewport });
        await renderTask.promise;
      } catch {
        // A closed document cancels outstanding thumbnail renders.
      }
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void render();
      }
    }, { rootMargin: "160px" });
    observer.observe(canvas);
    return () => { cancelled = true; observer.disconnect(); renderTask?.cancel(); };
  }, [doc, number]);
  return <canvas ref={canvasRef} aria-hidden="true" />;
}

// ---------------- 选区弹层 ----------------

function SelectionPopup({ popup, onCopy, onAi, onClose }: {
  popup: { text: string; page: number; x: number; y: number };
  onCopy: () => void; onAi: (a: "explain" | "translate") => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    addEventListener("keydown", onKey);
    setTimeout(() => addEventListener("mousedown", onDown), 0);
    return () => { removeEventListener("keydown", onKey); removeEventListener("mousedown", onDown); };
  }, [onClose]);
  return (
    <div className="sel-popup" ref={ref} role="toolbar" aria-label="选区操作"
         style={{ left: popup.x, top: popup.y }}>
      <span className="sel-preview">{popup.text.slice(0, 40)}{popup.text.length > 40 ? "…" : ""}</span>
      <button type="button" onClick={onCopy}>复制</button>
      <button type="button" onClick={() => onAi("explain")}>AI 解释</button>
      <button type="button" onClick={() => onAi("translate")}>AI 翻译</button>
    </div>
  );
}
