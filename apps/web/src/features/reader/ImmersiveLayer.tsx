import React, { useCallback, useEffect, useRef, useState } from "react";
import type * as pdfjs from "pdfjs-dist";
import { ContinuousPages, PageView } from "./PageViews";

type PDFDoc = pdfjs.PDFDocumentProxy;

export type ImmersiveMode = "read" | "slideshow";

const AUTOPLAY_OPTS = [
  { v: 0, label: "自动播放 · 关" },
  { v: 5, label: "每 5 秒" },
  { v: 10, label: "每 10 秒" },
  { v: 15, label: "每 15 秒" },
];

/**
 * 全屏预览 / 放映（v0.2 M2）：fixed 覆盖层复用当前 doc，不新增路由、不重载文档。
 * read = 沉浸阅读（保留连续/单页与缩放，悬浮控制鼠标静止后隐藏）；
 * slideshow = 放映（墨黑底单页 contain 居中、键盘/滚轮翻页、可选自动播放）。
 * 进入时请求系统全屏，退出（Esc / fullscreenchange）同步关闭并回调当前页。
 */
export default function ImmersiveLayer({ doc, fileTitle, pageNum, mode, initial, onExit }: {
  doc: PDFDoc;
  fileTitle: string;
  pageNum: number;
  mode: ImmersiveMode;
  initial: { continuous: boolean; scale: number; viewRotate: number };
  onExit: (page: number) => void;
}) {
  const [page, setPage] = useState(pageNum);
  const [continuous, setContinuous] = useState(mode === "read" ? initial.continuous : false);
  const [scale, setScale] = useState(initial.scale);
  const [viewRotate] = useState(initial.viewRotate);
  const [jumpToken, setJumpToken] = useState(0);
  const [chrome, setChrome] = useState(true);
  const [autoplay, setAutoplay] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const [resizeTick, setResizeTick] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef(0);
  const wheelAt = useRef(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const goto = useCallback((p: number) => {
    const n = Math.min(doc.numPages, Math.max(1, p));
    setPage(n);
    setJumpToken((x) => x + 1);
  }, [doc]);

  const wake = useCallback(() => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 2600);
  }, []);

  // 进入即请求系统全屏；退出全屏（含 Esc 的浏览器行为）→ 关闭覆盖层并回到 Reader
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
    wake();
    rootRef.current?.requestFullscreen?.().catch(() => { /* 拒绝时保持覆盖层全屏即可 */ });
    const onFsChange = () => { if (!document.fullscreenElement) onExitRef.current(pageRef.current); };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      window.clearTimeout(hideTimer.current);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, [wake]);

  // 键盘：Esc 退出；放映模式 ←→/空格/PageUp/PageDown/Home/End 翻页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        // 系统全屏时交给浏览器退出全屏，fullscreenchange 统一收口
        if (!document.fullscreenElement) onExitRef.current(pageRef.current);
        return;
      }
      if (mode !== "slideshow") return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        goto(pageRef.current + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goto(pageRef.current - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        goto(1);
      } else if (e.key === "End") {
        e.preventDefault();
        goto(doc.numPages);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [doc, goto, mode]);

  // 放映：按窗口自适应 contain 缩放（随页与窗口变化重算）
  useEffect(() => {
    if (mode !== "slideshow") return;
    let cancelled = false;
    doc.getPage(page).then((p) => {
      if (cancelled || !rootRef.current) return;
      const v = p.getViewport({ scale: 1, rotation: (p.rotate + viewRotate) % 360 });
      const availW = rootRef.current.clientWidth - 72;
      const availH = rootRef.current.clientHeight - 88;
      setFitScale(Math.max(0.05, Math.min(availW / v.width, availH / v.height, 4)));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [doc, page, mode, viewRotate, resizeTick]);

  useEffect(() => {
    const onResize = () => setResizeTick((t) => t + 1);
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);

  // 自动播放：到最后一页自动停止
  useEffect(() => {
    if (mode !== "slideshow" || !autoplay) return;
    const t = window.setInterval(() => {
      if (pageRef.current >= doc.numPages) { setAutoplay(0); return; }
      goto(pageRef.current + 1);
    }, autoplay * 1000);
    return () => window.clearInterval(t);
  }, [mode, autoplay, doc, goto]);

  const step = useCallback((d: number) => goto(pageRef.current + d), [goto]);

  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaY) < 12) return;
    const now = Date.now();
    if (now - wheelAt.current < 400) return;
    wheelAt.current = now;
    if (mode === "slideshow" || (mode === "read" && !continuous)) step(e.deltaY > 0 ? 1 : -1);
  };

  const total = doc.numPages;

  return (
    <div className={"immersive-root" + (mode === "slideshow" ? " is-show" : " is-read") + (chrome ? "" : " chrome-hidden")}
         ref={rootRef} role="dialog" aria-modal="true" tabIndex={-1}
         aria-label={mode === "slideshow" ? `放映 · ${fileTitle}` : `全屏预览 · ${fileTitle}`}
         onMouseMove={wake} onWheel={onWheel}>
      {mode === "read" ? (
        <div className="immersive-canvas" ref={scrollRef} tabIndex={-1}>
          {continuous ? (
            <ContinuousPages doc={doc} scale={scale} viewRotate={viewRotate} pageNum={page}
                             jumpToken={jumpToken} scrollRef={scrollRef} onCurrentPage={setPage}
                             needText highlight={null} showTags={false} />
          ) : (
            <div className="immersive-single">
              <PageView doc={doc} number={page} scale={scale} viewRotate={viewRotate} needText highlight={null} />
            </div>
          )}
        </div>
      ) : (
        <div className="immersive-stage">
          <PageView doc={doc} number={page} scale={fitScale} viewRotate={viewRotate} needText={false} highlight={null} />
        </div>
      )}

      <div className="immersive-top">
        <span className="immersive-title" title={fileTitle}>{fileTitle}</span>
        <span className="immersive-hint">{mode === "slideshow" ? "← → 或空格翻页 · Esc 退出" : "Esc 退出全屏预览"}</span>
        <button type="button" className="immersive-btn" onClick={() => onExitRef.current(pageRef.current)}>退出</button>
      </div>

      <div className="immersive-bottom">
        {mode === "read" ? (
          <>
            <button type="button" className="immersive-btn" onClick={() => step(-1)} disabled={page <= 1} aria-label="上一页">‹</button>
            <span className="immersive-page">第 {page} / {total} 页</span>
            <button type="button" className="immersive-btn" onClick={() => step(1)} disabled={page >= total} aria-label="下一页">›</button>
            <span className="immersive-sep" aria-hidden="true" />
            <button type="button" className="immersive-btn" onClick={() => setScale((s) => Math.max(0.3, Math.round((s - 0.1) * 10) / 10))} aria-label="缩小">−</button>
            <button type="button" className="immersive-btn immersive-zoom" onClick={() => setScale(1)} title="恢复到 100%" aria-label={`当前 ${Math.round(scale * 100)}%，恢复到 100%`}>{Math.round(scale * 100)}%</button>
            <button type="button" className="immersive-btn" onClick={() => setScale((s) => Math.min(4, Math.round((s + 0.1) * 10) / 10))} aria-label="放大">＋</button>
            <span className="immersive-sep" aria-hidden="true" />
            <button type="button" className="immersive-btn" onClick={() => setContinuous((c) => !c)} aria-pressed={continuous}>
              {continuous ? "连续" : "单页"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="immersive-btn" onClick={() => step(-1)} disabled={page <= 1} aria-label="上一页">‹</button>
            <span className="immersive-page">第 {page} / {total} 页</span>
            <button type="button" className="immersive-btn" onClick={() => step(1)} disabled={page >= total} aria-label="下一页">›</button>
            <span className="immersive-sep" aria-hidden="true" />
            <label className="immersive-autoplay">
              <select value={autoplay} aria-label="自动播放间隔" onChange={(e) => setAutoplay(Number(e.target.value))}>
                {AUTOPLAY_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
            </label>
          </>
        )}
      </div>
    </div>
  );
}
