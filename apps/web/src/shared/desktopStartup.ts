declare global {
  interface Window {
    /** 只由桌面壳注入；浏览器运行不需要此回执。 */
    __ZHANLU_STARTUP__?: (phase: "loading" | "ready" | "error", message?: string) => Promise<void>;
  }
}

export function desktopStartup(phase: "loading" | "ready" | "error", message?: string) {
  void window.__ZHANLU_STARTUP__?.(phase, message).catch(error => {
    console.error("桌面启动回执失败", error);
  });
}
