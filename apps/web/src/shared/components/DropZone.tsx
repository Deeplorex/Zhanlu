import React, { useRef, useState } from "react";
import { uploadFiles } from "../api";
import { pickPdfsNative } from "../nativeOpen";
import { useNativeDrop } from "../nativeDrag";
import type { FileEntry } from "../types";

/** 拖拽 / 点击上传，登记后回调。 */
export default function DropZone({ multiple = true, accept = ".pdf", formats = "PDF", onAdded, note }: {
  multiple?: boolean;
  accept?: string;
  formats?: string;
  onAdded: (files: FileEntry[]) => void;
  note?: string;
}) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useNativeDrop(dropRef, (result) => {
    if (result.errors.length) alert(`部分文件未能打开：${result.errors[0]}`);
    const allowed = result.files.filter((f) => f.kind === "pdf" || (accept.includes(".png") && f.kind === "image"));
    if (allowed.length !== result.files.length) alert("请选择支持的文件格式。");
    if (allowed.length) onAdded(multiple ? allowed : allowed.slice(0, 1));
  });

  const add = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    setBusy(true);
    try {
      const r = await uploadFiles(arr);
      onAdded(r.files || []);
    } catch (e) {
      alert(`添加失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    setBusy(true);
    try {
      const r = await pickPdfsNative(accept.includes(".png") ? "convert" : "pdf");
      if (r === null) { inputRef.current?.click(); return; }
      if (r.errors.length) alert(`部分文件未能打开：${r.errors[0]}`);
      if (!r.cancelled) onAdded(multiple ? r.files : r.files.slice(0, 1));
    } catch (e) {
      alert(`无法打开文件选择：${(e as Error).message}`);
    } finally { setBusy(false); }
  };

  return (
    <div ref={dropRef}
      className={"dropzone" + (over ? " over" : "") + (busy ? " busy" : "")}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
    >
      <button type="button" disabled={busy} onClick={pick}>
        {busy ? "正在加入…" : <>从本机选择{formats}文件<span>或拖拽到此处</span></>}
      </button>
      {note && <small>{note}</small>}
      <input ref={inputRef} type="file" hidden multiple={multiple} accept={accept}
             onChange={(e) => { add(e.target.files || []); e.target.value = ""; }} />
    </div>
  );
}
