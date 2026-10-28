import React from "react";
import type { AppInfo, DocMode, FileEntry, ReaderView, SelectionPayload, TaskKind, TaskSeed, WorkspaceTaskTab } from "../shared/types";

export interface AppCtxValue {
  appInfo: AppInfo | null;
  files: FileEntry[];
  refreshFiles: () => Promise<void>;
  engines: any;
  refreshEngines: () => Promise<void>;
  current: FileEntry | null;
  setCurrent: (f: FileEntry | null) => void;
  openFile: (f: FileEntry, page?: number) => void;
  tabs: FileEntry[];
  closeTab: (id: string) => void;
  /** 批量关闭工作标签（PDF 与任务），激活规则与右键菜单一致：未关保持、被关取逻辑顺序右侧优先邻位、无则回首页 */
  closeWorkTabs: (pdfIds: string[], taskIds: string[]) => void;
  taskSeed: TaskSeed | null;
  startTask: (kind: TaskKind, files: FileEntry[]) => void;
  setTaskTabTitle: (id: string, title: string) => void;
  taskTabs: WorkspaceTaskTab[];
  activeTaskTabId: string | null;
  taskTabId: string | null;
  switchTaskTab: (id: string) => void;
  closeTaskTab: (id: string) => void;
  readerView: Record<string, ReaderView>;
  saveReaderView: (id: string, view: ReaderView) => void;
  /** 当前 PDF 的文档模式；AI 阅读是右侧聊天浮层，不占模式位 */
  docMode: DocMode;
  setDocMode: (mode: DocMode) => void;
  aiOpen: boolean;
  setAiOpen: (open: boolean) => void;
  /** 首页 / 无当前 PDF 时气泡打开的选文件引导 */
  aiGuideOpen: boolean;
  setAiGuideOpen: (open: boolean) => void;
  /** 本次打开 Chat 的触发控件；关闭时焦点回到它 */
  aiTriggerRef: React.MutableRefObject<HTMLElement | null>;
  /** 首页 AI 入口 / 选区解释翻译：落在当前 PDF 的右侧 Chat 浮层 */
  openAiForFile: (f: FileEntry, action?: "explain" | "translate") => void;
  /** 来源引用：切回阅读模式、定位原页并收起 Chat */
  gotoPage: (page: number) => void;
  /** 页面模式存在未应用的整理变更（打印前提示用） */
  pagesDirty: boolean;
  setPagesDirty: (dirty: boolean) => void;
  readerJump: { id: string; page: number; key: number } | null;
  consumeReaderJump: () => void;
  /** 底栏左侧的上下文状态（如「已恢复第 N 页」「查找结果待定位」） */
  docStatus: string | null;
  setDocStatus: (s: string | null) => void;
  toast: (msg: string, err?: boolean) => void;
  selection: SelectionPayload | null;
  setSelection: React.Dispatch<React.SetStateAction<SelectionPayload | null>>;
}

export const AppCtx = React.createContext<AppCtxValue>(null as unknown as AppCtxValue);
