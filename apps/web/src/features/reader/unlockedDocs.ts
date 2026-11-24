import type * as pdfjs from "pdfjs-dist";

type LoadingTask = pdfjs.PDFDocumentLoadingTask;

/**
 * 已解锁的加密文档（2026-11-24 用户决定）：标签页保持打开期间留在内存，切回同一标签不再索取密码；
 * 标签关闭即销毁。这里只保留 pdf.js 已解锁的文档，密码本身从不单独保存，也不落盘。
 */
const unlockedDocs = new Map<string, LoadingTask>();

/** 该文档已解锁的加载任务；未解锁、或已随标签关闭销毁时为 null */
export function unlockedDoc(id: string): LoadingTask | null {
  return unlockedDocs.get(id) ?? null;
}

/** 密码验证通过后登记：此后由这里负责销毁，阅读器卸载时不再销毁 */
export function keepUnlockedDoc(id: string, task: LoadingTask): void {
  unlockedDocs.set(id, task);
}

export function ownsUnlockedDoc(id: string, task: LoadingTask): boolean {
  return unlockedDocs.get(id) === task;
}

/** 销毁已不在打开标签中的已解锁文档 */
export function releaseUnlockedDocs(openIds: ReadonlySet<string>): void {
  for (const [id, task] of unlockedDocs) {
    if (openIds.has(id)) continue;
    unlockedDocs.delete(id);
    void task.destroy().catch(() => {});
  }
}
