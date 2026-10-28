import { pickPdfs } from "./api";
import type { FileEntry } from "./types";

/**
 * 原生对话框选择 PDF（06 改版 §2 受信任原生选择通道）：结果由引擎登记真实路径后返回，
 * 「与源文件同目录」因此可用；HTTP 请求不携带路径，安全边界不变。
 * 返回 null 表示通道不可用（旧引擎等）——调用方回退网页文件选择。
 */
export async function pickPdfsNative(kind: "pdf" | "convert" = "pdf"): Promise<{ cancelled: boolean; files: FileEntry[]; errors: string[] } | null> {
  try {
    return await pickPdfs(kind);
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (status === 404 || status === 405 || status === 501) return null;
    throw error;
  }
}

/** 打开引擎已登记的 PDF：全部开标签、第一个激活（与上传多开行为一致）。 */
export function openRegistered(openFile: (f: FileEntry, page?: number) => void, files: FileEntry[]): FileEntry[] {
  const opened = files.filter((f) => f.kind === "pdf");
  opened.forEach((f) => openFile(f));
  if (opened[0]) openFile(opened[0]);
  return opened;
}
