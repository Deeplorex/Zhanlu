export interface FileEntry {
  id: string;
  name: string;
  kind: string;
  size: number;
  mtime: number;
  pages?: number;
  encrypted?: boolean;
  display?: string;
  path?: string;
  /** 可信源目录（06 改版「与源文件同目录」）；浏览器上传的 inbox 副本为 null */
  source_dir?: string | null;
}

export interface OutlineNode {
  title: string;
  page?: number | null;
  children: OutlineNode[];
}

export interface FileInfo extends FileEntry {
  outline?: OutlineNode[];
  width_pt?: number;
  height_pt?: number;
  meta?: Record<string, string>;
  text_pages_sampled?: number;
  sampled?: number;
}

export interface TaskOutput {
  id?: string;
  name: string;
  path?: string;
  kind?: string;
  pages?: number;
}

export type TaskStatus =
  | "running"
  | "cancelling"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

export interface Task {
  id: string;
  kind: string;
  name: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  progress: number;
  /** false＝上游明确表示当前无法估算（保留最后已知数值）；缺省视为可确定（兼容旧任务） */
  progressKnown?: boolean;
  detail?: string | null;
  error?: string | null;
  created: number;
  finished?: number | null;
  outputs: TaskOutput[];
  retry_of?: string | null;
  result?: {
    files?: FileEntry[];
    file?: FileEntry;
    answer?: string;
    sources?: AiSource[];
    /** AI 识别目录（action=outline）的结构化条目 */
    outline?: { title: string; page: number; level?: number }[];
    pages?: Record<string, { page: number; words: number; avg_score: number; low: boolean }>;
    low_pages?: number[];
    total_pages?: number;
    checked?: number;
  } | null;
}

export interface PreviewOutput {
  name: string;
  pages?: number;
  range?: string;
  note?: string;
  order?: string[];
}

export interface JobPreview {
  ok: boolean;
  error?: string;
  summary?: string;
  outputs: PreviewOutput[];
  warnings: string[];
  dir: string;
  writable_error?: string | null;
  conflicts: string[];
  /** 与源文件同目录模式：预览名已含自动编号，重名不阻止执行 */
  numbered?: boolean;
}

export interface AiSource {
  page: number;
  excerpt: string;
}

export interface LocalAiStatus {
  installed: boolean;
  plugin?: { installed: boolean; dir: string; zip_url: string; approx_mb: number };
  from_plugin?: boolean;
  exe?: string | null;
  running: boolean;
  api: string;
  models: { name: string; size?: number }[];
  default_model?: string | null;
  auto_start: boolean;
  recommended: string;
  pull_targets: string[];
}

export interface AppInfo {
  desktop_input?: boolean;
  name: { zh: string; en: string };
  display: string;
  version: string;
  instance: string;
  out_dir: string;
  ocr_available: boolean;
  ocr_tier?: string | null;
  ocr_plugin?: {
    dir: string;
    tiers: Record<string, boolean>;
    active: string | null;
    source: string;
  };
  local_ai: LocalAiStatus;
}

export interface AiConfig {
  id: string;
  name: string;
  protocol: string;
  baseurl: string;
  model: string;
  key?: string;
  has_key?: boolean;
  key_masked?: string;
}

export type DocMode = "reader" | "pages" | "convert";

export interface ReaderView {
  page?: number;
  scale?: number;
  continuous?: boolean;
  tab?: "thumbs" | "bookmarks" | "search";
  query?: string;
  rotate?: number;
  mode?: DocMode;
  aiOpen?: boolean;
  /** 转换上下文：进入转换模式时恢复上次子类型；图片 DPI 偏好单独记忆 */
  convertTarget?: "png" | "jpg" | "txt" | "md" | "docx" | "xlsx" | "csv" | "pptx";
  convertDpi?: number;
  /** 无书签文档的 AI 识别目录（重开文档恢复；重新识别覆盖） */
  aiOutline?: OutlineNode[];
}

export interface TaskSeed {
  kind: string;
  files: FileEntry[];
  key: number;
}

export type TaskKind = "split" | "merge" | "convert";

export interface WorkspaceTaskTab {
  id: string;
  kind: TaskKind;
  title: string;
  seed: TaskSeed | null;
}

export interface SelectionPayload {
  fileId: string;
  text: string;
  page: number;
  action?: "explain" | "translate";
}
