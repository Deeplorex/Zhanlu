import React, { useEffect, useRef, useState } from "react";
import { AppCtx } from "../../app/AppContext";
import { fmtSize, openPath, rawUrl, uploadFiles } from "../../shared/api";
import { pickPdfsNative } from "../../shared/nativeOpen";
import { useNativeDrop } from "../../shared/nativeDrag";
import { useJob } from "../../shared/workflow";
import SaveLocationSelect, { type SaveMode } from "../../shared/SaveLocationSelect";
import type { FileEntry } from "../../shared/types";
import DropZone from "../../shared/components/DropZone";
import SwordProgress, { swordPct } from "../../shared/SwordProgress";

type Target = "png" | "jpg" | "txt" | "md" | "docx" | "xlsx" | "csv" | "pptx";

const FORMAT_CARDS: { id: Target; label: string; sub: string }[] = [
  { id: "png", label: "PNG 图片", sub: "每页一张，适合分享" },
  { id: "jpg", label: "JPG 图片", sub: "体积较小" },
  { id: "txt", label: "可提取文本", sub: "需要 PDF 含文字层" },
  { id: "md", label: "Markdown", sub: "标题与列表按层级转换" },
  { id: "docx", label: "Word 文档", sub: "文字按页整理 · 基础版" },
  { id: "xlsx", label: "Excel 表格", sub: "提取检测到的表格" },
  { id: "csv", label: "CSV 表格", sub: "提取检测到的表格" },
  { id: "pptx", label: "PPT 演示", sub: "每页一张幻灯片图片" },
];

