"use client";

import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { formatPublicationForDisplay } from "../../../lib/paper-display.mjs";
import type { Paper } from "../contracts";
import "./reading-tabs.css";

export function ReadingTabs({ papers, activePaperId, busy, failedPaperIds, onSelect, onClose }: {
  papers: Paper[];
  activePaperId: string | null;
  busy: boolean;
  failedPaperIds: Set<string>;
  onSelect: (paperId: string | null) => void;
  onClose: (paperId: string) => void;
}) {
  const tabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePaperId, papers.length]);

  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    if (busy || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
    const tabs = Array.from(tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next]?.focus({ preventScroll: true });
    onSelect(tabs[next]?.dataset.readingTab || null);
  };

  return <nav ref={tabsRef} className="reading-tabs" role="tablist" aria-label="文献库与论文标签" aria-busy={busy} onKeyDown={navigate}>
    <button type="button" id="reading-tab-library" className="reading-tab-home" role="tab" aria-selected={!activePaperId}
      aria-controls="reading-panel-library" data-reading-tab="" tabIndex={activePaperId ? -1 : 0} disabled={busy} onClick={() => onSelect(null)}>文献库</button>
    {papers.map((paper) => {
      const publication = formatPublicationForDisplay(paper.source, paper.date);
      return <div key={paper.id} className={`reading-tab${activePaperId === paper.id ? " is-active" : ""}`} role="presentation">
        <button type="button" id={`reading-tab-${paper.id}`} className="reading-tab-select" role="tab" aria-selected={activePaperId === paper.id}
          aria-controls={`reading-panel-${paper.id}`} data-reading-tab={paper.id} tabIndex={activePaperId === paper.id ? 0 : -1}
          title={publication ? `${paper.title}\n${publication}` : paper.title} disabled={busy} onClick={() => onSelect(paper.id)}>
          <span className="reading-tab-label">
            <span>{paper.title}</span>
            {publication && <span className="reading-tab-publication">{publication}</span>}
          </span>
          {failedPaperIds.has(paper.id) && <small className="reading-tab-error" aria-label="保存未完成" title="保存未完成，请切回论文重试">!</small>}
        </button>
        <button type="button" className="reading-tab-close" data-reading-close={paper.id} aria-label={`关闭《${paper.title}》`}
          title="关闭这篇论文" disabled={busy} onClick={() => onClose(paper.id)}>×</button>
      </div>;
    })}
  </nav>;
}
