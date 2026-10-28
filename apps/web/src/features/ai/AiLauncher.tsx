import React from "react";
import { AppCtx } from "../../app/AppContext";

/**
 * 全局湛卢气泡（Figma 59/63/67）：首页与 PDF 工作区右下角的第二个 AI 入口。
 * 墨黑底 + 剑标 + 小对话尾部；Chat 展开后变为关闭图标。与工具栏「AI 阅读」复用同一会话。
 * 转换右面板展开时移到面板左侧（.app[data-convert-open]），不遮挡开始转换与输出字段。
 */
export default function AiLauncher({ home }: { home?: boolean }) {
  const { current, aiOpen, setAiOpen, aiGuideOpen, setAiGuideOpen, aiTriggerRef } = React.useContext(AppCtx);
  const open = home || !current ? aiGuideOpen : aiOpen;

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    aiTriggerRef.current = e.currentTarget;
    // 首页（或无当前 PDF）先显示选文件引导；工作区内打开当前 PDF 的 Chat
    if (home || !current) setAiGuideOpen(!aiGuideOpen);
    else setAiOpen(!aiOpen);
  };

  return (
    <button type="button" className="ai-launcher" aria-pressed={open}
            aria-label={open ? "关闭 AI 阅读" : "打开 AI 阅读"}
            title={open ? "关闭 AI 阅读" : "打开 AI 阅读"} onClick={onClick}>
      {open ? (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      ) : (
        <>
          <img className="ai-launcher-mark" src="./brand/mark-inverse.svg" alt="" width={32} height={32} />
          <span className="ai-launcher-tail" aria-hidden="true"><i /></span>
        </>
      )}
    </button>
  );
}
