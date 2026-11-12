"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { libraryRequest } from "../api-client";
import { pdfHighlightRectsOverlap, type HighlightRect } from "../../../lib/pdf-highlight-geometry.mjs";

type HighlightSelection = { text: string; rects: HighlightRect[] };
type PdfHighlight = HighlightSelection & { id: string; pdfVersion: string };
type HighlightData = { pdfVersion: string; highlights: PdfHighlight[]; error?: string };
type HighlightChange =
  | { method: "PUT"; highlight: PdfHighlight; pageCount: number }
  | { method: "DELETE"; highlights: PdfHighlight[] };

const emptyHighlights: PdfHighlight[] = [];
const message = (error: unknown) => error instanceof Error ? error.message : "高亮操作失败，请重试。";
const overlapping = (selection: HighlightSelection, highlights: PdfHighlight[]) =>
  highlights.filter((highlight) => selection.rects.some((rect) => highlight.rects.some((mark) => pdfHighlightRectsOverlap(rect, mark))));

export function usePdfHighlights(paperId: string, pdfVersion: string | null, pageCount: number) {
  const endpoint = `/papers/${encodeURIComponent(paperId)}/pdf-highlights`;
  const [data, setData] = useState<HighlightData | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const changeRef = useRef<HighlightChange | null>(null);
  const savingRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    if (!pdfVersion) return;
    const controller = new AbortController();
    void libraryRequest<HighlightData>(`${endpoint}?pdfVersion=${encodeURIComponent(pdfVersion)}`, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((error) => {
      if (!controller.signal.aborted) setData({ pdfVersion, highlights: [], error: message(error) });
    });
    return () => controller.abort();
  }, [endpoint, pdfVersion, attempt]);

  const current = data?.pdfVersion === pdfVersion ? data : null;
  const highlights = current?.highlights ?? emptyHighlights;
  const marksByPage = useMemo(() => {
    const pages = new Map<number, (HighlightRect & { id: string })[]>();
    for (const highlight of highlights) {
      for (const rect of highlight.rects) {
        const marks = pages.get(rect.pageNumber) ?? [];
        marks.push({ ...rect, id: highlight.id });
        pages.set(rect.pageNumber, marks);
      }
    }
    return pages;
  }, [highlights]);

  const hasPending = useCallback(() => changeRef.current !== null, []);
  const flush = useCallback((): Promise<boolean> => {
    if (savingRef.current) return savingRef.current;
    const change = changeRef.current;
    if (!change) return Promise.resolve(true);
    const task = (async () => {
      setBusy(true);
      setSaveError("");
      const update = (id: string, pdfVersion: string, highlight?: PdfHighlight) => setData((previous) => {
        if (!previous || previous.pdfVersion !== pdfVersion) return previous;
        const next = previous.highlights.filter((item) => item.id !== id);
        if (highlight) next.push(highlight);
        return { ...previous, highlights: next };
      });
      try {
        if (change.method === "PUT") {
          const { id, pdfVersion, text, rects } = change.highlight;
          const { highlight } = await libraryRequest<{ highlight: PdfHighlight }>(`${endpoint}/${encodeURIComponent(id)}`, {
            method: "PUT", body: JSON.stringify({ pdfVersion, text, rects, pageCount: change.pageCount }),
          });
          update(id, pdfVersion, highlight);
        } else {
          for (const { id, pdfVersion } of change.highlights) {
            await libraryRequest(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ pdfVersion }) });
            update(id, pdfVersion);
          }
        }
        changeRef.current = null;
        return true;
      } catch (error) {
        setSaveError(message(error));
        return false;
      } finally {
        setBusy(false);
        savingRef.current = null;
      }
    })();
    savingRef.current = task;
    return task;
  }, [endpoint]);

  const ready = Boolean(current && !current.error);
  const start = (change: HighlightChange) => {
    if (!ready || changeRef.current) return;
    changeRef.current = change;
    void flush();
  };
  const retryLoad = () => { setData(null); setAttempt((value) => value + 1); };
  return {
    highlights, ready, busy, saveError, loadError: current?.error, flush, hasPending, retryLoad,
    add: (selection: HighlightSelection) => {
      if (pdfVersion && !overlapping(selection, highlights).length) start({ method: "PUT", highlight: { ...selection, id: crypto.randomUUID(), pdfVersion }, pageCount });
    },
    remove: (highlight: PdfHighlight) => start({ method: "DELETE", highlights: [highlight] }),
    removeSelection: (selection: HighlightSelection) => {
      const matches = overlapping(selection, highlights);
      if (matches.length) start({ method: "DELETE", highlights: matches });
    },
    discard: () => {
      if (savingRef.current) return;
      changeRef.current = null;
      setSaveError("");
      retryLoad();
    },
    renderMarks: (pageNumber: number) => {
      const marks = marksByPage.get(pageNumber);
      return marks && <div className="pdf-highlight-layer" aria-hidden="true">
        {marks.map((rect, index) => <span key={`${rect.id}:${index}`} data-pdf-highlight={rect.id}
          style={{ left: `${rect.xRatio * 100}%`, top: `${rect.yRatio * 100}%`, width: `${rect.widthRatio * 100}%`, height: `${rect.heightRatio * 100}%` }} />)}
      </div>;
    },
  };
}

