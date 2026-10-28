import React, { useEffect, useRef, useState } from "react";
import { pickFolder } from "./api";

export type SaveMode = "default" | "source" | "custom";

/** 06 改版 109：保存位置选择框。展开顺序＝应用输出目录 → 与源文件同目录 → 选择其他位置…；
 * 方向键选择、Enter／空格确认、Esc 关闭并返回选择框；系统目录选择取消时保留此前选择。 */
export default function SaveLocationSelect({ mode, customDir, onMode, onCustomDir }: {
  mode: SaveMode;
  customDir: string | null;
  onMode: (m: SaveMode) => void;
  onCustomDir: (dir: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const OPTIONS: { key: SaveMode | "browse"; text: string }[] = [
    { key: "default", text: "应用输出目录" },
    { key: "source", text: "与源文件同目录" },
    { key: "browse", text: "选择其他位置…" },
  ];
  const indexOfMode = mode === "source" ? 1 : mode === "custom" ? 2 : 0;
  const valueText = mode === "source" ? "与源文件同目录" : mode === "custom" && customDir ? shortDir(customDir) : "应用输出目录";

  const close = (focus = true) => {
    setOpen(false);
    if (focus) btnRef.current?.focus();
  };

  const choose = async (key: SaveMode | "browse") => {
    if (key === "browse") {
      setBusy(true);
      try {
        const r = await pickFolder();
        if (!r.cancelled && r.path) {
          onCustomDir(r.path);
          onMode("custom");
          close();
        }
      } catch (e) {
        alert(`无法打开目录选择：${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    onMode(key);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="save-select" ref={wrapRef}>
      <button ref={btnRef} type="button" className="save-btn" aria-haspopup="listbox"
              aria-expanded={open} aria-label={`保存位置，当前${valueText}${busy ? "，正在选择目录" : ""}`}
              onClick={() => {
                if (open) close(false);
                else { setOpen(true); setActive(indexOfMode); }
              }}
              onKeyDown={(e) => {
                if (!open) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpen(true);
                    setActive(indexOfMode);
                  }
                  return;
                }
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % OPTIONS.length); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a + OPTIONS.length - 1) % OPTIONS.length); }
                else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void choose(OPTIONS[active].key); }
                else if (e.key === "Escape") { e.preventDefault(); close(); }
                else if (e.key === "Tab") close(false);
              }}>
        <span className="val">{busy ? "正在选择目录…" : valueText}</span>
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="save-menu" role="listbox" aria-label="保存位置">
          {OPTIONS.map((o, i) => (
            <li key={o.key} id={`save-opt-${i}`} role="option" tabIndex={-1} aria-selected={o.key === mode}
                className={"save-item" + (i === active ? " act" : "") + (o.key === mode ? " sel" : "")}
                onMouseEnter={() => setActive(i)}
                onClick={() => void choose(o.key)}>
              <span className="ck" aria-hidden="true">{o.key === mode ? "✓" : ""}</span>{o.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function shortDir(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return dir;
  return `…/${parts.slice(-2).join("/")}`;
}
