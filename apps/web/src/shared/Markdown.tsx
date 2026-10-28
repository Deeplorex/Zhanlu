import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** AI 答案的 Markdown 渲染：默认转义内嵌 HTML（不执行脚本），启用 GFM 表格/删除线/任务列表。
 *  样式见 theme.css `.md`（沿用 Noto Sans SC 与既有色板）。 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
