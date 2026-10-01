"use client";

import type { FormEventHandler } from "react";
import type { RadarItem, RadarStateResponse } from "../contracts";
import { safeExternalUrl } from "../presentation";

type RadarView = "pending" | "discarded";

interface RadarSurfaceProps {
  radarState: RadarStateResponse | null;
  libraryPaperCount: number;
  prompt: string;
  requestedCount: number;
  view: RadarView;
  busy: boolean;
  itemBusyId: string | null;
  error: string;
  contextOpen: boolean;
  onPromptChange: (value: string) => void;
  onRequestedCountChange: (value: number) => void;
  onViewChange: (value: RadarView) => void;
  onToggleContext: () => void;
  onOpenPromptEditor: () => void;
  onOpenAiTrace: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onChangeItem: (item: RadarItem, action: "discard" | "restore") => void;
  onReviewItem: (item: RadarItem) => void;
}

interface RadarItemCardProps {
  item: RadarItem;
  itemBusyId: string | null;
  onChangeItem: RadarSurfaceProps["onChangeItem"];
  onReviewItem: RadarSurfaceProps["onReviewItem"];
}

function RadarItemCard({
  item,
  itemBusyId,
  onChangeItem,
  onReviewItem,
}: RadarItemCardProps) {
  const originalUrl = safeExternalUrl(item.originalUrl);
  const busy = itemBusyId === item.id;
  const metadata = [
    item.authors,
    item.institution,
    item.source,
    item.date,
  ].filter(Boolean);

  return (
    <article className="radar-paper-card">
      <header className="radar-paper-header">
        <div>
          <span className="radar-unique-badge">
            <span aria-hidden="true">✓</span>
            已通过知识库与历史记录排重
          </span>
          <h2>{item.title}</h2>
          {item.zhTitle && (
            <p className="radar-paper-zh-title">{item.zhTitle}</p>
          )}
        </div>
        {originalUrl && (
          <a
            className="radar-source-link"
            href={originalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看原文 ↗
          </a>
        )}
      </header>

      {metadata.length > 0 && (
        <p className="radar-paper-meta">{metadata.join(" · ")}</p>
      )}

      {item.recommendationReason && (
        <div className="radar-reason">
          <span>推荐理由</span>
          <p>{item.recommendationReason}</p>
        </div>
      )}
      {item.aiSummary && (
        <div className="radar-summary">
          <span>AI 摘要</span>
          <p>{item.aiSummary}</p>
        </div>
      )}

      <footer className="radar-paper-footer">
        <div className="radar-identifiers" aria-label="排重标识">
          {item.identifiers
            .filter((identifier) => identifier.kind !== "url")
            .slice(0, 3)
            .map((identifier) => (
              <span key={`${identifier.kind}:${identifier.value}`}>
                {identifier.kind.toUpperCase()} · {identifier.value}
              </span>
            ))}
        </div>
        <div className="radar-review-actions">
          {item.status === "discarded" ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onChangeItem(item, "restore")}
              disabled={Boolean(itemBusyId)}
            >
              {busy ? "正在恢复…" : "恢复到待审核"}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="radar-discard-button"
                onClick={() => onChangeItem(item, "discard")}
                disabled={Boolean(itemBusyId)}
              >
                {busy ? "处理中…" : "丢弃并不再推荐"}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => onReviewItem(item)}
                disabled={Boolean(itemBusyId)}
              >
                核对并加入
              </button>
            </>
          )}
        </div>
      </footer>
    </article>
  );
}