function readSelection(viewport: HTMLDivElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!viewport.contains(range.startContainer) || !viewport.contains(range.endContainer)) return null;

  const rects: HighlightRect[] = [];
  const fragments: string[] = [];
  for (const layer of viewport.querySelectorAll<HTMLElement>(".pdf-reader-text-layer")) {
    if (!range.intersectsNode(layer)) continue;
    const page = layer.closest<HTMLElement>(".pdf-reader-page-surface");
    if (!page) continue;
    const bounds = page.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    const pageNumber = Number(page.dataset.pageNumber);
    const pageRange = document.createRange();
    pageRange.selectNodeContents(layer);
    if (layer.contains(range.startContainer)) pageRange.setStart(range.startContainer, range.startOffset);
    if (layer.contains(range.endContainer)) pageRange.setEnd(range.endContainer, range.endOffset);
    fragments.push(pageRange.toString());

    // Text-node ranges exclude the extra element boxes that a full span selection returns.
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    const segment = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!pageRange.intersectsNode(node)) continue;
      segment.setStart(node, node === range.startContainer ? range.startOffset : 0);
      segment.setEnd(node, node === range.endContainer ? range.endOffset : node.textContent?.length ?? 0);
      if (!segment.toString().trim()) continue;
      for (const box of segment.getClientRects()) {
        const left = Math.max(bounds.left, box.left);
        const top = Math.max(bounds.top, box.top);
        const right = Math.min(bounds.right, box.right);
        const bottom = Math.min(bounds.bottom, box.bottom);
        if (left >= right || top >= bottom) continue;
        rects.push({ pageNumber, xRatio: (left - bounds.left) / bounds.width, yRatio: (top - bounds.top) / bounds.height,
          widthRatio: (right - left) / bounds.width, heightRatio: (bottom - top) / bounds.height });
      }
    }
  }
  const text = fragments.join("\n").trim();
  return text && rects.length ? { text, rects } : null;
}

export function PdfHighlightToolbar({ viewportRef, highlights, disabled, onAdd, onRemove }: {
  viewportRef: RefObject<HTMLDivElement | null>; highlights: PdfHighlight[]; disabled: boolean;
  onAdd: (selection: HighlightSelection) => void; onRemove: (selection: HighlightSelection) => void;
}) {
  const [selection, setSelection] = useState<HighlightSelection | null>(null);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    let selecting = false;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setSelection(selecting || disabled ? null : readSelection(viewport));
      });
    };
    const begin = () => { selecting = true; update(); };
    const end = () => { selecting = false; update(); };
    viewport.addEventListener("pointerdown", begin);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    document.addEventListener("selectionchange", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("pointerdown", begin);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      document.removeEventListener("selectionchange", update);
    };
  }, [viewportRef, disabled]);

  const marked = Boolean(selection && overlapping(selection, highlights).length);
  const apply = (remove: boolean) => {
    const viewport = viewportRef.current;
    const selected = viewport && readSelection(viewport);
    if (!selected || Boolean(overlapping(selected, highlights).length) !== remove) return;
    if (remove) onRemove(selected);
    else onAdd(selected);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };
  return <div className="pdf-highlight-tools" role="group" aria-label="文字高亮">
    <button type="button" data-pdf-highlight-add disabled={disabled || !selection || marked}
      title={marked ? "选区已包含高亮" : "选中 PDF 文字后点击高亮"}
      onMouseDown={(event) => event.preventDefault()} onClick={() => apply(false)}>高亮</button>
    <button type="button" data-pdf-highlight-remove disabled={disabled || !marked}
      title="选中已高亮的文字后取消整条标记"
      onMouseDown={(event) => event.preventDefault()} onClick={() => apply(true)}>取消高亮</button>
  </div>;
}

export function PdfHighlightList({ highlights, disabled, onNavigate, onRemove }: {
  highlights: PdfHighlight[]; disabled: boolean;
  onNavigate: (rect: HighlightRect) => void; onRemove: (highlight: PdfHighlight) => void;
}) {
  if (!highlights.length) return null;
  return <details className="pdf-highlight-list">
    <summary>文字高亮 · {highlights.length}</summary>
    {highlights.map((highlight) => {
      const first = highlight.rects[0];
      return <div className="pdf-highlight-list-item" key={highlight.id}>
        <button type="button" className="pdf-highlight-jump" title={highlight.text} onClick={() => onNavigate(first)}>
          <small>第 {first.pageNumber} 页</small><span>{highlight.text}</span>
        </button>
        <button type="button" disabled={disabled} onClick={() => onRemove(highlight)} aria-label={`删除高亮：${highlight.text.slice(0, 80)}`}>删除</button>
      </div>;
    })}
  </details>;
}
