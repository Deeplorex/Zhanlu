import React, { useId } from "react";

/**
 * 湛卢剑形进度条（Figma 20261027/Sword progress / Blade · 方案 B）。
 * 剑柄固定（墨黑 + 铜色剑首），剑身自剑格向剑尖按真实比例填充铜色；
 * 剑身为独立进度图形（暖灰轨道 + 细轮廓 + 剑尖收角），不拉伸方形主标。
 * 已知数值映射 0…1 → 0…100%，过渡约 200ms；unknown=true 时剑身显示静态短高光，
 * 不提供虚构百分比（ARIA 省略 valuenow）。遵循系统"减少动态效果"。
 */
export default function SwordProgress({ value, unknown = false, label, text, className }: {
  value: number;
  unknown?: boolean;
  label: string;
  text?: React.ReactNode;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const known = !unknown;
  const pct = known ? Math.max(0, Math.min(100, Math.round(value * 100))) : 0;
  return (
    <div className={"sword-progress" + (known ? "" : " unknown") + (className ? " " + className : "")}
         role="progressbar" aria-label={label}
         aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined}
         aria-valuenow={known ? pct : undefined}
         aria-valuetext={known ? `${pct}%` : "进度无法估算"}>
      <span className="sword" aria-hidden="true">
        <i className="sword-pommel" />
        <i className="sword-grip" />
        <i className="sword-guard" />
        <svg className="sword-blade" viewBox="0 0 100 10" preserveAspectRatio="none" focusable="false">
          <defs>
            <clipPath id={`blade${uid}`}>
              <path d="M0 0 H94 L100 5 L94 10 H0 Z" />
            </clipPath>
          </defs>
          <path d="M0 0 H94 L100 5 L94 10 H0 Z" className="sword-track"
                vectorEffect="non-scaling-stroke" />
          <g clipPath={`url(#blade${uid})`}>
            <rect className="sword-fill" x="0" y="0" width={known ? `${pct}%` : "0%"} height="10" />
            {!known && <rect className="sword-hl" x="42" y="0" width="16" height="10" />}
          </g>
        </svg>
      </span>
      {text != null && <span className="sword-text">{text}</span>}
    </div>
  );
}

/** 进度文案：未知 → 「进度无法估算」；已知 → 「N%」；处理 100% 但未完成 → 等待任务完成 */
export function swordPct(task: { progress?: number; progressKnown?: boolean }): string {
  if (task.progressKnown === false) return "进度无法估算";
  return `${Math.round(Math.max(0, Math.min(1, task.progress || 0)) * 100)}%`;
}

/** 处理中 100% 不等于完成：无明确保存阶段时如实显示等待 */
export function swordRunningText(task: { progress?: number; progressKnown?: boolean }): string {
  if (task.progressKnown === false) return "正在处理 · 进度无法估算";
  const pct = Math.round((task.progress || 0) * 100);
  return pct >= 100 ? "处理 100% · 等待任务完成" : `${pct}%`;
}
