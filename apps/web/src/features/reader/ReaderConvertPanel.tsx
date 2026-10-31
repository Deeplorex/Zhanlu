import React, { useEffect, useRef, useState } from "react";
import { AppCtx } from "../../app/AppContext";
import { openPath } from "../../shared/api";
import SaveLocationSelect, { type SaveMode } from "../../shared/SaveLocationSelect";
import { useJob } from "../../shared/workflow";
import SwordProgress, { swordRunningText } from "../../shared/SwordProgress";
import type { FileEntry } from "../../shared/types";

export type ReaderConvertTarget = "png" | "jpg" | "txt" | "md";

/** 专属右栏（06 改版 107–109）：随工具栏入口核对当前目标。
 * Office 基础版仅在独立转换任务页提供。 */
const FIXED_OUTPUT: Record<"md" | "txt", string> = {
  md: "Markdown (.md) · 单个文件",
  txt: "纯文本 (.txt) · 单个文件",
};

const RUN_LABEL: Record<ReaderConvertTarget, string> = {
  png: "开始转换图片 →", jpg: "开始转换图片 →", md: "开始转换 Markdown →", txt: "开始提取 TXT →",
};
const TITLE: Record<ReaderConvertTarget, string> = {
  png: "转换为图片", jpg: "转换为图片", md: "转换为 Markdown", txt: "提取 TXT",
};
const DPI_LABEL: Record<number, string> = { 96: "标准 · 96 DPI", 150: "高 · 150 DPI", 300: "印刷 · 300 DPI" };

/**
 * 阅读内转换：右栏由当前目标驱动，标题、字段、预览与 convert_pdf 参数一起更新；
 * 图片的 PNG/JPEG 与 DPI 偏好单独记忆；文字转换不携带图片参数；迟到预览由 useJob 序号守卫。
 */
