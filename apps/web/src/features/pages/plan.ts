/**
 * 页面整理草稿（06 改版 137–168）：网格位置、源页引用与页面实例 ID 分开记录。
 * 位置＝数组顺序（页码与插入点都按它算）；源页引用只用于取真实缩略图和另存；
 * 实例 ID 用于选区、拖动、焦点和撤销——复制分配新 ID，此后旋转与删除各自独立。
 * 本模块不依赖 React，规则可单测。
 */

export type PageSource =
  /** 当前 PDF 的第 page 页（1-based） */
  | { kind: "doc"; page: number }
  /** 已登记的导入 PDF（文件 id）的第 page 页 */
  | { kind: "import"; file: string; page: number; name: string }
  /** 空白页，尺寸单位 pt */
  | { kind: "blank"; width: number; height: number };

export interface PageInstance {
  id: string;
  source: PageSource;
  /** 待应用旋转，0/90/180/270 */
  rotate: number;
  /** 副本：由「复制页」生成，或从当前文档自身插入 */
  copy: boolean;
  /** 被「移动」挪过的实例（当前文档页在卡片上显示「原第 N 页」） */
  moved: boolean;
}

export type ChangeKind = "insert" | "blank" | "copy" | "move" | "rotate" | "delete";
export interface Change { kind: ChangeKind; n: number }

/** 模块实例前缀：实例 ID 只需在本份草稿内唯一；带上随机前缀后，即使模块被重新加载（开发态热更新）
 *  计数器归零，也不会与已有实例的 ID 相撞。 */
const idPrefix = Math.random().toString(36).slice(2, 7);
let counter = 0;

export function newId(): string {
  counter += 1;
  return `${idPrefix}${counter.toString(36)}`;
}

/** 归一化到 0/90/180/270（左转累计会出现负角度） */
export function norm(rotate: number): number {
  return ((Math.round(rotate) % 360) + 360) % 360;
}

/** 待应用旋转的可读方向（131：页码旁的「右转 90°」）；未旋转时为空 */
export function rotateLabel(rotate: number): string {
  const deg = norm(rotate);
  return deg === 90 ? "右转 90°" : deg === 180 ? "旋转 180°" : deg === 270 ? "左转 90°" : "";
}

function make(source: PageSource, rotate = 0, flags: Partial<Pick<PageInstance, "copy" | "moved">> = {}): PageInstance {
  return { id: newId(), source, rotate: norm(rotate), copy: false, moved: false, ...flags };
}

/** 空白页实例：沿用参考页的显示宽高（pt） */
export function makeBlank(width: number, height: number): PageInstance {
  return make({ kind: "blank", width, height });
}

/** 默认输出名：原文件名 + 「-整理.pdf」 */
export function defaultName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "") + "-整理.pdf";
}

/** 打开文档时的草稿：原页序，每页一个实例 */
export function initialPlan(total: number): PageInstance[] {
  return Array.from({ length: total }, (_, i) => make({ kind: "doc", page: i + 1 }));
}

/** 引擎任务计划：去掉实例 ID 与显示标记。当前文档页沿用既有 {page, rotate} 条目 */
export function toJobPlan(plan: PageInstance[]): Record<string, unknown>[] {
  return plan.map((it) => {
    const s = it.source;
    const rotate = norm(it.rotate);
    if (s.kind === "blank") return { blank: true, width: s.width, height: s.height, rotate };
    if (s.kind === "import") return { file: s.file, page: s.page, rotate };
    return { page: s.page, rotate };
  });
}

/** 内容签名：只看各实例的来源与旋转及其顺序，不含实例 ID 和显示标记 */
export function contentKey(plan: PageInstance[]): string {
  return plan.map((it) => {
    const s = it.source;
    const base = s.kind === "blank" ? `b:${s.width}x${s.height}` : s.kind === "import" ? `i:${s.file}:${s.page}` : `d:${s.page}`;
    return `${base}@${norm(it.rotate)}`;
  }).join("|");
}

/** 草稿是否就是原始文档（原页序、无新增、无旋转） */
export function isOriginal(plan: PageInstance[], total: number): boolean {
  return plan.length === total && plan.every((it, i) => it.source.kind === "doc" && it.source.page === i + 1 && norm(it.rotate) === 0);
}

/** 两个草稿是否以同一顺序排列同一批实例（移动是否真的改变了顺序） */
export function sameOrder(a: PageInstance[], b: PageInstance[]): boolean {
  return a.length === b.length && a.every((it, i) => it.id === b[i].id);
}

export function selectedIndices(plan: PageInstance[], ids: Set<string>): number[] {
  const out: number[] = [];
  plan.forEach((it, i) => { if (ids.has(it.id)) out.push(i); });
  return out;
}

export function isContiguous(indices: number[]): boolean {
  return indices.length > 0 && indices.every((v, i) => i === 0 || v === indices[i - 1] + 1);
}