export function RadarSurface({
  radarState,
  libraryPaperCount,
  prompt,
  requestedCount,
  view,
  busy,
  itemBusyId,
  error,
  contextOpen,
  onPromptChange,
  onRequestedCountChange,
  onViewChange,
  onToggleContext,
  onOpenPromptEditor,
  onOpenAiTrace,
  onSubmit,
  onChangeItem,
  onReviewItem,
}: RadarSurfaceProps) {
  const visibleItems =
    view === "pending"
      ? radarState?.pending ?? []
      : radarState?.discarded ?? [];
  const totalExclusions = radarState
    ? radarState.counts.library +
      radarState.counts.pending +
      radarState.counts.discarded +
      radarState.counts.added
    : libraryPaperCount;

  return (
    <div className="radar-page">
      <section className="radar-hero" aria-labelledby="radar-title">
        <div>
          <span className="radar-eyebrow">AI 文献发现</span>
          <h1 id="radar-title">文献雷达</h1>
          <p>
            按你的研究范围联网检索；每篇论文先排重，再交给你决定加入或永久丢弃。
          </p>
        </div>
        <div className="radar-hero-stats" aria-label="排重范围">
          <span>
            <strong>{radarState?.counts.library ?? libraryPaperCount}</strong>{" "}
            知识库论文
          </span>
          <span>
            <strong>{radarState?.counts.discarded ?? 0}</strong> 永久排除
          </span>
        </div>
      </section>

      <form className="radar-composer" onSubmit={onSubmit}>
        <div className="radar-composer-heading">
          <div>
            <h2>本次检索要求</h2>
            <p>提示词每次都可编辑；保存后将作为下一次默认值。</p>
          </div>
          <label className="radar-count-field">
            <span>推送数量</span>
            <input
              type="number"
              min={1}
              max={30}
              value={requestedCount}
              onChange={(event) =>
                onRequestedCountChange(
                  Math.max(
                    1,
                    Math.min(30, Number(event.target.value) || 1),
                  ),
                )
              }
              disabled={busy}
            />
            <small>篇</small>
          </label>
        </div>
        <label className="radar-prompt-field">
          <span className="sr-only">文献检索提示词</span>
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            rows={5}
            maxLength={10_000}
            placeholder="例如：检索与多模态情感识别、微表情分析和生理信号融合相关的近期论文……"
            disabled={busy}
          />
        </label>

        <div className="radar-template-entry">
          <div>
            <strong>完整提示词模板</strong>
            <span>高级设置；日常检索只需编辑上方要求</span>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={onOpenPromptEditor}
            disabled={!radarState || busy}
          >
            <span aria-hidden="true">⌘</span>
            编辑完整提示词
          </button>
        </div>

        <div className="radar-system-context">
          <button
            type="button"
            onClick={onToggleContext}
            aria-expanded={contextOpen}
          >
            <span aria-hidden="true">⌁</span>
            系统排重上下文（只读）
            <strong>{totalExclusions} 条</strong>
            <span aria-hidden="true">{contextOpen ? "⌃" : "⌄"}</span>
          </button>
          {contextOpen && (
            <div className="radar-context-detail">
              <p>
                AI 检索前会收到知识库与历史审核记录的标题、DOI、arXiv 和 URL
                摘要；返回后，本机数据库还会对全部 {totalExclusions}{" "}
                条记录再次严格排重。
              </p>
              <dl>
                <div>
                  <dt>当前知识库</dt>
                  <dd>{radarState?.counts.library ?? libraryPaperCount}</dd>
                </div>
                <div>
                  <dt>待审核</dt>
                  <dd>{radarState?.counts.pending ?? 0}</dd>
                </div>
                <div>
                  <dt>已加入历史</dt>
                  <dd>{radarState?.counts.added ?? 0}</dd>
                </div>
                <div>
                  <dt>已丢弃历史</dt>
                  <dd>{radarState?.counts.discarded ?? 0}</dd>
                </div>
              </dl>
              {radarState?.context && (
                <small>
                  上次检索：AI 收到 {radarState.context.providedToAi}{" "}
                  条摘要，本机核查 {radarState.context.locallyChecked} 条。
                </small>
              )}
            </div>
          )}
        </div>

        {error && (
          <p className="radar-error" role="alert">
            {error}
          </p>
        )}
        <div className="radar-composer-actions">
          <p>
            <span aria-hidden="true">✓</span> 数量不足时不会用重复论文补齐
          </p>
          <div className="radar-composer-buttons">
            <button
              type="button"
              className="secondary-button radar-trace-button"
              onClick={onOpenAiTrace}
            >
              <span aria-hidden="true">⌘</span>
              查看本次 AI 记录
            </button>
            <button
              type="submit"
              className="primary-button radar-run-button"
              disabled={busy || !prompt.trim()}
            >
              <span aria-hidden="true">✦</span>
              {busy
                ? "正在联网检索并排重，最长约 20 分钟…"
                : "开始本次检索"}
            </button>
          </div>
        </div>
      </form>

      <section
        className="radar-review-section"
        aria-labelledby="radar-review-title"
      >
        <div className="radar-review-heading">
          <div>
            <h2 id="radar-review-title">个人审核</h2>
            <p>加入或丢弃之前，不会改动你的知识库。</p>
          </div>
          <div className="radar-tabs" role="tablist" aria-label="文献雷达审核状态">
            <button
              type="button"
              role="tab"
              aria-selected={view === "pending"}
              className={view === "pending" ? "is-active" : ""}
              onClick={() => onViewChange("pending")}
            >
              待审核 <span>{radarState?.counts.pending ?? 0}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "discarded"}
              className={view === "discarded" ? "is-active" : ""}
              onClick={() => onViewChange("discarded")}
            >
              已丢弃 <span>{radarState?.counts.discarded ?? 0}</span>
            </button>
          </div>
        </div>

        {visibleItems.length ? (
          <div className="radar-paper-list">
            {visibleItems.map((item) => (
              <RadarItemCard
                key={item.id}
                item={item}
                itemBusyId={itemBusyId}
                onChangeItem={onChangeItem}
                onReviewItem={onReviewItem}
              />
            ))}
          </div>
        ) : (
          <div className="radar-empty-state">
            <span aria-hidden="true">✦</span>
            <h3>
              {view === "pending" ? "暂无待审核论文" : "暂无已丢弃论文"}
            </h3>
            <p>
              {view === "pending"
                ? "编辑上方提示词并开始检索，新的不重复论文会出现在这里。"
                : "你丢弃的论文会永久保留在排除记录中，并可随时恢复。"}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
