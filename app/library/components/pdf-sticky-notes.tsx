"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import { libraryRequest } from "../api-client";
import type { BackupStatus } from "../contracts";
import { NoteEditor, NoteText } from "./note-editor";
import { noteRuns } from "../../../lib/note-format.mjs";

export type PdfNotePoint = { pageNumber: number; xRatio: number; yRatio: number };
export type PdfStickyNote = PdfNotePoint & { id: string; pdfVersion: string; body: string; createdAt?: string; updatedAt?: string };
type Draft = PdfStickyNote & { baseline: string; existing: boolean; baselinePoint?: PdfNotePoint; autoMove?: boolean };
type Response = { pdfVersion: string; notes: PdfStickyNote[]; previousNotes: PdfStickyNote[] };
const message = (error: unknown) => error instanceof Error ? error.message : "便签保存失败，请重试。";
const plain = (value: string) => noteRuns(value).map((run) => run.text).join("");
const pointOf = ({ pageNumber, xRatio, yRatio }: PdfNotePoint) => ({ pageNumber, xRatio, yRatio });
const isDirty = (draft: Draft) => draft.body !== draft.baseline || Boolean(draft.existing && draft.baselinePoint && (
  draft.pageNumber !== draft.baselinePoint.pageNumber || draft.xRatio !== draft.baselinePoint.xRatio || draft.yRatio !== draft.baselinePoint.yRatio
));