export default function ReaderConvertPanel({ file, target, onTargetChange, refreshFiles, pageNum }: {
  file: FileEntry;
  target: ReaderConvertTarget;
  onTargetChange: (t: ReaderConvertTarget) => void;
  refreshFiles: () => Promise<void>;
  pageNum: number;
}) {
  const { appInfo, readerView, saveReaderView } = React.useContext(AppCtx);
  const job = useJob("convert_pdf");
  const [range, setRange] = useState<"all" | "current" | "custom">("all");
  const [pages, setPages] = useState("");
  const [prefix, setPrefix] = useState(() => file.name.replace(/\.pdf$/i, ""));
  const [saveMode, setSaveMode] = useState<SaveMode>("default");
  const [customDir, setCustomDir] = useState<string | null>(null);
  const [dpi, setDpi] = useState<number>(() => readerView[file.id]?.convertDpi || 150);
  const submittedFor = useRef<ReaderConvertTarget | null>(null);

  const isImage = target === "png" || target === "jpg";
  const withDpi = isImage;
  const effPages = range === "all" ? undefined : range === "current" ? String(pageNum) : pages.trim();
  const dirParam = saveMode === "source" ? "@source" : saveMode === "custom" && customDir ? customDir : undefined;
  // 目标一致地驱动预览与请求：文字转换不携带图片专用参数
  const params = withDpi
    ? { id: file.id, target, pages: effPages, dpi, prefix, dir: dirParam }
    : { id: file.id, target, pages: effPages, prefix, dir: dirParam };

  useEffect(() => {
    job.setParams(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, target, effPages, dpi, prefix, dirParam]);

  // DPI 偏好跟随当前文档记忆
  useEffect(() => { saveReaderView(file.id, { convertDpi: dpi }); }, [file.id, dpi, saveReaderView]);

  const run = async () => {
    submittedFor.current = target;
    const done = await job.run();
    if (done?.status === "done") await refreshFiles();
  };
  const again = () => {
    job.reset();
    submittedFor.current = null;
    job.setParams(params);
  };

  const finished = job.done?.status === "done" && submittedFor.current === target
    ? (job.done.result?.files || []) as FileEntry[]
    : [];
  const outCount = job.preview?.outputs?.length || 0;
  const outs = job.preview?.outputs || [];
  const totalPages = file.pages ?? outCount;
  const allPagesLabel = outCount
    ? `全部页面 · ${totalPages} 页 → ${outCount} ${isImage ? "张" : "个文件"}`
    : "全部页面";
  // 输出预览（107）：首名 + 末名缩写 + 数量；同目录模式下名称已含自动编号
  let previewText = "";
  if (outs.length === 1) {
    previewText = `输出预览：${outs[0].name}`;
  } else if (outs.length > 1) {
    const first = outs[0].name;
    const last = outs[outs.length - 1].name;
    let k = 0;
    while (k < first.length && k < last.length && first[k] === last[k]) k++;
    // 缩写到连字符边界（画板 107：「至 -p024.png」）
    const dash = first.slice(0, k).lastIndexOf("-");
    previewText = `输出预览：${first}\n至 ${dash >= 0 ? last.slice(dash) : last} · 共 ${outs.length} 张`;
  }
  const fixed = target in FIXED_OUTPUT ? FIXED_OUTPUT[target as keyof typeof FIXED_OUTPUT] : null;
  const saveError = job.previewError || (job.preview && !job.preview.ok ? job.preview.error : null);
  // 扫描页提示只对依赖文字层的目标有意义
  const needsText = target === "md" || target === "txt";

  return (
    <aside className="convert-panel" aria-label={TITLE[target]}>
      <div className="convert-scroll">
        <div className="convert-head">
          <h2>{TITLE[target]}</h2>
          <p className="convert-source" title={file.name}>{file.name} · {file.pages || "?"} 页</p>
        </div>

        {finished.length ? (
          <div className="convert-done" role="status">
            <h3>转换完成 · {finished.length} 个文件</h3>
            <div className="pages-save-actions">
              <button type="button" className="btn" onClick={() => openPath({ id: finished[0].id }).catch(() => {})}>打开结果位置</button>
              <button type="button" className="btn primary" onClick={again}>再次转换</button>
            </div>
          </div>
        ) : job.busy ? (
          <div className="convert-running" role="status">
            <h3>{job.submitting ? "正在提交转换任务…" : job.task ? swordRunningText(job.task) : "转换中"}</h3>
            {!job.submitting && (
              <SwordProgress value={job.task?.progress || 0} unknown={job.task?.progressKnown === false}
                             label={`转换 ${file.name}`} />
            )}
            <p className="note">可继续阅读原文，任务在后台进行。</p>
            <button type="button" className="btn sm" onClick={() => job.cancel()} disabled={!job.task?.id || job.task.status === "cancelling"}>取消</button>
          </div>
        ) : (
          <>
            {isImage && (
              <div className="cfield">
                <span className="convert-label">图片格式</span>
                <div className="fmt-pair" role="radiogroup" aria-label="图片格式">
                  {(["png", "jpg"] as const).map((f) => (
                    <button type="button" key={f} role="radio" aria-checked={target === f}
                            className={"fmt-pair-btn" + (target === f ? " on" : "")}
                            onClick={() => onTargetChange(f)}>
                      <i aria-hidden="true" /> {f === "png" ? "PNG" : "JPEG"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {fixed && (
              <div className="convert-fixed" role="status">
                <strong>{fixed}</strong>
              </div>
            )}

            {withDpi && (
              <div className="cfield">
                <span className="convert-label">清晰度</span>
                <select className="input convert-range" value={dpi} onChange={(e) => setDpi(Number(e.target.value))}
                        aria-label="清晰度">
                  {[96, 150, 300].map((d) => <option key={d} value={d}>{DPI_LABEL[d]}</option>)}
                </select>
              </div>
            )}

            <div className="cfield">
              <span className="convert-label">页范围与数量</span>
              <select className="input convert-range" value={range} onChange={(e) => setRange(e.target.value as typeof range)}
                      aria-label="页范围">
                <option value="all">{allPagesLabel}</option>
                <option value="current">当前页（第 {pageNum} 页）</option>
                <option value="custom">自定义范围…</option>
              </select>
              {range === "custom" && (
                <input className="input" placeholder="如 1-3, 5" value={pages} aria-label="页码范围"
                       onChange={(e) => setPages(e.target.value)} />
              )}
              {range === "custom" && !pages.trim() && <p className="wf-error">请输入要转换的页码范围。</p>}
            </div>

            <div className="cfield">
              <span className="convert-label">{isImage ? "文件名前缀" : "文件名（不含扩展名）"}</span>
              <input className="input" value={prefix} aria-label={isImage ? "文件名前缀" : "输出文件名"} onChange={(e) => setPrefix(e.target.value)} />
            </div>

            <div className="cfield">
              <span className="convert-label">保存位置</span>
              <SaveLocationSelect mode={saveMode} customDir={customDir} onMode={setSaveMode} onCustomDir={setCustomDir} />
              {saveMode === "source" && file.source_dir && (
                <p className="save-dir-hint" title={file.source_dir}>{file.source_dir}</p>
              )}
            </div>

            {saveError && <p className="wf-error" role="alert">{saveError}</p>}
            {job.runError && <p className="wf-error" role="alert">{job.runError}</p>}
            {job.preview?.warnings?.map((w, i) => <p key={i} className="wf-warn">⚠ {w}</p>)}
            <div className="convert-footer">
              {previewText && <p className="convert-preview">{previewText}</p>}
              {needsText && appInfo?.ocr_available && (
                <p className="convert-ocr-hint">扫描页没有文字层时，先<button type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent("zhanlu:ocr-current"))}>识别当前页</button>再转换。</p>
              )}
              <button type="button" className="convert-run" disabled={!job.preview?.ok || !file || (range === "custom" && !pages.trim())} onClick={run}>
                {RUN_LABEL[target]}
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
