/**
 * 页面整理草稿仓库（内存，按文件 ID）：阅读器按文件标签挂载，切到别的标签会卸载组件；
 * 把草稿留在这里，切回同一文件时恢复页序、选区、撤销记录与输出参数。
 * 关闭标签即丢弃；不落盘，退出应用后不保留。
 */
import type { FileEntry } from "../../shared/types";
import type { Change, PageInstance } from "./plan";

export interface Draft {
  plan: PageInstance[];
  sel: Set<string>;
  /** 最近一步变更（底部摘要用） */
  last: Change | null;
}

export interface SavedDraft {
  draft: Draft;
  history: Draft[];
  /** 已成功另存那一版的内容签名 */
  appliedKey: string | null;
  /** 当前草稿是否仍有未应用变更（关闭标签保护用） */
  dirty: boolean;
  name: string;
  dir: string | null;
  lastSource: FileEntry | null;
  importSizes: Record<string, Array<[number, number]>>;
}

const drafts = new Map<string, SavedDraft>();

export function loadDraft(fileId: string): SavedDraft | null {
  return drafts.get(fileId) ?? null;
}

export function saveDraft(fileId: string, saved: SavedDraft): void {
  drafts.set(fileId, saved);
}

/** 该文件是否留着未应用的页面整理变更——不限于当前标签（草稿在切走后仍保留） */
export function hasUnsavedDraft(fileId: string): boolean {
  const saved = drafts.get(fileId);
  return !!saved && saved.dirty;
}

export function dropDraft(fileId: string): void {
  drafts.delete(fileId);
}

export function hasDraft(fileId: string): boolean {
  return drafts.has(fileId);
}

/** 关闭标签后丢弃对应草稿（恢复出的新文件标签不受影响） */
export function pruneDrafts(openIds: Set<string>): void {
  for (const id of [...drafts.keys()]) if (!openIds.has(id)) drafts.delete(id);
}