/** 锚点到目标的连续闭区间 */
export function rangeBetween(plan: PageInstance[], anchorId: string, targetId: string): Set<string> {
  const a = plan.findIndex((it) => it.id === anchorId);
  const b = plan.findIndex((it) => it.id === targetId);
  if (a < 0 || b < 0) return new Set();
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return new Set(plan.slice(lo, hi + 1).map((it) => it.id));
}

export function insertAt(plan: PageInstance[], at: number, items: PageInstance[]): PageInstance[] {
  const n = [...plan];
  n.splice(Math.max(0, Math.min(at, n.length)), 0, ...items);
  return n;
}

/** 导入 PDF 的若干页（按给定顺序）；来源就是当前文档时生成它的副本 */
export function importInstances(source: FileLike, pages: number[], currentId: string): PageInstance[] {
  return pages.map((page) => source.id === currentId
    ? make({ kind: "doc", page }, 0, { copy: true })
    : make({ kind: "import", file: source.id, page, name: source.name }));
}

export interface FileLike { id: string; name: string }

/** 按网格顺序为每张选中页生成一张副本，整组插到最后一张选中页之后；副本继承当时的旋转。
 *  返回新草稿与新副本的实例 ID（用于选中新副本并把焦点落在第一张）。 */
export function copySelected(plan: PageInstance[], ids: Set<string>): { plan: PageInstance[]; copies: PageInstance[] } | null {
  const idx = selectedIndices(plan, ids);
  if (!idx.length) return null;
  const copies = idx.map((i) => make(plan[i].source, plan[i].rotate, { copy: true }));
  return { plan: insertAt(plan, idx[idx.length - 1] + 1, copies), copies };
}

function markMoved(it: PageInstance): PageInstance {
  return it.moved ? it : { ...it, moved: true };
}

