import React from "react";

/** 仓库 SVG 是唯一图标源：24×24、1.8 描边、圆角端点、currentColor。 */
export type IconName =
  | "read" | "pages" | "convert" | "search" | "ai" | "split" | "merge"
  | "images" | "output" | "print" | "trash" | "markdown" | "expand" | "play"
  | "file" | "text" | "word" | "table" | "chevron-left" | "chevron-right"
  | "plus" | "minus" | "shrink" | "rotate";

const sources = import.meta.glob<string>("../../../../assets/icons/*.svg", {
  query: "?raw", import: "default", eager: true,
});
const glyphs = Object.fromEntries(Object.entries(sources).map(([path, svg]) => [
  path.split("/").pop()!.replace(/\.svg$/, ""),
  svg.replace(/^[\s\S]*?<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, ""),
]));

export default function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
         dangerouslySetInnerHTML={{ __html: glyphs[name] }} />
  );
}