export function usePdfStickyNotes({ paperId, pdfVersion, pageCount, viewportRef, disabled }: {
  paperId: string; pdfVersion: string | null; pageCount: number; viewportRef: RefObject<HTMLDivElement | null>; disabled: boolean;
}) {
  const [notes, setNotes] = useState<PdfStickyNote[]>([]);
  const [previousNotes, setPreviousNotes] = useState<PdfStickyNote[]>([]);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const cacheKey = pdfVersion ? `literature:pdf-sticky:${paperId}:${pdfVersion}` : null;
  const cache = useCallback((next: Draft | null) => {
    if (!cacheKey) return;
    try {
      if (next && isDirty(next)) localStorage.setItem(cacheKey, JSON.stringify(next));
      else localStorage.removeItem(cacheKey);
    } catch { /* A failed save still retains the in-memory draft and prevents exit. */ }
  }, [cacheKey]);
  const setDraft = useCallback((next: Draft | null) => {
    draftRef.current = next; setDraftState(next); cache(next);
  }, [cache]);
  useEffect(() => {
    if (!pdfVersion) return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      setLoading(true); setError(""); setAdding(false); setNotes([]); setPreviousNotes([]); draftRef.current = null; setDraftState(null);
      try {
        const result = await libraryRequest<Response>(`/papers/${encodeURIComponent(paperId)}/pdf-notes?pdfVersion=${encodeURIComponent(pdfVersion)}`);
        if (cancelled) return;
        setNotes(result.notes); setPreviousNotes(result.previousNotes);
        let restored: Draft | null = null;
        try {
          const value = JSON.parse(localStorage.getItem(cacheKey!) || "null");
          if (value && value.pdfVersion === pdfVersion && typeof value.id === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value.id)
            && typeof value.body === "string" && typeof value.baseline === "string" && Number.isInteger(value.pageNumber) && value.pageNumber >= 1 && value.pageNumber <= pageCount
            && [value.xRatio, value.yRatio].every((coordinate: unknown) => typeof coordinate === "number" && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)) restored = value;
        } catch { /* Ignore malformed local recovery data. */ }
        draftRef.current = restored; setDraftState(restored);
      } catch (error) { if (!cancelled) setError(message(error)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; cache(draftRef.current); };
  }, [paperId, pdfVersion, pageCount, cacheKey, cache, attempt]);

  const flush = useCallback((): Promise<boolean> => {
    if (savingRef.current) return savingRef.current;
    const snapshot = draftRef.current;
    if (!snapshot || !isDirty(snapshot) || (!snapshot.existing && !plain(snapshot.body).trim())) return Promise.resolve(true);
    if (!plain(snapshot.body).trim()) { setError("便签内容为空，请填写内容或使用删除按钮。"); return Promise.resolve(false); }
    const task = (async () => {
      setBusy(true); setError("");
      try {
        const result = await libraryRequest<{ note: PdfStickyNote; backup: BackupStatus }>(`/papers/${encodeURIComponent(paperId)}/pdf-notes/${encodeURIComponent(snapshot.id)}`, {
          method: "PUT", body: JSON.stringify({ pdfVersion: snapshot.pdfVersion, pageNumber: snapshot.pageNumber, pageCount, xRatio: snapshot.xRatio, yRatio: snapshot.yRatio, body: snapshot.body }),
        });
        setNotes((current) => [...current.filter((note) => note.id !== result.note.id), result.note]);
        setDraft(null);
        if (!result.backup.ok) setError(result.backup.message || "便签已保存在本机，备份暂未完成。");
        return true;
      } catch (error) { cache(snapshot); setError(message(error)); return false; }
      finally { setBusy(false); savingRef.current = null; }
    })();
    savingRef.current = task;
    return task;
  }, [paperId, pageCount, setDraft, cache]);

  const canSwitch = () => {
    const current = draftRef.current;
    if (busy || disabled) return false;
    if (current && isDirty(current) && !window.confirm("放弃尚未保存的便签修改？")) return false;
    return true;
  };
  const begin = (point: PdfNotePoint) => {
    if (!pdfVersion || loading || !canSwitch()) return;
    setDraft({ ...point, id: crypto.randomUUID(), pdfVersion, body: "", baseline: "", existing: false });
    setAdding(false); setError("");
  };
  const open = (note: PdfStickyNote) => {
    if (note.id === draftRef.current?.id) return;
    if (!canSwitch()) return;
    setDraft({ ...note, baseline: note.body, baselinePoint: pointOf(note), existing: true }); setAdding(false); setError("");
  };
  const move = (note: PdfStickyNote, point: PdfNotePoint) => {
    if (busy || disabled || adding || savingRef.current) return;
    const current = draftRef.current;
    if (current?.id === note.id) {
      setDraft({ ...current, ...point, baselinePoint: current.baselinePoint ?? pointOf(note) });
      return;
    }
    if (current && isDirty(current)) return;
    setDraft({ ...note, ...point, baseline: note.body, baselinePoint: pointOf(note), existing: true, autoMove: true });
    void flush();
  };
  const close = () => { if (canSwitch()) { setDraft(null); setError(""); } };
  const remove = async () => {
    const current = draftRef.current;
    if (!current || busy || disabled || !window.confirm("删除这条便签？")) return;
    if (!current.existing) { setDraft(null); return; }
    setBusy(true); setError("");
    try {
      await libraryRequest(`/papers/${encodeURIComponent(paperId)}/pdf-notes/${encodeURIComponent(current.id)}`, { method: "DELETE", body: JSON.stringify({ pdfVersion: current.pdfVersion }) });
      setNotes((items) => items.filter((item) => item.id !== current.id)); setDraft(null);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  const visible = draft ? [...notes.filter((note) => note.id !== draft.id), draft] : notes;
  return {
    notes, previousNotes, draft, error, busy, loading, adding, flush,
    dirty: Boolean(draft && isDirty(draft)),
    retry: () => setAttempt((value) => value + 1),
    toggleAdding: () => { if (canSwitch()) { setDraft(null); setAdding((value) => !value); setError(""); } },
    cancelAdding: () => setAdding(false), begin, open, close, remove,
    update: (body: string) => { const current = draftRef.current; if (current) setDraft({ ...current, body }); },
    renderMarkers: (pageNumber: number) => <div className="pdf-sticky-markers">{visible.filter((note) => note.pageNumber === pageNumber).map((note) => <PdfStickyPin
      key={note.id} note={note} active={draft?.id === note.id} viewportRef={viewportRef}
      draggable={!busy && !disabled && !adding && (!draft || draft.id === note.id || !isDirty(draft))}
      onOpen={() => open(note)} onMove={(point) => move(note, point)} />)}</div>,
    panel: draft && (!draft.autoMove || error) && <PdfStickyPanel key={draft.id} draft={draft} viewportRef={viewportRef} error={error} busy={busy || disabled}
      onChange={(body) => { const current = draftRef.current; if (current) setDraft({ ...current, body }); }} onClose={close} onSave={() => void flush()} onDelete={() => void remove()} />,
  };
}

type Point = { x: number; y: number };

function useStickyDrag({ enabled, onStart, onMove, onDrop, onCancel }: {
  enabled: boolean; onStart: (event: PointerEvent<HTMLElement>) => void; onMove: (delta: Point) => void;
  onDrop: (delta: Point) => void; onCancel?: () => void;
}) {
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const moved = useRef(false);
  const delta = (event: PointerEvent<HTMLElement>) => ({ x: event.clientX - start.current!.x, y: event.clientY - start.current!.y });
  const cancel = (event: PointerEvent<HTMLElement>) => {
    if (start.current?.id !== event.pointerId) return;
    start.current = null;
    onCancel?.();
  };
  return {
    wasDragged: () => moved.current,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0 || start.current) return;
        moved.current = false;
        if (!enabled || (event.target instanceof Element && event.target.closest("button") !== null && event.currentTarget.tagName !== "BUTTON")) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        onStart(event);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        if (start.current?.id !== event.pointerId) return;
        const offset = delta(event);
        if (!moved.current && Math.hypot(offset.x, offset.y) < 4) return;
        moved.current = true;
        onMove(offset);
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        if (start.current?.id !== event.pointerId) return;
        const offset = delta(event);
        start.current = null;
        if (moved.current || Math.hypot(offset.x, offset.y) >= 4) {
          moved.current = true;
          onDrop(offset);
        }
      },
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
    },
  };
}

