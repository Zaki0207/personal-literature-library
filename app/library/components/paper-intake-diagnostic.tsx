import type { PaperIntakeDiagnostic as IntakeDiagnostic } from "../api-client";
import "./paper-intake-diagnostic.css";

export function PaperIntakeDiagnostic({ diagnostic }: { diagnostic: IntakeDiagnostic }) {
  return (
    <details className="paper-intake-diagnostic" data-paper-intake-diagnostic>
      <summary>查看 AI 最终答复</summary>
      <p>
        {diagnostic.reason}
        {diagnostic.model ? ` · 模型：${diagnostic.model}` : ""}
        {diagnostic.truncated ? ` · 仅显示部分答复（共 ${diagnostic.outputLength} 字符）` : ""}
      </p>
      <pre>{diagnostic.outputPreview || "（AI 未返回最终文本）"}</pre>
    </details>
  );
}
