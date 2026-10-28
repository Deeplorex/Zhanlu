import React, { useEffect, useMemo, useRef, useState } from "react";
import { AppCtx } from "../../app/AppContext";
import { cancelTask, get, jobsRun, post, uploadFiles, waitTask } from "../../shared/api";
import Markdown from "../../shared/Markdown";
import { pickPdfsNative } from "../../shared/nativeOpen";
import SwordProgress, { swordRunningText } from "../../shared/SwordProgress";
import type { AiConfig, AiSource, FileEntry, LocalAiStatus, SelectionPayload } from "../../shared/types";

type Action = "summary" | "ask" | "explain" | "translate";

interface Msg {
  role: "user" | "assistant";
  text: string;
  sources?: AiSource[];
  note?: string;
  error?: boolean;
}

interface SendingScope {
  pages: number[];
  total_pages: number;
  text_pages: number;
  characters: number;
  detail: string;
}

function pageRanges(pages: number[]): string {
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

function actionLabel(action: Action, preset?: string): string {
  if (action === "summary") return "总结全文";
  if (action === "explain") return "解释选区";
  if (action === "translate") return "翻译选区";
  const q = (preset || "").trim();
  return q ? (q.length > 18 ? `${q.slice(0, 18)}…` : q) : "提问";
}

/**
 * AI Chat：当前 PDF 的右侧非模态浮层（Figma 62/64）。
 * 由阅读工具栏「AI 阅读」与右下湛卢气泡两个入口共用；不占模式位、不压缩 PDF、不建任务标签。
 * 关闭/切文档保留草稿与历史；来源点击切回阅读并定位原页；远程模型逐文档确认后才发送。
 */
export default function AiChat({ home }: { home?: boolean }) {
  const {
    current: file, aiOpen, setAiOpen, aiGuideOpen, setAiGuideOpen, aiTriggerRef, gotoPage,
    selection, setSelection, toast, files, openFile, refreshFiles, readerView, saveReaderView,
  } = React.useContext(AppCtx);
  // 首页始终是选文件引导；阅读工作区跟随当前 PDF 的会话
  const open = home || !file ? aiGuideOpen : aiOpen;
  const guide = home || !file;

  const [configs, setConfigs] = useState<AiConfig[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [prefer, setPrefer] = useState<"cloud" | "local">("cloud");
  const [localAi, setLocalAi] = useState<LocalAiStatus | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelLoadError, setModelLoadError] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [depth, setDepth] = useState<StrengthId>("high");
  const [question, setQuestion] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressKnown, setProgressKnown] = useState(true);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [remoteConfirmedFor, setRemoteConfirmedFor] = useState<string | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ action: Action; payload: string; scope: SendingScope } | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);
  /** 输入区的组合入口菜单（模型 + 思考强度同面板，Figma 78–81） */
  const [menu, setMenu] = useState(false);
  const combinedTriggerRef = useRef<HTMLButtonElement>(null);
  const guideInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const isLocalCfg = (c: AiConfig) => {
    try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(c.baseurl).hostname.toLowerCase()); }
    catch { return false; }
  };

  useEffect(() => {
    if (!open || !file) return;
    Promise.all([
      get<{ configs: AiConfig[]; prefer?: "cloud" | "local" }>("/api/ai/configs"),
      get<{ active: string | null }>("/api/ai/active"),
      get<LocalAiStatus>("/api/ai/local"),
    ]).then(([a, b, local]) => {
      setConfigs(a.configs || []);
      setActive(b.active);
      setPrefer(a.prefer === "local" ? "local" : "cloud");
      setLocalAi(local);
    }).catch(() => setModelLoadError(true)).finally(() => setModelsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 切换 PDF 后跟随新文档会话；迟到的旧文档结果不得写入（fileIdRef 守卫）
  const fileIdRef = useRef<string | null>(null);
  const documentEpoch = useRef(0);
  useEffect(() => {
    documentEpoch.current += 1;
    fileIdRef.current = file?.id || null;
    setMsgs([]); setRemoteConfirmedFor(null); setQuestion(""); setPendingConfirm(null);
    setBusy(false); setSubmitted(false); setActiveTaskId(null); setCancelling(false); setScopeLoading(false);
  }, [file?.id]);

  const configured = useMemo(() => configs.filter((c) => {
    if (typeof c.id !== "string" || !c.id.trim() || typeof c.model !== "string" || !c.model.trim()
        || !["ollama", "openai", "openai-responses", "anthropic"].includes(c.protocol)) return false;
    try {
      const url = new URL(c.baseurl);
      if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return false;
      return isLocalCfg(c) || (url.protocol === "https:" && !!c.has_key);
    } catch { return false; }
  }), [configs]);
  const localVariants = useMemo(() => configured.filter(isLocalCfg)
    .sort((a, b) => Number(b.id === active) - Number(a.id === active))
    .flatMap((config) => {
      if (!localAi?.running) return [];
      const endpoint = new URL(config.baseurl);
      const api = new URL(localAi.api);
      if (endpoint.protocol !== api.protocol || endpoint.port !== api.port
          || endpoint.pathname.replace(/\/$/, "") !== api.pathname.replace(/\/$/, "")) return [];
      return localAi.models.filter((model) => !!model.name.trim()).map((model) => ({
        value: model.name === config.model ? config.id : `local:${config.id}:${model.name}`,
        configId: config.id, model: model.name, label: `本地 · ${model.name}`, local: true,
      }));
    }).filter((v, i, all) => all.findIndex((x) => x.model === v.model) === i), [configured, localAi, active]);
  const remoteVariants = useMemo(() => configured.filter((c) => !isLocalCfg(c))
    .map((c) => ({ value: c.id, configId: c.id, model: c.model, label: `远程 · ${c.name || c.model}`, local: false })), [configured]);
  const selectedVariant = useMemo(() => {
    const variants = [...localVariants, ...remoteVariants];
    return variants.find((x) => x.value === selectedModelId)
      || variants.find((x) => x.configId === active)
      || variants.find((x) => x.local === (prefer === "local"))
      || variants[0] || null;
  }, [localVariants, remoteVariants, selectedModelId, active, prefer]);
  const cfg = configs.find((c) => c.id === selectedVariant?.configId) || null;
  const modelLabel = selectedVariant?.label || null;

  /** 思考强度按模型适配：本地已安装模型提供 低/高，远程提供 低/高/最高；当前档不被支持时回落到「高」 */
  const strengthLevels = selectedVariant && !selectedVariant.local ? STRENGTH_LEVELS : STRENGTH_LEVELS.slice(0, 2);
  useEffect(() => { if (!strengthLevels.some((l) => l.id === depth)) setDepth("high"); }, [strengthLevels, depth]);

  const isLocal = cfg ? isLocalCfg(cfg) : true;
  const remoteConfirmed = !!cfg && !!file && remoteConfirmedFor === `${file.id}:${cfg.id}`;
  const connected = isLocal ? !!localAi?.running : true;
  const modelOverride = selectedVariant && selectedVariant.model !== cfg?.model ? selectedVariant.model : undefined;

  const pageNum = (file && readerView[file.id]?.page) || 1;

  const send = async (action: Action, presetText?: string) => {
    if (!file) return;
    if (!cfg) { toast("请先在设置中连接模型", true); return; }
    const text = action === "ask" ? (presetText ?? question) : action === "summary" ? "" : (selection?.text || "");
    if (action === "ask" && !text.trim()) return;
    if ((action === "explain" || action === "translate") && !text.trim()) { toast("请先在原文中选中文字", true); return; }
    // 远程模型逐文档确认（Figma 52/55，布局沿用本轮 Chat）
    if (!isLocal && !remoteConfirmed) {
      const boundId = file.id;
      const epoch = documentEpoch.current;
      setScopeLoading(true);
      try {
        const scope = await post<SendingScope>("/api/ai/scope", {
          id: file.id, action,
          question: action === "ask" ? text : "",
          selection: action === "explain" || action === "translate" ? text : "",
          selection_page: selection?.fileId === file.id ? selection.page : pageNum,
        });
        if (fileIdRef.current === boundId && documentEpoch.current === epoch) setPendingConfirm({ action, payload: text, scope });
      } catch (e) {
        if (fileIdRef.current !== boundId || documentEpoch.current !== epoch) return;
        const message = (e as Error).message;
        if (/请先完成 OCR|没有可提取的文字/.test(message)) {
          // 与任务失败同格式落进聊天：错误下方的「去 OCR」按钮引导到本机识别
          setMsgs((m) => [...m.slice(-8), { role: "user", text: action === "summary" ? "总结全文" : "提问" },
            { role: "assistant", text: `处理失败：${message}`, error: true }]);
        } else {
          toast(`无法核对发送范围：${message}`, true);
        }
      } finally {
        if (fileIdRef.current === boundId && documentEpoch.current === epoch) setScopeLoading(false);
      }
      return;
    }
    await runAi(action, text);
  };

  const runAi = async (action: Action, payload?: string) => {
    if (!file || !cfg) return;
    const boundId = file.id;
    const epoch = documentEpoch.current;
    const text = payload ?? (action === "ask" ? question : action === "summary" ? "" : (selection?.text || ""));
    const userLabel = action === "summary" ? "总结全文"
      : action === "ask" ? text.trim()
      : action === "explain" ? `解释选区：${text.trim().slice(0, 24)}…`
      : `翻译选区：${text.trim().slice(0, 24)}…`;
    setMsgs((m) => [...m.slice(-8), { role: "user", text: userLabel }]);
    setQuestion("");
    setBusy(true); setSubmitted(false); setProgress(0); setProgressKnown(true); setActiveTaskId(null); setCancelling(false);
    try {
      const started = await jobsRun("ai_analyze", {
        id: file.id, action,
        config_id: cfg.id, model_override: modelOverride, depth,
        question: action === "ask" ? text : "",
        selection: action !== "ask" && action !== "summary" ? text : "",
        selection_page: action !== "ask" && action !== "summary" ? (selection?.fileId === file.id ? selection.page : pageNum) : undefined,
        allow_remote: !isLocal,
      });
      if (fileIdRef.current !== boundId || documentEpoch.current !== epoch) return;
      setActiveTaskId(started.id);
      setSubmitted(true);
      const done = await waitTask(started.id, { timeout: 1_800_000, onTick: (t) => {
        if (fileIdRef.current === boundId && documentEpoch.current === epoch) {
          setProgress(t.progress); setProgressKnown(t.progressKnown !== false);
        }
      } });
      if (fileIdRef.current !== boundId || documentEpoch.current !== epoch) return; // 请求绑定原文档会话
      const r = done.result as { answer?: string; sources?: AiSource[]; text_pages?: number; total_pages?: number } | null;
      setMsgs((m) => [...m, {
        role: "assistant",
        text: r?.answer || "（没有返回内容）",
        sources: r?.sources || [],
        note: r?.total_pages != null ? `已读取 ${r.text_pages ?? "?"}/${r.total_pages} 页 · ${modelLabel || ""} · ${strengthName(depth)}` : undefined,
      }]);
    } catch (e) {
      if (fileIdRef.current !== boundId || documentEpoch.current !== epoch) return;
      const message = (e as Error).message;
      setMsgs((m) => [...m, message === "已取消"
        ? { role: "assistant", text: "已取消本次分析。" }
        : { role: "assistant", text: `处理失败：${message}`, error: true }]);
    } finally {
      if (fileIdRef.current === boundId && documentEpoch.current === epoch) {
        setBusy(false);
        setSubmitted(false);
        setActiveTaskId(null);
        setCancelling(false);
        if (selection) setSelection((current) => current === selection ? null : current);
      }
    }
  };

  const cancelCurrent = async () => {
    if (!activeTaskId || cancelling) return;
    setCancelling(true);
    try { await cancelTask(activeTaskId); }
    catch (e) { setCancelling(false); toast(`取消失败：${(e as Error).message}`, true); }
  };

  // 模型配置就绪后执行本次选区操作；新选区不被上一次任务的清理覆盖。
  const actedRef = useRef<SelectionPayload | null>(null);
  useEffect(() => {
    if (!selection) { actedRef.current = null; return; }
    if (!file || modelsLoading || !cfg || busy || scopeLoading || pendingConfirm) return;
    if (selection.fileId === file.id && selection.text.trim() && selection.action && actedRef.current !== selection) {
      actedRef.current = selection;
      void send(selection.action);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, file?.id, modelsLoading, cfg, busy, scopeLoading, pendingConfirm]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs, busy]);

  // 打开后焦点进入提问区（非模态：不锁定整页焦点）；关闭回到本次触发入口
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      if (file && !guide && inputRef.current && !inputRef.current.disabled) inputRef.current.focus();
      else panelRef.current?.focus();
    }, 40);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file?.id, guide]);

  const close = () => {
    setAiOpen(false);
    setAiGuideOpen(false);
    const trigger = aiTriggerRef.current;
    aiTriggerRef.current = null;
    if (trigger?.isConnected) setTimeout(() => trigger.focus(), 0);
    else if (file) inputRef.current?.blur();
  };

  useEffect(() => {
    if (!open || menu || pendingConfirm) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      if (document.querySelector('[role="dialog"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // The close operation uses the current document and trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, menu, pendingConfirm, file?.id]);

  const hasSelection = !!(file && selection && selection.fileId === file.id && selection.text);
  const emptyModelLabel = modelsLoading ? "正在读取模型配置…" : modelLoadError ? "无法读取模型配置" : "暂无已配置模型";
  const canSend = !!file && !!cfg && !busy && !scopeLoading && !!question.trim();

  /** 引导中打开 PDF：激活/建立该文件标签并直接进入它的 Chat */
  const openIntoChat = (entry: FileEntry) => {
    saveReaderView(entry.id, { aiOpen: true });
    openFile(entry);
  };

  const openFromGuide = async (list: File[]) => {
    const pdfs = list.filter((f) => /\.pdf$/i.test(f.name));
    if (!pdfs.length) return;
    setGuideBusy(true);
    try {
      const r = await uploadFiles(pdfs);
      await refreshFiles();
      const first = r.files.find((f) => f.kind === "pdf");
      if (first) { setAiGuideOpen(false); openIntoChat(first); }
    } catch (e) {
      toast(`打开失败：${(e as Error).message}`, true);
    } finally { setGuideBusy(false); }
  };

  // 桌面优先走原生选择：引擎登记真实路径（与源文件同目录可用）；旧引擎回退网页选择
  const openFromGuideNative = async () => {
    if (guideBusy) return;
    setGuideBusy(true);
    try {
      const r = await pickPdfsNative();
      if (r === null) { guideInputRef.current?.click(); return; }
      if (r.cancelled) return;
      await refreshFiles();
      const first = r.files.find((f) => f.kind === "pdf");
      if (first) { setAiGuideOpen(false); openIntoChat(first); }
      if (r.errors.length) toast(`部分文件未能打开：${r.errors[0]}`, true);
    } catch (e) {
      toast(`打开失败：${(e as Error).message}`, true);
    } finally { setGuideBusy(false); }
  };

  const recentPdfs = files.filter((f) => f.kind === "pdf")
    .filter((f, i, arr) => arr.findIndex((x) => x.name === f.name) === i).slice(0, 4);

  return (
    <aside className="ai-chat" ref={panelRef} tabIndex={-1} role="complementary"
           aria-label="AI 阅读" hidden={!open}
           onKeyDown={(e) => { if (e.key === "Escape" && !pendingConfirm && !menu) { e.stopPropagation(); close(); } }}>
      <div className="ai-chat-head">
        <img className="ai-chat-mark" src="./brand/mark.svg" alt="" width={24} height={24} />
        <h2>AI 阅读</h2>
        <button type="button" className="ai-chat-close" aria-label="关闭 AI Chat" title="关闭（Esc）" onClick={close}>×</button>
      </div>
      {file && !guide ? (<>
        <p className="ai-chat-doc">当前文档 · {file.name}</p>
        <p className={"ai-chat-status " + (!cfg ? "warn" : isLocal ? (connected ? "ok" : "warn") : remoteConfirmed ? "ok" : "warn")}>
          <i aria-hidden="true" /> {cfg ? <>{isLocal ? "本地模型" : "远程模型"} · {modelLabel?.replace(/^本地 · |^远程 · /, "")} · {isLocal ? (connected ? "文档不上传" : "未就绪") : remoteConfirmed ? "发送范围已确认" : "待确认发送范围"}</> : emptyModelLabel}
        </p>
        <div className="ai-chat-quick">
          <button type="button" disabled={busy || scopeLoading || !cfg} onClick={() => void send("summary")}>总结全文</button>
          <button type="button" disabled={busy || scopeLoading || !cfg} onClick={() => void send("ask", "提炼本文要点与待办")}>提炼要点</button>
          <button type="button" disabled={busy || scopeLoading || !cfg || !hasSelection} title={hasSelection ? "" : "先在原文中选中文字"}
                  onClick={() => void send("explain")}>解释选区</button>
        </div>

        <div className="ai-chat-msgs" ref={listRef} aria-live="polite">
          {!cfg && !busy ? (
            <div className="ai-chat-empty">
              <p>{modelsLoading ? "正在检查已保存的连接和本地模型。" : modelLoadError ? "请前往设置检查模型连接后重试。" : "先在设置中配置远程模型，或安装本地模型。"}</p>
              {!modelsLoading && <button type="button" onClick={() => (location.hash = "#/settings")}>前往设置</button>}
            </div>
          ) : msgs.length === 0 && !busy && (
            <div className="ai-chat-empty">
              <p>针对当前文档提问；回答附来源页，</p>
              <p>点击来源可返回原文核对。</p>
            </div>
          )}
          {msgs.map((m, i) => m.role === "user" ? (
            <div className="ai-bubble-user" key={i}>{m.text}</div>
          ) : (
            <div className={"ai-answer" + (m.error ? " err" : "")} key={i}>
              <div className="ai-answer-text"><Markdown>{m.text}</Markdown></div>
              {m.error && /请先完成 OCR|没有可提取的文字/.test(m.text) && (
                <div className="ai-answer-actions">
                  <button type="button" className="ai-ocr-action"
                          onClick={() => window.dispatchEvent(new CustomEvent("zhanlu:ocr-current"))}>
                    去 OCR · 本机识别扫描页
                  </button>
                  <span className="ai-answer-note">识别生成可搜索副本后，回到这里重新发起本次分析。</span>
                </div>
              )}
              {m.sources && m.sources.length > 0 && (
                <div className="ai-source-row">
                  {m.sources.slice(0, 3).map((s, k) => (
                    <button type="button" key={k} className="ai-source-chip" title={s.excerpt}
                            onClick={() => gotoPage(s.page)}>来源 · 第 {s.page} 页 ↗</button>
                  ))}
                  <span className="ai-source-hint">点击来源，回到原文核对</span>
                </div>
              )}
              {m.note && <p className="ai-answer-note">{m.note}</p>}
            </div>
          ))}
          {busy && (
            <div className="ai-side-busy" role="status">
              <strong>{cancelling ? "正在取消分析…" : submitted ? swordRunningText({ progress, progressKnown }) : "正在提交分析任务…"}</strong>
              {submitted && <SwordProgress value={progress} label={`AI 分析 ${file?.name || ""}`} />}
              {activeTaskId && <button type="button" className="ai-cancel" disabled={cancelling} onClick={() => void cancelCurrent()}>{cancelling ? "正在取消…" : "停止本次分析"}</button>}
            </div>
          )}
        </div>

        <div className="ai-chat-input">
          <textarea className="ai-input" ref={inputRef} placeholder="向这份文档提问…" rows={2} value={question} disabled={!cfg}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) void send("ask"); } }} />
          <div className="ai-input-row">
            <span className="ai-input-spacer" aria-hidden="true" />
            <button type="button" ref={combinedTriggerRef} className={"chat-combined" + (menu ? " open" : "")}
                    aria-haspopup="menu" aria-expanded={menu}
                    aria-label={selectedVariant
                      ? `模型 ${selectedVariant.label}，思考强度 ${strengthName(depth)}，打开模型与强度选择`
                      : `${emptyModelLabel}，打开模型选择`}
                    title={selectedVariant ? `${selectedVariant.label} · ${strengthName(depth)}` : emptyModelLabel}
                    disabled={busy || scopeLoading}
                    onClick={() => setMenu((v) => !v)}>
              <span className="chat-combined-model">{selectedVariant?.model || emptyModelLabel}</span>
              <span className="chat-combined-depth">{strengthName(depth)}</span>
              <CaretIcon up={menu} />
            </button>
            <button type="button" className="ai-send" aria-label="发送" title="发送（Enter）"
                    disabled={!canSend} onClick={() => void send("ask")}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {menu && (
              <CombinedModelMenu
                variants={[...localVariants, ...remoteVariants]}
                selectedValue={selectedVariant?.value}
                depth={depth}
                levels={strengthLevels}
                disabled={busy || scopeLoading}
                modelsLoading={modelsLoading}
                modelLoadError={modelLoadError}
                triggerRef={combinedTriggerRef}
                onClose={() => setMenu(false)}
                onSelectModel={(v) => { setSelectedModelId(v); setRemoteConfirmedFor(null); setMenu(false); setTimeout(() => combinedTriggerRef.current?.focus(), 0); }}
                onChangeDepth={(d) => setDepth(d)}
              />
            )}
          </div>
        </div>

        {pendingConfirm && (
          <div className="ai-consent-veil" role="dialog" aria-modal="true" aria-label="首次向远程模型发送此文档"
               onKeyDown={(e) => { if (e.key === "Escape") setPendingConfirm(null); }}>
            <div className="ai-consent">
              <h2>首次向远程模型发送此文档</h2>
              <p className="ai-consent-doc">{file.name} · 仅授权当前这一份</p>
              <div className="ai-consent-divider" />
              <div className="ai-consent-row">
                <span className="ai-consent-label">目标服务</span>
                <span className="ai-consent-value">{safeHost(cfg?.baseurl)} · {modelLabel?.replace(/^远程 · /, "") || cfg?.model}</span>
              </div>
              <div className="ai-consent-row">
                <span className="ai-consent-label">本次操作</span>
                <span className="ai-consent-value">{actionLabel(pendingConfirm.action, pendingConfirm.payload)}</span>
              </div>
              <span className="ai-consent-scope-title">拟发送内容</span>
              <div className="ai-consent-scope">
                <strong>{pageRanges(pendingConfirm.scope.pages)} · 约 {pendingConfirm.scope.characters.toLocaleString()} 字。</strong>
                <p>{pendingConfirm.scope.detail}</p>
                <p>不发送 PDF 原文件、页面图片或其他已打开文档。</p>
              </div>
              <p className="ai-consent-rule">切换文档后需重新确认；取消后继续在本机阅读。</p>
              <div className="ai-consent-actions">
                <button type="button" className="btn" autoFocus onClick={() => setPendingConfirm(null)}>取消，不发送</button>
                <button type="button" className="btn copper" onClick={() => {
                  if (!cfg || !file) return;
                  setRemoteConfirmedFor(`${file.id}:${cfg.id}`);
                  const p = pendingConfirm;
                  setPendingConfirm(null);
                  void runAi(p.action, p.payload);
                }}>确认发送本次内容</button>
              </div>
            </div>
          </div>
        )}
      </>) : (
        <div className="ai-chat-guide">
          <p className="ai-chat-guide-lead">AI 阅读围绕当前 PDF 工作：总结、问答与选区解释的答案都附来源页。</p>
          <p className="ai-chat-guide-sub">先选择一份 PDF；已打开的文件会回到原标签。</p>
          <label className={"ai-guide-pick" + (guideBusy ? " busy" : "")}
                 onClick={(e) => { e.preventDefault(); void openFromGuideNative(); }}>
            {guideBusy ? "正在打开…" : "选择 PDF 开始 AI 阅读"}
            <input ref={guideInputRef} type="file" hidden accept=".pdf"
                   onClick={(e) => e.stopPropagation()}
                   onChange={(e) => { void openFromGuide(Array.from(e.target.files || [])); e.target.value = ""; }} />
          </label>
          {recentPdfs.length > 0 && (
            <div className="ai-guide-recent">
              <small>或从最近文件选择：</small>
              {recentPdfs.map((f) => (
                <button type="button" key={f.id} title={f.name}
                        onClick={() => { setAiGuideOpen(false); openIntoChat(f); }}>{f.name}</button>
              ))}
            </div>
          )}
          <p className="ai-chat-guide-note">不扩展为通用聊天；远程连接仍按逐文档确认后发送。</p>
        </div>
      )}
    </aside>
  );
}

