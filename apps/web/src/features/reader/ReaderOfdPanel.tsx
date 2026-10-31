import React, { useEffect, useState } from "react";
import { openPath } from "../../shared/api";
import SaveLocationSelect, { type SaveMode } from "../../shared/SaveLocationSelect";
import { useJob } from "../../shared/workflow";
import SwordProgress, { swordRunningText } from "../../shared/SwordProgress";
import type { FileEntry } from "../../shared/types";
import Icon from "../../shared/Icon";
import { AppCtx } from "../../app/AppContext";

/** OFD 专属右栏（v0.2 M3）：另存为 PDF——保存位置三选、文件名、交付核对，与阅读内转换右栏同规格。 */
export default function ReaderOfdPanel({ file, refreshFiles }: {
  file: FileEntry;
  refreshFiles: () => Promise<void>;
}) {
  const { openFile, toast } = React.useContext(AppCtx);
  const job = useJob("convert_ofd");
  const [name, setName] = useState(() => file.name.replace(/\.ofd$/i, "") + "-转换");
  const [saveMode, setSaveMode] = useState<SaveMode>("default");
  const [customDir, setCustomDir] = useState<string | null>(null);
  const dirParam = saveMode === "source" ? "@source" : saveMode === "custom" && customDir ? customDir : undefined;

  useEffect(() => {
    job.setParams({ id: file.id, name, dir: dirParam });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, name, dirParam]);

  const run = async () => {
    const done = await job.run();
    if (done?.status === "done") await refreshFiles();
  };
  const again = () => {
    job.reset();
    job.setParams({ id: file.id, name, dir: dirParam });
  };

  const finished = job.done?.status === "done" ? (job.done.result?.files || [])[0] as FileEntry | undefined : undefined;
  const note = job.done?.status === "done" ? String((job.done.result as { note?: string })?.note || "") : "";
  const out = job.preview?.outputs?.[0];
  const saveError = job.previewError || (job.preview && !job.preview.ok ? job.preview.error : null);

  return (
    <aside className="convert-panel" aria-label="另存为 PDF">
      <div className="convert-scroll">
        <div className="convert-head">
          <h2>另存为 PDF</h2>
          <p className="convert-source" title={file.name}>{file.name}</p>
        </div>

        {finished ? (
          <div className="convert-done" role="status">
            <h3>已另存 PDF</h3>
            <p title={finished.path}>{finished.name}</p>
            {finished.path && <p className="note">{finished.path}</p>}
            <p className="note" title={note}>{note || "版式级转换完成"}</p>
            <div className="pages-save-actions">
              <button type="button" className="btn" onClick={() => openPath({ id: finished.id }).catch((e) => toast(`无法打开位置：${(e as Error).message}`, true))}>打开结果位置</button>
              <button type="button" className="btn primary" onClick={() => openFile(finished)}>打开阅读</button>
              <button type="button" className="btn" onClick={again}>再次另存</button>
            </div>
          </div>
        ) : job.busy ? (
          <div className="convert-running" role="status">
            <h3>{job.submitting ? "正在提交转换任务…" : job.task ? swordRunningText(job.task) : "转换中"}</h3>
            {!job.submitting && (
              <SwordProgress value={job.task?.progress || 0} unknown={job.task?.progressKnown === false}
                             label={`转换 ${file.name}`} />
            )}
            <p className="note">可继续阅读预览，任务在后台进行。</p>
            <button type="button" className="btn sm" onClick={() => job.cancel()} disabled={!job.task?.id || job.task.status === "cancelling"}>取消</button>
          </div>
        ) : (
          <>
            <div className="convert-fixed" role="status">
              <strong><Icon name="file" /> PDF (.pdf)</strong>
              <p className="note">沿用当前预览，电子签章暂不渲染；请核对版式。</p>
            </div>

            <div className="cfield">
              <span className="convert-label">文件名（不含扩展名）</span>
              <input className="input" value={name} aria-label="输出文件名" onChange={(e) => setName(e.target.value)} />
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
              {out && <p className="convert-preview">输出预览：{out.name}</p>}
              <button type="button" className="convert-run" disabled={!job.preview?.ok} onClick={run}>
                开始另存 →
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
