import type { PaperIntakeSource } from "../contracts";

export function PaperIntakeSources({ sources }: { sources: PaperIntakeSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="paper-intake-sources">
      <strong>检索来源</strong>
      <p>以下来源由 AI 整理，确认前可打开核对。</p>
      <ul>
        {sources.map((source) => (
          <li key={source.url}>
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              {source.title || source.url} ↗
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