function safeHost(url?: string): string {
  try { return new URL(url || "").host; } catch { return "远程服务"; }
}

/** 触发器右侧 12×12 展开指示；菜单向上展开时箭头朝上 */
function CaretIcon({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {up ? <path d="m5 15 7-7 7 7" /> : <path d="m5 9 7 7 7-7" />}
    </svg>
  );
}

/** 思考强度离散档位（引擎 low/high/max）：低/高/最高；按模型能力裁剪可用档位 */
type StrengthId = "low" | "high" | "max";
const STRENGTH_LEVELS: { id: StrengthId; name: string }[] = [
  { id: "low", name: "低" },
  { id: "high", name: "高" },
  { id: "max", name: "最高" },
];
const strengthName = (id: StrengthId) => STRENGTH_LEVELS.find((l) => l.id === id)?.name || "高";

/**
 * 模型与思考强度合并菜单（Figma 79/81 · 20261026/Combined model menu）。
 * 上半部安全配置模型列表（勾选 + 本地/远程标记），下半部离散强度滑轨（按模型裁剪档位）；
 * 选模型提交并关闭菜单，调强度保持打开；Esc/外部点击收起并保留已提交选择。
 */
function CombinedModelMenu({ variants, selectedValue, depth, levels, disabled, modelsLoading, modelLoadError, triggerRef, onClose, onSelectModel, onChangeDepth }: {
  variants: { value: string; model: string; label: string; local: boolean }[];
  selectedValue?: string;
  depth: StrengthId;
  levels: { id: StrengthId; name: string }[];
  disabled: boolean;
  modelsLoading: boolean;
  modelLoadError: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSelectModel: (value: string) => void;
  onChangeDepth: (depth: StrengthId) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const committedIdx = Math.max(0, levels.findIndex((l) => l.id === depth));
  const [pendingIdx, setPendingIdx] = useState<number | null>(null);
  const shownIdx = pendingIdx ?? committedIdx;
  const dragging = useRef(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      onClose();
    };
    setTimeout(() => addEventListener("mousedown", onDown), 0);
    return () => removeEventListener("mousedown", onDown);
  }, [onClose, triggerRef]);

  // 打开后焦点进入模型列表（或空态配置入口）；方向键循环、Enter 选择
  useEffect(() => {
    const t = setTimeout(() => {
      const items = rootRef.current?.querySelectorAll<HTMLElement>(".chat-option, .chat-menu-empty button");
      const sel = rootRef.current?.querySelector<HTMLElement>(".chat-option.on");
      (sel || items?.[0])?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, []);

  const closeToTrigger = () => {
    onClose();
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); closeToTrigger(); return; }
    const root = rootRef.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>(".chat-option, .chat-menu-empty button")];
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown"
        ? items[(idx + 1 + items.length) % items.length]
        : items[(idx - 1 + items.length) % items.length];
      next.focus();
    }
  };

  const snapFromClientX = (clientX: number) => {
    const track = rootRef.current?.querySelector<HTMLElement>(".strength-track");
    if (!track) return committedIdx;
    const r = track.getBoundingClientRect();
    const ratio = (clientX - r.left) / Math.max(1, r.width);
    return Math.round(Math.min(1, Math.max(0, ratio)) * (levels.length - 1));
  };

  const onSliderKey = (e: React.KeyboardEvent) => {
    const last = levels.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(last, shownIdx + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, shownIdx - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next != null) { e.preventDefault(); setPendingIdx(next); return; }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (pendingIdx != null) { onChangeDepth(levels[pendingIdx].id); setPendingIdx(null); }
      return;
    }
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setPendingIdx(null); closeToTrigger(); }
  };

  return (
    <div className="chat-menu combined" ref={rootRef} role="group" aria-label="模型与思考强度选择" onKeyDown={onKey}>
      <div className="chat-menu-head"><span className="chat-menu-title">模型</span></div>
      <div className="chat-menu-options" role="listbox" aria-label="安全配置的模型">
        {variants.length === 0 ? (
          <div className="chat-menu-empty">
            <p>{modelsLoading ? "正在读取模型配置…" : modelLoadError ? "无法读取模型配置，请前往设置检查。" : "暂无已安全配置的模型。"}</p>
            {!modelsLoading && <button type="button" className="chat-menu-link strong" onClick={() => (location.hash = "#/settings")}>配置模型 →</button>}
          </div>
        ) : variants.map((v) => (
          <button type="button" key={v.value} role="option" aria-selected={v.value === selectedValue}
                  className={"chat-option" + (v.value === selectedValue ? " on" : "")}
                  title={`模型全名 · ${v.label}`}
                  onClick={() => onSelectModel(v.value)}>
            <span className="chat-option-name">{v.model}</span>
            <span className="chat-option-loc">{v.local ? "本地" : "远程"}</span>
            {v.value === selectedValue && <span className="chat-option-check" aria-label="当前已选">✓</span>}
          </button>
        ))}
      </div>
      <div className="chat-menu-divider" aria-hidden="true" />
      <div className="strength-head">
        <span className="chat-menu-title">思考强度</span>
        <span className="strength-now">{levels[shownIdx].name}</span>
      </div>
      <div className="strength-slider" role="slider" tabIndex={disabled ? -1 : 0}
           aria-label="思考强度" aria-disabled={disabled}
           aria-valuemin={1} aria-valuemax={levels.length}
           aria-valuenow={shownIdx + 1}
           aria-valuetext={`${levels[shownIdx].name}（共 ${levels.length} 档）`}
           onKeyDown={disabled ? undefined : onSliderKey}
           onPointerDown={disabled ? undefined : (e) => {
             dragging.current = true;
             try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 合成/失效指针不阻断拖动 */ }
             setPendingIdx(snapFromClientX(e.clientX));
           }}
           onPointerMove={(e) => { if (dragging.current) setPendingIdx(snapFromClientX(e.clientX)); }}
           onPointerUp={(e) => {
             if (!dragging.current) return;
             dragging.current = false;
             const snapped = snapFromClientX(e.clientX);
             setPendingIdx(null);
             onChangeDepth(levels[snapped].id);
           }}>
        <div className="strength-track" aria-hidden="true">
          <i className="strength-fill" style={{ width: `max(8px, ${(shownIdx / (levels.length - 1)) * 100}%)` }} />
          <span className="strength-thumb" style={{ left: `${(shownIdx / (levels.length - 1)) * 100}%` }} />
        </div>
        <div className="strength-labels" aria-hidden="true">
          {levels.map((l) => <span key={l.id}>{l.name}</span>)}
        </div>
      </div>
      <p className="chat-menu-foot"><span>仅显示已配置模型 · 远程发送前确认范围</span></p>
    </div>
  );
}
