import React, { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";

type PDFDoc = pdfjs.PDFDocumentProxy;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface PageHighlight {
  query: string;
  matches: Map<number, { itemIdx: number; start: number; len: number }[]>;
}

// ---------------- 单页渲染（画布 + 文字层 + 高亮） ----------------

export function PageView({ doc, number, scale, viewRotate, needText, highlight, onSelection }: {
  doc: PDFDoc; number: number; scale: number; viewRotate: number;
  needText: boolean; highlight: PageHighlight | null;
  onSelection?: (text: string, page: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const rotation = (viewRotate % 360 + 360) % 360;

  // 画布渲染
  useEffect(() => {
    let cancelled = false;
    let render: pdfjs.RenderTask | null = null;
    doc.getPage(number).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
      setSize({ w: viewport.width, h: viewport.height });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      render = page.render({ canvas, canvasContext: ctx, viewport } as never);
      render.promise.catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; render?.cancel(); };
  }, [doc, number, scale, rotation]);

  // 文字层（可选中/可复制）+ 高亮带
  useEffect(() => {
    if (!needText || !size) return;
    let cancelled = false;
    const pageP = doc.getPage(number);
    pageP.then(async (page) => {
      if (cancelled || !textRef.current) return;
      try {
        const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
        const content = await page.getTextContent();
        if (cancelled || !textRef.current || !hlRef.current) return;
        const container = textRef.current;
        container.innerHTML = "";
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;
        // 逐项 span，保持可选中
        for (const item of content.items as any[]) {
          if (!("str" in item) || !item.str) continue;
          const tx = pdfjs.Util.transform(viewport.transform, item.transform);
          const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
          const width = (item.width || 0) * viewport.scale;
          const span = document.createElement("span");
          span.textContent = item.str;
          span.style.left = `${tx[4]}px`;
          span.style.top = `${tx[5] - fontHeight}px`;
          span.style.fontSize = `${fontHeight}px`;
          if (width > 0) span.style.width = `${width}px`;
          container.appendChild(span);
        }
        // 高亮带（对齐文字行宽，暖黄底）
        const hl = hlRef.current;
        hl.innerHTML = "";
        const pageMatches = highlight?.matches.get(number);
        if (pageMatches && highlight?.query) {
          for (const m of pageMatches) {
            const item = (content.items as any[])[m.itemIdx];
            if (!item || !("str" in item)) continue;
            const tx = pdfjs.Util.transform(viewport.transform, item.transform);
            const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
            const width = (item.width || 0) * viewport.scale;
            const len = Math.max(1, item.str.length);
            const left = tx[4] + (m.start / len) * width;
            const w = (m.len / len) * width;
            const box = document.createElement("i");
            box.style.left = `${left}px`;
            box.style.top = `${tx[5] - fontHeight}px`;
            box.style.width = `${w}px`;
            box.style.height = `${fontHeight}px`;
            hl.appendChild(box);
          }
        }
      } catch { /* 单页文字层失败不影响阅读 */ }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [doc, number, scale, rotation, needText, size, highlight]);

  const handleUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || "";
    if (text && onSelection) onSelection(text, number);
  };

  return (
    <div className="pdf-page" ref={wrapRef} data-page={number}
         style={size ? { width: size.w, height: size.h } : { minHeight: 400 }}>
      <canvas ref={canvasRef} aria-label={`第 ${number} 页`} />
      <div className="hl-layer" ref={hlRef} aria-hidden="true" />
      <div className="text-layer" ref={textRef} onMouseUp={handleUp} />
    </div>
  );
}

// ---------------- 连续模式（窗口化渲染，R01 大文档不冻结） ----------------

export function ContinuousPages({ doc, scale, viewRotate, pageNum, jumpToken, scrollRef, onCurrentPage, needText, highlight, onSelection, showTags = true }: {
  doc: PDFDoc; scale: number; viewRotate: number; pageNum: number; jumpToken: number;
  scrollRef: React.RefObject<HTMLElement | null>; onCurrentPage: (p: number) => void;
  needText: boolean;
  highlight: PageHighlight | null;
  onSelection?: (text: string, page: number) => void;
  showTags?: boolean;
}) {
  const [slot, setSlot] = useState<{ w: number; h: number } | null>(null);
  const [visible, setVisible] = useState(pageNum);

  useEffect(() => {
    doc.getPage(1).then((page) => {
      const v = page.getViewport({ scale, rotation: (page.rotate + viewRotate) % 360 });
      setSlot({ w: v.width, h: v.height + 26 });
    }).catch(() => {});
  }, [doc, scale, viewRotate]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && slot) el.scrollTop = (pageNum - 1) * slot.h;
    setVisible(pageNum);
  }, [jumpToken, slot, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!slot) return;
      const p = clamp(Math.floor((el.scrollTop + 80) / slot.h) + 1, 1, doc.numPages);
      setVisible(p);
      if (p !== pageNum) onCurrentPage(p);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll, { passive: true } as never);
  }, [doc, slot, pageNum, onCurrentPage, scrollRef]);

  // 只挂载当前页附近的窗口；远距离滚动也不扩展到整份文档。
  const start = clamp(visible - 2, 1, doc.numPages);
  const end = clamp(visible + 3, 1, doc.numPages);
  const slotH = slot?.h || 900;

  return (
    <div className="continuous-track" style={{ height: doc.numPages * slotH, minWidth: slot ? slot.w + 48 : undefined }}>
      {slot && Array.from({ length: end - start + 1 }, (_, k) => {
        const number = start + k;
        const active = highlight?.matches.has(number);
        return (
          <div key={`${number}-${scale}-${viewRotate}`} className="continuous-slot"
               style={{ top: (number - 1) * slotH, minHeight: slotH - 26 }} data-page={number}>
            <PageView doc={doc} number={number} scale={scale} viewRotate={viewRotate}
                      needText={needText && Math.abs(number - visible) <= 1}
                      highlight={active ? highlight : null} onSelection={onSelection} />
            {showTags && <span className="page-tag">第 {number} / {doc.numPages} 页</span>}
          </div>
        );
      })}
    </div>
  );
}
