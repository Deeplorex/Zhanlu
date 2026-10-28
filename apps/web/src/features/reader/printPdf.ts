import { PermissionFlag, type PDFDocumentProxy } from "pdfjs-dist";

/** Print the unlocked current document without invoking another PDF application. */
export async function printPdf(doc: PDFDocumentProxy, name: string, signal: AbortSignal): Promise<void> {
  const permissions = await doc.getPermissions();
  if (permissions && !permissions.has(PermissionFlag.PRINT)) throw new Error("此 PDF 不允许打印。");
  signal.throwIfAborted();
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const frame = document.createElement("iframe");
  frame.title = `打印 · ${name}`;
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0";
  document.body.append(frame);
  const urls: string[] = [];
  const cleanup = () => {
    const focused = document.activeElement === frame;
    frame.remove();
    urls.forEach(URL.revokeObjectURL);
    if (focused && returnFocus?.isConnected) returnFocus.focus();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  try {
    const target = frame.contentDocument!;
    target.title = name;
    const style = target.createElement("style");
    style.textContent = "html,body{margin:0;padding:0}section{break-after:page;overflow:hidden}section:last-child{break-after:auto}img{display:block;width:100%;height:100%}@media screen{section{display:none}}";
    target.head.append(style);
    for (let number = 1; number <= doc.numPages; number++) {
      signal.throwIfAborted();
      const page = await doc.getPage(number);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 150 / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const task = page.render({ canvas, viewport, intent: "print" });
      const cancelRender = () => task.cancel();
      signal.addEventListener("abort", cancelRender, { once: true });
      try { await task.promise; } finally { signal.removeEventListener("abort", cancelRender); }
      signal.throwIfAborted();
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("无法准备打印页面。")), "image/png"));
      canvas.width = canvas.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const section = target.createElement("section");
      section.style.cssText = `width:${size.width}pt;height:${size.height}pt;page:pdf-${number}`;
      style.textContent += `@page pdf-${number}{size:${size.width}pt ${size.height}pt;margin:0}`;
      const img = target.createElement("img");
      img.src = url;
      section.append(img);
      target.body.append(section);
      await img.decode();
    }
    signal.throwIfAborted();
    const win = frame.contentWindow!;
    await new Promise<void>((resolve, reject) => {
      const done = () => { signal.removeEventListener("abort", aborted); resolve(); };
      const aborted = () => reject(signal.reason);
      win.addEventListener("afterprint", done, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      try { win.focus(); win.print(); } catch (error) { signal.removeEventListener("abort", aborted); reject(error); }
    });
  } finally {
    signal.removeEventListener("abort", cleanup);
    cleanup();
  }
}