/** 保留选中页的相对顺序，整组移到剩余序列的第 to 个位置（0…剩余页数） */
export function moveTo(plan: PageInstance[], ids: Set<string>, to: number): PageInstance[] {
  const moving = plan.filter((it) => ids.has(it.id)).map(markMoved);
  const rest = plan.filter((it) => !ids.has(it.id));
  const at = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** 连续选区整体上移/下移一位；选区不连续或越界时返回 null（调用方禁用） */
export function shiftSelection(plan: PageInstance[], ids: Set<string>, offset: -1 | 1): PageInstance[] | null {
  const idx = selectedIndices(plan, ids);
  if (!isContiguous(idx)) return null;
  const start = idx[0];
  const end = idx[idx.length - 1];
  if (offset === -1 ? start === 0 : end === plan.length - 1) return null;
  const n = [...plan];
  if (offset === -1) {
    const [prev] = n.splice(start - 1, 1);
    n.splice(end, 0, prev);
  } else {
    const [next] = n.splice(end + 1, 1);
    n.splice(start, 0, next);
  }
  return n.map((it) => (ids.has(it.id) ? markMoved(it) : it));
}

export function rotateSelection(plan: PageInstance[], ids: Set<string>, angle: number): PageInstance[] {
  return plan.map((it) => (ids.has(it.id) ? { ...it, rotate: norm(it.rotate + angle) } : it));
}

/** 从草稿移除选中页；至少保留一页，否则返回 null */
export function removeSelection(plan: PageInstance[], ids: Set<string>): PageInstance[] | null {
  const n = plan.filter((it) => !ids.has(it.id));
  return n.length ? n : null;
}

/** 实例的显示尺寸（pt，已含待应用旋转）；sizes 解析各来源页的纸张尺寸，取不到时返回 null */
export function pageSizeOf(it: PageInstance | undefined, sizes: (src: PageSource) => [number, number] | null | undefined): [number, number] | null {
  if (!it) return null;
  const s = it.source;
  const base: [number, number] | null | undefined = s.kind === "blank" ? [s.width, s.height] : sizes(s);
  if (!base) return null;
  return norm(it.rotate) % 180 ? [base[1], base[0]] : base;
}

interface PositionOption {
  value: string;
  label: string;
  at: number;
  anchor?: PageInstance;
  page?: number;
  side?: "前" | "后";
}

/** 页码取当前网格，插入下标取移走选中页后的序列。保留前后两个选项，便于按明确的参考页操作。 */
export function positionOptions(plan: PageInstance[], moving?: ReadonlySet<string>): PositionOption[] {
  const targets = plan.map((anchor, i) => ({ anchor, page: i + 1 }))
    .filter(({ anchor }) => !moving?.has(anchor.id));
  const out: PositionOption[] = [{ value: "start", label: "文档开头", at: 0, ...targets[0] }];
  targets.forEach(({ anchor, page }, i) => {
    out.push(
      { value: `before-${anchor.id}`, label: `第 ${page} 页前`, at: i, anchor, page, side: "前" },
      { value: `after-${anchor.id}`, label: `第 ${page} 页后`, at: i + 1, anchor, page, side: "后" },
    );
  });
  out.push({ value: "end", label: "文档末尾", at: targets.length, ...targets.at(-1) });
  return out;
}

/** 卡片页码与来源：位置页码在前；导入页与副本同时显示来源（141/153/166）。
 *  「来源 + 旋转」四段时按画板写法约 152 px，超出卡片 130 px 的可用宽度，改用紧凑写法（约 122 px）。 */
export function cardLabel(it: PageInstance, index: number): string {
  const s = it.source;
  const parts = [String(index + 1)];
  const tight: string[] = [String(index + 1)];
  const push = (text: string, compact: string) => { parts.push(text); tight.push(compact); };
  if (s.kind === "blank") push("空白页", "空白页");
  else {
    if (it.copy) push("副本", "副本");
    if (s.kind === "import") push("导入", "导入");
    if (it.copy || it.moved || s.kind === "import") push(`原第 ${s.page} 页`, `原第${s.page}页`);
  }
  const rotated = rotateLabel(it.rotate);
  if (rotated) push(rotated, rotated.replace(/ /g, ""));
  return (parts.length > 3 ? tight : parts).join(parts.length > 3 ? "·" : " · ");
}

/** 实例在提示语中的称呼（「将原第 4 页移到原第 2 页前」） */
export function instanceName(it: PageInstance): string {
  const s = it.source;
  if (s.kind === "blank") return "空白页";
  if (s.kind === "import") return `导入第 ${s.page} 页`;
  return it.copy ? `原第 ${s.page} 页的副本` : `原第 ${s.page} 页`;
}

/** 缩略图来源：当前文档页或导入 PDF 页；空白页没有缩略图 */
export function thumbSource(it: PageInstance, currentId: string): { fileId: string; page: number } | null {
  const s = it.source;
  if (s.kind === "blank") return null;
  return { fileId: s.kind === "import" ? s.file : currentId, page: s.page };
}

/** 页码列表：「1–3、5、8–10」；组数过多时只列前 6 组 */
export function pageListText(numbers: number[]): string {
  const groups: string[] = [];
  let start = numbers[0];
  let prev = numbers[0];
  const flush = () => { groups.push(start === prev ? `${start}` : `${start}–${prev}`); };
  for (const n of numbers.slice(1)) {
    if (n === prev + 1) { prev = n; continue; }
    flush();
    start = prev = n;
  }
  if (numbers.length) flush();
  return groups.length > 6 ? `${groups.slice(0, 6).join("、")}…` : groups.join("、");
}

/** 操作栏左侧的选区说明；全选时附「至少保留 1 页」。
 *  6 页以内逐页列举（138/141：「已选第 5、6 页」），更多时把连续页并为区间并截断 */
export function selectionLabel(plan: PageInstance[], ids: Set<string>): { main: string; note?: string } | null {
  if (!ids.size) return null;
  const pages = selectedIndices(plan, ids).map((i) => i + 1);
  if (pages.length === plan.length) return { main: `已选全部 ${pages.length} 页`, note: "至少保留 1 页" };
  const listed = pages.length <= 6 ? pages.join("、") : pageListText(pages);
  return { main: `已选第 ${listed} 页` };
}

/** 底部变更摘要：最近一步操作 + 当前总页数（141/153/154/166） */
export function describeChange(change: Change, count: number): string {
  switch (change.kind) {
    case "insert": return `插入 ${change.n} 页 · 共 ${count} 页`;
    case "blank": return `插入 ${change.n} 张空白页 · 共 ${count} 页`;
    case "copy": return `复制 ${change.n} 页 · 共 ${count} 页`;
    case "move": return `移动 ${change.n} 页 · 共 ${count} 页`;
    case "rotate": return `旋转 ${change.n} 页 · 共 ${count} 页`;
    case "delete": return `删除 ${change.n} 页 · 共 ${count} 页`;
  }
}

/** 核对另存结果时概括保留在草稿中的变更，已撤销的操作不计入。 */
export function describeOutput(plan: PageInstance[], total: number): string {
  let blank = 0, imported = 0, copied = 0, rotated = 0, moved = 0, kept = 0, previous = 0;
  let reordered = false;
  for (const { source, copy, rotate, moved: wasMoved } of plan) {
    if (wasMoved) {
      moved++;
      if (copy || source.kind !== "doc") reordered = true;
    }
    if (copy) copied++;
    else if (source.kind === "blank") blank++;
    else if (source.kind === "import") imported++;
    else {
      kept++;
      if (source.page < previous) reordered = true;
      previous = source.page;
    }
    if (norm(rotate)) rotated++;
  }
  const dropped = Math.max(0, total - kept);
  return [
    blank ? `插入 ${blank} 张空白页` : "",
    imported ? `插入 ${imported} 页` : "",
    copied ? `复制 ${copied} 页` : "",
    reordered ? (moved === 1 ? "移动 1 页" : "页序已调整") : "",
    rotated ? `旋转 ${rotated} 页` : "",
    dropped ? `删除 ${dropped} 页` : "",
    `共 ${plan.length} 页`,
  ].filter(Boolean).join(" · ");
}
