import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { get, post } from "./api";
import type { FileEntry } from "./types";

type DropResult = { id: string; files: FileEntry[]; errors: string[] };
type DropStart = { id: string; physicalX: number; physicalY: number; at: number };
type Target = { element: HTMLElement; epoch: number; at: number; x: number; y: number; deliver: (result: DropResult) => void };

const targets = new Map<string, Target>();
const earlyResults = new Map<string, DropResult>();
const DROP_TIMEOUT_MS = 10 * 60 * 1000;
let navigationEpoch = 0;
let lastSurfaceChange = 0;

function targetIsCurrent(target: Target): boolean {
  if (target.epoch !== navigationEpoch || target.at <= lastSurfaceChange || !target.element.isConnected || !target.element.getClientRects().length) return false;
  const hit = document.elementFromPoint(target.x, target.y);
  return !!hit && target.element.contains(hit);
}

function deliver(result: DropResult) {
  const target = targets.get(result.id);
  if (!target) {
    earlyResults.set(result.id, result);
    window.setTimeout(() => earlyResults.delete(result.id), DROP_TIMEOUT_MS);
    return;
  }
  targets.delete(result.id);
  if (!targetIsCurrent(target)) return;
  target.deliver(result);
}

async function acceptTarget(id: string) {
  let delay = 300;
  while (true) {
    const target = targets.get(id);
    if (!target || !targetIsCurrent(target)) { targets.delete(id); return; }
    try {
      const reply = await post<{ accepted: boolean; expired?: boolean }>("/api/desktop/drop-accept", { id });
      if (reply.accepted) return;
      if (reply.expired) {
        deliver({ id, files: [], errors: ["拖入文件已过期，请重试。"] });
        return;
      }
    } catch (error) {
      if (targets.has(id)) deliver({ id, files: [], errors: [`无法接收拖入文件：${(error as Error).message}`] });
      return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2000);
  }
}

/** 桌面壳只通知 ID 与物理坐标；真实路径仅经其私有输入通道登记。 */
export function startNativeDropBridge() {
  const onStart = (event: Event) => {
    const detail = (event as CustomEvent<DropStart>).detail;
    if (!detail || typeof detail.id !== "string" || !Number.isFinite(detail.physicalX) || !Number.isFinite(detail.physicalY)
        || !Number.isFinite(detail.at) || detail.at <= lastSurfaceChange || detail.at > Date.now() + 1000
        || Date.now() - detail.at > DROP_TIMEOUT_MS) return;
    const scale = window.devicePixelRatio || 1;
    const x = detail.physicalX / scale;
    const y = detail.physicalY / scale;
    const hit = document.elementFromPoint(x, y);
    hit?.dispatchEvent(new CustomEvent("zhanlu:native-drop-target", { bubbles: true, detail: { id: detail.id, at: detail.at, x, y } }));
  };
  const onNavigation = () => { navigationEpoch++; lastSurfaceChange = Date.now(); targets.clear(); };
  const hasDialog = (node: Node) => node instanceof Element && (node.matches('[role="dialog"]') || !!node.querySelector('[role="dialog"]'));
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.type === "attributes"
      ? m.target instanceof Element && m.target.matches('[role="dialog"], .task-tab-pane')
      : [...m.addedNodes, ...m.removedNodes].some(hasDialog))) {
      lastSurfaceChange = Date.now();
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("zhanlu:native-drop-start", onStart);
  window.addEventListener("hashchange", onNavigation);
  let alive = true;
  let timer: number | undefined;
  const poll = async () => {
    try {
      const result = await get<{ drops: DropResult[] }>("/api/desktop/drop-files");
      if (alive) (result.drops || []).forEach(deliver);
    } catch { /* 引擎暂不可用，下一次继续轮询 */ }
    if (alive) timer = window.setTimeout(poll, 300);
  };
  void poll();
  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
    window.removeEventListener("zhanlu:native-drop-start", onStart);
    window.removeEventListener("hashchange", onNavigation);
    observer.disconnect();
    targets.clear();
    earlyResults.clear();
  };
}

/** 绑定落点和组件实例；切换页面、隐藏任务或卸载后不会把迟到结果送到别处。 */
export function useNativeDrop<T extends HTMLElement>(ref: RefObject<T | null>, onDrop: (result: DropResult) => void, targetState?: unknown) {
  const latest = useRef(onDrop);
  latest.current = onDrop;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const mountedAt = Date.now();
    const onTarget = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; at: number; x: number; y: number }>).detail;
      const id = detail?.id;
      if (!id || detail.at < mountedAt) return;
      event.stopPropagation();
      const callback = latest.current;
      targets.set(id, { element, epoch: navigationEpoch, at: detail.at, x: detail.x, y: detail.y, deliver: callback });
      // 只发送不含路径的随机 ID；桌面壳的私有输入在获得确认后才登记文件。
      void acceptTarget(id);
      const early = earlyResults.get(id);
      if (early) { earlyResults.delete(id); deliver(early); }
      window.setTimeout(() => {
        if (targets.has(id)) deliver({ id, files: [], errors: ["处理拖入文件超时，请重试。"] });
      }, DROP_TIMEOUT_MS);
    };
    element.addEventListener("zhanlu:native-drop-target", onTarget);
    return () => {
      element.removeEventListener("zhanlu:native-drop-target", onTarget);
      for (const [id, target] of targets) if (target.element === element) targets.delete(id);
    };
  }, [ref, targetState]);
}
