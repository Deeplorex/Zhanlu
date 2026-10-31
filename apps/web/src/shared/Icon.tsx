import React from "react";

/** assets/icons 的矢量（24×24 · 1.8 描边 · 圆角端点 · currentColor），
 *  按 Figma 06 画板 59–67 接入模式行、工具栏与窄窗口导航。print 为 2026-10-26 补齐组件。 */
export type IconName =
  | "read" | "pages" | "convert" | "search" | "ai" | "split" | "merge"
  | "images" | "output" | "print" | "trash" | "markdown" | "expand" | "play";

const PATHS: Record<IconName, React.ReactNode> = {
  read: (
    <>
      <path d="M12 6.5c-2.3-1.6-5-1.9-8-1.2v12.1c3-.7 5.7-.4 8 1.2 2.3-1.6 5-1.9 8-1.2V5.3c-3-.7-5.7-.4-8 1.2Z" />
      <path d="M12 6.5v12.1M6.5 9.5c1.2-.1 2.2 0 3 .4M14.5 9.9c.8-.4 1.8-.5 3-.4" />
    </>
  ),
  pages: (
    <>
      <rect x="4" y="5" width="7" height="14" rx="1.5" /><rect x="13" y="5" width="7" height="14" rx="1.5" />
      <path d="M6.5 9h2M15.5 9h2M6.5 12h2M15.5 12h2" />
    </>
  ),
  convert: <path d="M4 8h14l-3-3M18 8l-3 3M20 16H6l3-3M6 16l3 3" />,
  search: (
    <>
      <circle cx="10.7" cy="10.7" r="6.4" /><path d="m15.5 15.5 4.6 4.6" />
    </>
  ),
  ai: (
    <>
      <path d="m12 2.5 1.8 5.7L19.5 10l-5.7 1.8L12 17.5l-1.8-5.7L4.5 10l5.7-1.8L12 2.5Z" />
      <path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" />
    </>
  ),
  split: (
    <>
      <path d="M8 3H5.5A1.5 1.5 0 0 0 4 4.5v15A1.5 1.5 0 0 0 5.5 21H8M16 3h2.5A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M12 4v3m0 3v4m0 3v3M8 12 5.5 9.5M8 12l-2.5 2.5M16 12l2.5-2.5M16 12l2.5 2.5" />
    </>
  ),
  merge: (
    <>
      <path d="M4 4h5v6H4zM15 4h5v6h-5zM9 17h6v4H9z" />
      <path d="M6.5 10v2.5c0 2.5 5.5 2 5.5 4.5M17.5 10v2.5c0 2.5-5.5 2-5.5 4.5" />
    </>
  ),
  images: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8" cy="9" r="1.5" />
      <path d="m4 17 5-5 3.5 3 3-3L21 18" />
    </>
  ),
  output: <path d="M12 3v11m0 0-4-4m4 4 4-4M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15" />,
  print: (
    <>
      <path d="M7 8V3h10v5M7 17H4V9h16v8h-3" />
      <path d="M17 11h.01M7 14h10v7H7v-7Z" />
    </>
  ),
  trash: (
    <>
      <path d="M5 7h14M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      <path d="M7 7l.7 12.1a1.5 1.5 0 0 0 1.5 1.4h5.6a1.5 1.5 0 0 0 1.5-1.4L17 7M10.5 11v6M13.5 11v6" />
    </>
  ),
  markdown: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M6 15V9l3 3 3-3v6M17 9v6m-2-2 2 2 2-2" />
    </>
  ),
  expand: <path d="M4 9.5V4h5.5M20 9.5V4h-5.5M4 14.5V20h5.5M20 14.5V20h-5.5" />,
  play: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="m10.4 7.8 4.4 2.7-4.4 2.7V7.8Z" />
      <path d="M8.5 20.5h7" />
    </>
  ),
};

export default function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