function PdfStickyPin({ note, active, draggable, viewportRef, onOpen, onMove }: {
  note: PdfStickyNote; active: boolean; draggable: boolean; viewportRef: RefObject<HTMLDivElement | null>;
  onOpen: () => void; onMove: (point: PdfNotePoint) => void;
}) {
  const [offset, setOffset] = useState<Point | null>(null);
  const origin = useRef<Point>({ x: 0, y: 0 });
  const drag = useStickyDrag({
    enabled: draggable,
    onStart: (event) => {
      const box = event.currentTarget.getBoundingClientRect();
      origin.current = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    },
    onMove: setOffset,
    onCancel: () => setOffset(null),
    onDrop: (delta) => {
      setOffset(null);
      const viewport = viewportRef.current;
      const view = viewport?.getBoundingClientRect();
      const x = origin.current.x + delta.x;
      const y = origin.current.y + delta.y;
      if (!viewport || !view || x < view.left || x > view.right || y < view.top || y > view.bottom) return;
      for (const page of viewport.querySelectorAll<HTMLElement>(".pdf-reader-page-surface")) {
        const box = page.getBoundingClientRect();
        if (!box.width || !box.height || x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
        onMove({ pageNumber: Number(page.dataset.pageNumber), xRatio: (x - box.left) / box.width, yRatio: (y - box.top) / box.height });
        break;
      }
    },
  });
  const text = plain(note.body) || "新便签";
  return <button type="button" data-pdf-sticky-pin={note.id}
    className={`pdf-sticky-pin${active ? " is-active" : ""}${offset ? " is-dragging" : ""}`}
    style={{ left: `${note.xRatio * 100}%`, top: `${note.yRatio * 100}%`, translate: offset ? `${offset.x}px ${offset.y}px` : undefined }}
    aria-label={`第 ${note.pageNumber} 页便签：${text.slice(0, 80)}`} title={draggable ? `${text}\n拖动可移动便签` : text}
    {...drag.handlers} onClick={(event) => {
      event.stopPropagation();
      if (!event.detail || !drag.wasDragged()) onOpen();
    }}>▤</button>;
}

function PdfStickyPanel({ draft, viewportRef, error, busy, onChange, onClose, onSave, onDelete }: {
  draft: Draft; viewportRef: RefObject<HTMLDivElement | null>; error: string; busy: boolean;
  onChange: (body: string) => void; onClose: () => void; onSave: () => void; onDelete: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 440 });
  const [manualPosition, setManualPosition] = useState<{ left: number; top: number } | null>(null);
  const [ready, setReady] = useState(false);
  const dragOrigin = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const movePanel = ({ x, y }: Point) => {
    const box = dragOrigin.current;
    if (!box) return;
    setManualPosition({
      left: Math.max(8, Math.min(box.left + x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(box.top + y, window.innerHeight - box.height - 8)),
    });
  };
  const drag = useStickyDrag({ enabled: !busy,
    onStart: () => { dragOrigin.current = panelRef.current?.getBoundingClientRect() ?? null; },
    onMove: movePanel, onDrop: movePanel,
  });
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const page = viewport.querySelector<HTMLElement>(`.pdf-reader-page-surface[data-page-number="${draft.pageNumber}"]`);
      if (!page) return;
      const bounds = page.getBoundingClientRect();
      setReady(true);
      const view = viewport.getBoundingClientRect();
      const width = Math.min(280, view.width - 16);
      const height = panelRef.current?.getBoundingClientRect().height ?? 280;
      const left = Math.max(view.left + 8, Math.min(view.right - width - 8, bounds.left + bounds.width * draft.xRatio + 12));
      const top = Math.max(view.top + 8, Math.min(view.bottom - height - 8, bounds.top + bounds.height * draft.yRatio + 24));
      const maxHeight = Math.max(180, view.height - 16);
      setPosition((current) => current.left === left && current.top === top && current.width === width && current.maxHeight === maxHeight ? current : { left, top, width, maxHeight });
      setManualPosition((current) => {
        if (!current) return current;
        const left = Math.max(8, Math.min(current.left, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(current.top, window.innerHeight - height - 8));
        return left === current.left && top === current.top ? current : { left, top };
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    if (panelRef.current) observer.observe(panelRef.current);
    const pages = new MutationObserver(update);
    pages.observe(viewport, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    viewport.addEventListener("scroll", update, { passive: true });
    update();
    return () => { observer.disconnect(); pages.disconnect(); viewport.removeEventListener("scroll", update); };
  }, [draft.pageNumber, draft.xRatio, draft.yRatio, viewportRef]);
  useEffect(() => { if (ready) panelRef.current?.querySelector<HTMLElement>("[data-note-input]")?.focus({ preventScroll: true }); }, [draft.id, ready]);
  return createPortal(<section ref={panelRef} className="pdf-sticky-panel" data-pdf-sticky-editor role="dialog" aria-label={`第 ${draft.pageNumber} 页便签`}
    style={{ ...position, ...manualPosition, visibility: ready ? "visible" : "hidden" }}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && (event.key === "Enter" || event.key.toLowerCase() === "s")) { event.preventDefault(); event.stopPropagation(); onSave(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <header {...drag.handlers} title="拖动标题栏可移动便签面板"><strong>第 {draft.pageNumber} 页便签</strong><button type="button" onClick={onClose} disabled={busy} aria-label="关闭便签">×</button></header>
    <NoteEditor label="便签内容" value={draft.body} onChange={onChange} disabled={busy} minHeight={110} placeholder="在这里记下想法…" />
    {error && <p className="pdf-sticky-error" role="alert">{error}</p>}
    <footer><button type="button" className="pdf-sticky-delete" onClick={onDelete} disabled={busy}>删除</button><button type="button" onClick={onSave} disabled={busy || !plain(draft.body).trim()}>{busy ? "保存中…" : "保存便签"}</button></footer>
  </section>, window.document.body);
}

export function PdfStickyList({ notes, previousNotes, onSelect }: { notes: PdfStickyNote[]; previousNotes: PdfStickyNote[]; onSelect: (note: PdfStickyNote) => void }) {
  return <details className="pdf-sticky-list"><summary>页面便签 · {notes.length}</summary>
    {notes.length ? notes.slice().sort((a, b) => a.pageNumber - b.pageNumber).map((note) => <button type="button" key={note.id} onClick={() => onSelect(note)}><small>第 {note.pageNumber} 页</small><span><NoteText value={note.body} /></span></button>) : <p>点击“添加便签”，再点 PDF 页面放置。</p>}
    {previousNotes.length > 0 && <details><summary>其他 PDF 版本的便签 · {previousNotes.length}</summary>{previousNotes.map((note) => <p key={note.id}><small>原第 {note.pageNumber} 页</small><br /><NoteText value={note.body} /></p>)}</details>}
  </details>;
}