/** 独立转换任务标签（Figma 36）：目标格式三卡、页码范围、输出预览与保存位置同屏。 */
export default function Convert() {
  const { taskSeed, taskTabId, setTaskTabTitle, refreshFiles, openFile, toast, engines } = React.useContext(AppCtx);
  const pdfJob = useJob("convert_pdf");
  const imgJob = useJob("images_pdf");

  const engineTargets = (engines?.targets?.pdf || []) as { target: string; available?: boolean; note?: string }[];
  const targetAvail = (t: Target) => {
    const row = engineTargets.find((r) => r.target === t);
    return { available: row ? row.available !== false : true, note: row?.note || "" };
  };

  const [pdfFile, setPdfFile] = useState<FileEntry | null>(null);
  const [target, setTarget] = useState<Target>("png");
  const [pages, setPages] = useState("");
  const [dpi, setDpi] = useState(150);
  const [prefix, setPrefix] = useState("");
  const [pdfDir, setPdfDir] = useState<string | null>(null);
  const [pdfSaveMode, setPdfSaveMode] = useState<SaveMode>("default");

  const [images, setImages] = useState<FileEntry[]>([]);
  const [outName, setOutName] = useState("图片合集.pdf");
  const [imgDir, setImgDir] = useState<string | null>(null);
  const [imgSaveMode, setImgSaveMode] = useState<SaveMode>("default");
  const [dragged, setDragged] = useState<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageDropRef = useRef<HTMLButtonElement>(null);

  const imageMode = images.length > 0 && !pdfFile;
  const busy = pdfJob.busy || imgJob.busy;
  const pdfDirParam = pdfSaveMode === "source" ? "@source" : pdfSaveMode === "custom" ? pdfDir || undefined : undefined;
  const imgDirParam = imgSaveMode === "source" ? "@source" : imgSaveMode === "custom" ? imgDir || undefined : undefined;

  useNativeDrop(imageDropRef, (result) => {
    if (busy) return;
    if (result.errors.length) toast(`部分文件未能打开：${result.errors[0]}`, true);
    const imgs = result.files.filter((f) => f.kind === "image");
    if (imgs.length !== result.files.length) toast("这里只能添加图片。", true);
    setImages((old) => [...old, ...imgs.filter((f, i, all) => !old.some((x) => x.id === f.id)
      && all.findIndex((x) => x.id === f.id) === i)]);
    void refreshFiles();
  }, imageMode && !busy);

  useEffect(() => {
    if (taskSeed?.kind !== "convert" || !taskSeed.files.length) return;
    const first = taskSeed.files[0];
    if (first.kind === "image") setImages(taskSeed.files);
    else if (first.kind === "pdf") {
      setPdfFile(first);
      setPrefix(first.name.replace(/\.pdf$/i, ""));
    }
  }, [taskSeed?.key]);

  useEffect(() => {
    if (!taskTabId) return;
    const label = { png: "PNG", jpg: "JPG", txt: "TXT", md: "Markdown", docx: "Word", xlsx: "Excel", csv: "CSV", pptx: "PPT" }[target];
    setTaskTabTitle(taskTabId, imageMode ? "转换 · 图片" : `转换 · ${label}`);
  }, [taskTabId, imageMode, target, setTaskTabTitle]);

  // PDF 转换参数 → 预览
  useEffect(() => {
    if (!pdfFile || imageMode) return;
    pdfJob.setParams({ id: pdfFile.id, target, pages: pages.trim() || undefined, dpi, prefix, dir: pdfDirParam });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfFile?.id, target, pages, dpi, prefix, pdfDirParam]);

  // 图片 → PDF 参数 → 预览
  useEffect(() => {
    if (!images.length) return;
    imgJob.setParams({ ids: images.map((f) => f.id), name: outName, dir: imgDirParam });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, outName, imgDirParam]);

  const added = (entries: FileEntry[]) => {
    const pdfs = entries.filter((f) => f.kind === "pdf");
    const imgs = entries.filter((f) => f.kind === "image");
    if ((pdfs.length || pdfFile) && (imgs.length || images.length)) {
      toast("PDF 转换与图片转 PDF 是两个任务，请分开进行。", true);
    }
    if (pdfs.length) {
      setPdfFile(pdfs[0]);
      setPrefix(pdfs[0].name.replace(/\.pdf$/i, ""));
      setImages([]);
    } else if (imgs.length) {
      setImages((old) => [...old, ...imgs.filter((f) => !old.some((x) => x.id === f.id))]);
      setPdfFile(null);
    }
    refreshFiles();
  };

  const addMoreImages = async (list: File[]) => {
    if (!list.length) return;
    try {
      const r = await uploadFiles(list);
      await refreshFiles();
      setImages((old) => [...old, ...r.files.filter((f) => f.kind === "image" && !old.some((x) => x.id === f.id))]);
    } catch (e) { toast(`添加失败：${(e as Error).message}`, true); }
  };

  const pickMoreImages = async () => {
    try {
      const r = await pickPdfsNative("convert");
      if (r === null) { imageInputRef.current?.click(); return; }
      if (r.cancelled) return;
      if (r.errors.length) toast(`部分文件未能打开：${r.errors[0]}`, true);
      if (r.files.some((f) => f.kind !== "image")) toast("这里只能添加图片。", true);
      await refreshFiles();
      setImages((old) => [...old, ...r.files.filter((f) => f.kind === "image" && !old.some((x) => x.id === f.id))]);
    } catch (e) { toast(`添加失败：${(e as Error).message}`, true); }
  };

  const moveImage = (from: number | null, to: number) => {
    if (from === null || from === to || from < 0 || to < 0 || to >= images.length) return;
    setImages((old) => { const n = [...old]; n.splice(to, 0, ...n.splice(from, 1)); return n; });
  };

  const runPdf = async () => {
    const t = await pdfJob.run();
    if (t?.status === "done") await refreshFiles();
  };
  const runImages = async () => {
    const t = await imgJob.run();
    if (t?.status === "done") await refreshFiles();
  };

  const pct = Math.round((pdfJob.task?.progress || imgJob.task?.progress || 0) * 100);
  const doneFiles = pdfJob.done?.status === "done" ? (pdfJob.done.result?.files as FileEntry[]) || [] : [];
  const doneImage = imgJob.done?.status === "done" ? (imgJob.done.result?.file as FileEntry | undefined) : undefined;
  const preview = imageMode ? imgJob.preview : pdfJob.preview;
  const previewError = imageMode ? imgJob.previewError : pdfJob.previewError;
  const runError = imageMode ? imgJob.runError : pdfJob.runError;
  const runJob = imageMode ? runImages : runPdf;
  const outCount = preview?.outputs?.length || 0;
  const targetLabel = imageMode
    ? `1 个 PDF · ${preview?.outputs?.[0]?.pages ?? images.length} 页`
    : target === "txt" ? `${outCount} 个 TXT 文本`
    : target === "md" ? `${outCount} 个 Markdown 文件`
    : target === "docx" ? `${outCount} 个 Word 文档`
    : target === "pptx" ? `${outCount} 个 PPT 演示`
    : target === "xlsx" ? `${outCount} 个 Excel 表格`
    : target === "csv" ? `${outCount} 个 CSV 表格`
    : `${outCount} 张 ${target.toUpperCase()} 图片`;

  return (
    <div className="task-pad rise">
      <p className="page-kicker">转换 / 独立任务</p>
      <h1 className="page-title">{imageMode ? "图片转 PDF" : "转换文件"}</h1>
      <p className="page-lead">{imageMode
        ? "缩略图序号就是 PDF 页序；先排序、删除并核对，再生成。"
        : "从首页进入转换标签，设置格式和输出后再执行；阅读菜单只属于 PDF 标签。"}</p>

      <div className="task-grid">
        <section className="task-main-card">
          <h2>{imageMode ? "图片与页序" : "转换设置"}</h2>
          {!pdfFile && !images.length && (
            <DropZone accept=".pdf,.png,.jpg,.jpeg" formats="PDF 或 PNG/JPG（可多张图片）"
                      note="PDF 单选转换；多张图片合成一个 PDF，二者分开进行"
                      onAdded={added} />
          )}

          {imageMode && (
            <div className="image-preview-grid" aria-label="图片页序预览">
              {images.map((f, i) => (
                <div key={f.id} className="image-preview-tile"
                     draggable={!busy} onDragStart={() => setDragged(i)}
                     onDragOver={(e) => e.preventDefault()}
                     onDrop={(e) => { e.preventDefault(); moveImage(dragged, i); setDragged(null); }}
                     onDragEnd={() => setDragged(null)}>
                  <div className="image-preview-art">
                    <img src={rawUrl(f.id)} alt={`${f.name} 预览`} loading="lazy" />
                    <span>{String(i + 1).padStart(2, "0")}</span>
                  </div>
                  <div className="image-preview-meta"><strong title={f.name}>{f.name}</strong><small>{fmtSize(f.size)}</small></div>
                  <div className="image-preview-actions">
                    <button type="button" disabled={busy || i === 0} onClick={() => moveImage(i, i - 1)} aria-label={`上移 ${f.name}`}>↑</button>
                    <button type="button" disabled={busy || i === images.length - 1} onClick={() => moveImage(i, i + 1)} aria-label={`下移 ${f.name}`}>↓</button>
                    <button type="button" disabled={busy} onClick={() => setImages((old) => old.filter((x) => x.id !== f.id))} aria-label={`移除 ${f.name}`}>×</button>
                  </div>
                </div>
              ))}
              <button ref={imageDropRef} type="button" className="image-add-tile" style={{ background: "transparent" }} disabled={busy} onClick={pickMoreImages}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void addMoreImages(Array.from(e.dataTransfer.files)); }}>＋ 继续添加</button>
              <input ref={imageInputRef} type="file" hidden multiple accept=".png,.jpg,.jpeg"
                     onChange={(e) => { addMoreImages(Array.from(e.target.files || [])); e.target.value = ""; }} />
            </div>
          )}

          {pdfFile && !images.length && (
            <>
              <div className="convert-file-row">
                <div className="merge-row-copy">
                  <strong title={pdfFile.name}>{pdfFile.name}</strong>
                  <small>{pdfFile.pages || "?"} 页 · 已选择</small>
                </div>
                <button type="button" className="merge-remove" aria-label="移除文件" onClick={() => setPdfFile(null)}>×</button>
              </div>

              <span className="convert-label">目标格式</span>
              <div className="fmt-cards" role="radiogroup" aria-label="目标格式">
                {FORMAT_CARDS.map((f) => {
                  const { available, note } = targetAvail(f.id);
                  return (
                    <button type="button" key={f.id} role="radio" aria-checked={target === f.id}
                            disabled={!available}
                            title={available ? undefined : note || "当前环境不可用"}
                            className={"fmt-card" + (target === f.id ? " on" : "")}
                            onClick={() => setTarget(f.id)}>
                      <strong>{f.label}</strong><small>{available ? f.sub : (note || "当前环境不可用")}</small>
                    </button>
                  );
                })}
              </div>

              <span className="convert-label">页码范围</span>
              <input className="input" value={pages} aria-label="页码范围" onChange={(e) => setPages(e.target.value)}
                     placeholder={`全部页面 · 共 ${pdfFile.pages || "?"} 页；或输入 2-5,8`} />
              {(target === "png" || target === "jpg" || target === "pptx") && (
                <select className="input" style={{ marginTop: 8 }} value={dpi} aria-label="清晰度"
                        onChange={(e) => setDpi(Number(e.target.value))}>
                  <option value={96}>清晰度 · 标准（96 DPI）</option>
                  <option value={150}>清晰度 · 高（150 DPI）</option>
                  <option value={300}>清晰度 · 印刷（300 DPI）</option>
                </select>
              )}
              <p className="task-card-note">转换在本机进行，原文件保持不变。</p>
            </>
          )}
        </section>

        <aside className="task-side-card">
          <h2>输出预览</h2>

          {doneFiles.length || doneImage ? (
            <div className="convert-done" role="status">
              <h3>{doneImage ? "已合成 PDF" : `转换完成 · ${doneFiles.length} 个文件`}</h3>
              <p>{(doneImage || doneFiles[0]).name}{(doneImage || doneFiles[0]).path ? ` · ${(doneImage || doneFiles[0]).path}` : ""}</p>
              <p>原文件保持不变，结果已另存。</p>
              <div className="pages-save-actions">
                <button type="button" className="btn" onClick={() => openPath({ id: (doneImage || doneFiles[0]).id }).catch(() => {})}>打开结果位置</button>
                {doneImage && <button type="button" className="btn primary" onClick={() => openFile(doneImage)}>打开阅读</button>}
              </div>
              <button type="button" className="btn sm ghost" onClick={() => {
                const activeJob = imageMode ? imgJob : pdfJob;
                activeJob.reset();
                activeJob.setParams({ ...activeJob.params });
              }}
                      style={{ marginTop: 8 }}>再转换一次</button>
            </div>
          ) : busy ? (
            <div className="convert-running" role="status">
              <h3>{(imageMode ? imgJob : pdfJob).submitting ? "正在提交任务…" : (imageMode ? imgJob : pdfJob).task ? `${imageMode ? "合成中" : "转换中"} · ${swordPct((imageMode ? imgJob : pdfJob).task || {})}` : (imageMode ? "合成中" : "转换中")}</h3>
              {!(imageMode ? imgJob : pdfJob).submitting && (() => { const j = imageMode ? imgJob : pdfJob; return <SwordProgress value={j.task?.progress || 0} unknown={j.task?.progressKnown === false} label={imageMode ? "图片合成 PDF" : "转换文件"} />; })()}
              <button type="button" className="btn sm" onClick={() => (imageMode ? imgJob.cancel() : pdfJob.cancel())}
                      disabled={!(imageMode ? imgJob.task : pdfJob.task)?.id || (imageMode ? imgJob.task : pdfJob.task)?.status === "cancelling"}>取消</button>
            </div>
          ) : (
            <>
              <p className="merge-estimate">{targetLabel}</p>
              {!imageMode && (target === "png" || target === "jpg") && outCount > 0 && (
                <div className="convert-tiles" aria-hidden="true">
                  {preview?.outputs.slice(0, 3).map((output, i) => (
                    <span className="convert-tile" key={output.name}>第 {Number(output.name.match(/-p(\d+)\.[^.]+$/i)?.[1] || i + 1)} 页</span>
                  ))}
                </div>
              )}
              {previewError && <p className="wf-error">{previewError}</p>}
              {preview && !preview.ok && preview.error && <p className="wf-error">{preview.error}</p>}
              {preview?.warnings?.map((w, i) => <p key={i} className="wf-warn">⚠ {w}</p>)}

              {imageMode ? (
                <>
                  <label className="field"><span>输出文件名</span>
                    <input className="input" value={outName} onChange={(e) => setOutName(e.target.value)} aria-label="输出文件名" />
                  </label>
                  <p className="note">缩略图当前顺序 = 新 PDF 页序；删除与排序只影响本次任务，原图不变。</p>
                </>
              ) : (
                <>
                  <label className="field"><span>文件名前缀</span>
                    <input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label="文件名前缀" />
                  </label>
                </>
              )}
              <div className="field"><span>保存位置</span>
                <SaveLocationSelect mode={imageMode ? imgSaveMode : pdfSaveMode} customDir={imageMode ? imgDir : pdfDir}
                                    onMode={imageMode ? setImgSaveMode : setPdfSaveMode} onCustomDir={imageMode ? setImgDir : setPdfDir} />
                {(imageMode ? imgSaveMode : pdfSaveMode) === "source" && (imageMode ? images[0]?.source_dir : pdfFile?.source_dir) && (
                  <p className="save-dir-hint">{imageMode ? images[0]?.source_dir : pdfFile?.source_dir}</p>
                )}
              </div>
              {preview?.outputs?.length ? <p className="convert-preview">输出预览：{preview.outputs[0].name}{preview.outputs.length > 1 ? ` 至 ${preview.outputs[preview.outputs.length - 1].name} · 共 ${preview.outputs.length} 个` : ""} · {preview.dir}</p> : null}
              {runError && <p className="wf-error">{runError}</p>}
              <button type="button" className="convert-run" disabled={!preview?.ok || busy}
                      onClick={runJob}>
                {imageMode ? "开始合成 →" : "开始转换 →"}
              </button>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
