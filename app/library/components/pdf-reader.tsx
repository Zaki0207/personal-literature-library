"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { libraryRequest, pdfOpenUrl } from "../api-client";
import type { Paper, PaperMutationResponse, PdfArchiveMutationResponse } from "../contracts";
import { ContinuousPdfDocument, type ContinuousPdfHandle, type PdfScrollAnchor } from "./continuous-pdf-document";
import { PdfNavigation } from "./pdf-navigation";
import "./pdf-reader.css";

type ZoomMode = "fit-width" | "custom";
type ReadingPosition = {
  pageNumber: number;
  pageCount: number;
  scale: number;
  zoomMode: ZoomMode;
  scrollOffset: number;
  notesVisible: boolean;
  layoutMode?: "single-page" | "continuous";
  updatedAt?: string;
};
type ReadingResponse = { pdfVersion: string | null; position: ReadingPosition | null; reset?: boolean };
type PositionDraft = ReadingPosition & { pdfVersion: string };
type SearchMatch = { page: number; excerpt: string };
type SaveStatus = "saved" | "pending" | "saving" | "failed";

export type PdfReaderProps = {
  paper: Paper;
  onBack: () => void;
  onPaperUpdated?: (paper: Paper) => void;
};

function readNoteDraft(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function cacheNoteDraft(key: string, note: string) {
  try { localStorage.setItem(key, note); return true; } catch { return false; }
}

function clearNoteDraft(key: string) {
  try { localStorage.removeItem(key); } catch { /* The saved server copy is authoritative. */ }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safePdfSourceUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function PdfReader(props: PdfReaderProps) {
  return <PdfReaderSession key={props.paper.id} {...props} />;
}

function PdfReaderSession({ paper, onBack, onPaperUpdated }: PdfReaderProps) {
  const noteDraftKey = `literature:reading-note:${paper.id}`;
  const [initialDraft] = useState(() => readNoteDraft(noteDraftKey));
  const [note, setNote] = useState(initialDraft ?? paper.note ?? "");
  const [draftCached, setDraftCached] = useState(initialDraft !== null);
  const [noteStatus, setNoteStatus] = useState<SaveStatus>(initialDraft !== null && initialDraft !== (paper.note ?? "") ? "pending" : "saved");
  const [noteError, setNoteError] = useState("");
  const [positionStatus, setPositionStatus] = useState<SaveStatus>("saved");
  const [positionError, setPositionError] = useState("");
  const [positionConflict, setPositionConflict] = useState(false);
  const [loadMessage, setLoadMessage] = useState("正在打开 PDF…");
  const [loadError, setLoadError] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [importing, setImporting] = useState(false);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [attempt, setAttempt] = useState({ count: 0, archive: false });
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit-width");
  const [notesVisible, setNotesVisible] = useState(true);
  const [navigationVisible, setNavigationVisible] = useState(false);
  const [initialAnchor, setInitialAnchor] = useState<PdfScrollAnchor>({ pageNumber: 1, scrollOffset: 0, layoutMode: "continuous" });
  const [containerWidth, setContainerWidth] = useState(800);
  const [leaving, setLeaving] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const continuousRef = useRef<ContinuousPdfHandle>(null);
  const pageNumberRef = useRef(1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const noteRef = useRef(note);
  const savedNoteRef = useRef(paper.note ?? "");
  const paperUpdatedRef = useRef(onPaperUpdated);
  const currentPaperRef = useRef(paper);
  const noteSaveRef = useRef<Promise<boolean> | null>(null);
  const positionSaveRef = useRef<Promise<boolean> | null>(null);
  const positionRef = useRef<PositionDraft | null>(null);
  const savedPositionRef = useRef("");
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const effectiveScaleRef = useRef(1);
  const mountedRef = useRef(true);
  const textCacheRef = useRef(new Map<number, string>());
  const flushNoteRef = useRef<() => Promise<boolean>>(async () => true);
  const flushPositionRef = useRef<() => Promise<boolean>>(async () => true);

  useEffect(() => { paperUpdatedRef.current = onPaperUpdated; }, [onPaperUpdated]);

  const flushNote = useCallback((): Promise<boolean> => {
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    if (noteSaveRef.current) return noteSaveRef.current;
    if (noteRef.current === savedNoteRef.current) return Promise.resolve(true);
    const task = (async () => {
      if (mountedRef.current) { setNoteStatus("saving"); setNoteError(""); }
      try {
        while (noteRef.current !== savedNoteRef.current) {
          const snapshot = noteRef.current;
          const result = await libraryRequest<PaperMutationResponse>(`/papers/${encodeURIComponent(paper.id)}`, {
            method: "PATCH", body: JSON.stringify({ note: snapshot }),
          });
          savedNoteRef.current = snapshot;
          currentPaperRef.current = result.paper;
          paperUpdatedRef.current?.(result.paper);
        }
        clearNoteDraft(noteDraftKey);
        if (mountedRef.current) { setNoteStatus("saved"); setDraftCached(false); }
        return true;
      } catch (error) {
        const cached = cacheNoteDraft(noteDraftKey, noteRef.current);
        if (mountedRef.current) { setNoteStatus("failed"); setNoteError(errorText(error)); setDraftCached(cached); }
        return false;
      } finally { noteSaveRef.current = null; }
    })();
    noteSaveRef.current = task;
    return task;
  }, [noteDraftKey, paper.id]);

  const flushPosition = useCallback((): Promise<boolean> => {
    continuousRef.current?.capture();
    if (positionTimerRef.current) clearTimeout(positionTimerRef.current);
    if (positionSaveRef.current) return positionSaveRef.current;
    if (!positionRef.current || JSON.stringify(positionRef.current) === savedPositionRef.current) return Promise.resolve(true);
    const task = (async () => {
      if (mountedRef.current) { setPositionStatus("saving"); setPositionError(""); }
      try {
        while (positionRef.current && JSON.stringify(positionRef.current) !== savedPositionRef.current) {
          const snapshot = { ...positionRef.current };
          await libraryRequest<ReadingResponse>(`/papers/${encodeURIComponent(paper.id)}/reading-position`, {
            method: "PUT", body: JSON.stringify(snapshot),
          });
          savedPositionRef.current = JSON.stringify(snapshot);
        }
        if (mountedRef.current) setPositionStatus("saved");
        return true;
      } catch (error) {
        if (mountedRef.current) {
          const message = errorText(error);
          setPositionStatus("failed"); setPositionError(message);
          setPositionConflict(message.includes("PDF 已更新") || message.includes("PDF 已移除"));
        }
        return false;
      } finally { positionSaveRef.current = null; }
    })();
    positionSaveRef.current = task;
    return task;
  }, [paper.id]);

  useEffect(() => {
    flushNoteRef.current = flushNote;
    flushPositionRef.current = flushPosition;
  }, [flushNote, flushPosition]);

  const updatePosition = useCallback((patch: Partial<ReadingPosition>) => {
    if (!positionRef.current) return;
    const next = { ...positionRef.current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(positionRef.current)) return;
    positionRef.current = next;
    setPositionStatus("pending");
    if (positionTimerRef.current) clearTimeout(positionTimerRef.current);
    positionTimerRef.current = setTimeout(() => { void flushPositionRef.current(); }, 700);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (importingRef.current || noteRef.current !== savedNoteRef.current) { event.preventDefault(); event.returnValue = ""; }
    };
    const beforeQuit = (event: Event) => {
      const complete = (event as CustomEvent<{ complete: (allow?: boolean) => void }>).detail?.complete;
      if (importingRef.current) {
        setRecoveryError("正在导入 PDF，请完成后再退出。");
        complete?.(false);
        return;
      }
      setLeaving(true);
      void Promise.all([flushNoteRef.current(), flushPositionRef.current()]).then(([noteSaved, positionSaved]) => {
        // Another window may decline quitting after this window has saved.
        setLeaving(false);
        complete?.(noteSaved && positionSaved);
      });
    };
    const find = () => { searchInputRef.current?.focus(); searchInputRef.current?.select(); };
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); searchInputRef.current?.focus(); searchInputRef.current?.select();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("literature-save-before-quit", beforeQuit);
    window.addEventListener("literature-reader-find", find);
    window.addEventListener("keydown", keydown);
    if (noteRef.current !== savedNoteRef.current) noteTimerRef.current = setTimeout(() => { void flushNoteRef.current(); }, 700);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("literature-save-before-quit", beforeQuit);
      window.removeEventListener("literature-reader-find", find);
      window.removeEventListener("keydown", keydown);
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
      if (positionTimerRef.current) clearTimeout(positionTimerRef.current);
      if (noteRef.current !== savedNoteRef.current) cacheNoteDraft(noteDraftKey, noteRef.current);
      void flushPositionRef.current();
    };
  }, [noteDraftKey]);

  useEffect(() => {
    let cancelled = false;
    const requestController = new AbortController();
    let loaded: PDFDocumentProxy | null = null;
    let destroyLoading: (() => Promise<void>) | null = null;
    const openDocument = async () => {
      // Start the external PDF lifecycle after this effect has subscribed.
      await Promise.resolve();
      if (cancelled) return;
      setLoadError(""); setRecoveryError(""); setDocument(null); setMatches([]); textCacheRef.current.clear();
      positionRef.current = null;
      savedPositionRef.current = "";
      let activePaper = currentPaperRef.current;
      if (attempt.archive || activePaper.pdfArchive?.status !== "ready") {
        setLoadMessage("正在将 PDF 保存到本机…");
        const archive = await libraryRequest<PdfArchiveMutationResponse>(`/papers/${encodeURIComponent(paper.id)}/pdf/archive`, {
          method: "POST", body: JSON.stringify({ force: false }), signal: requestController.signal,
        });
        if (cancelled) return;
        activePaper = archive.paper;
        currentPaperRef.current = activePaper;
        paperUpdatedRef.current?.(activePaper);
      }
      if (cancelled) return;
      setLoadMessage("正在恢复阅读位置…");
      const metadata = await libraryRequest<ReadingResponse>(`/papers/${encodeURIComponent(paper.id)}/reading-position`, { signal: requestController.signal });
      if (cancelled) return;
      const pdfjs = await import("pdfjs-dist");
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const loading = pdfjs.getDocument({
        url: pdfOpenUrl(paper.id),
        cMapUrl: new URL("pdfjs/cmaps/", window.document.baseURI).href,
        cMapPacked: true,
        standardFontDataUrl: new URL("pdfjs/standard_fonts/", window.document.baseURI).href,
        wasmUrl: new URL("pdfjs/wasm/", window.document.baseURI).href,
      });
      destroyLoading = () => loading.destroy();
      loading.onProgress = ({ loaded: bytes, total }: { loaded: number; total: number }) => {
        if (!cancelled) setLoadMessage(total > 0 ? `正在打开 PDF · ${Math.round(bytes / total * 100)}%` : "正在打开 PDF…");
      };
      loaded = await loading.promise;
      if (cancelled) { await loading.destroy(); return; }
      const pdfVersion = metadata.pdfVersion ?? `fingerprint:${loaded.fingerprints[0]}`;
      const restored = metadata.pdfVersion ? metadata : await libraryRequest<ReadingResponse>(
        `/papers/${encodeURIComponent(paper.id)}/reading-position?pdfVersion=${encodeURIComponent(pdfVersion)}`,
        { signal: requestController.signal },
      );
      if (cancelled) return;
      const previous = restored.position;
      const position: PositionDraft = {
        pdfVersion, pageNumber: clamp(previous?.pageNumber ?? 1, 1, loaded.numPages),
        pageCount: loaded.numPages, scale: previous?.scale ?? 1,
        zoomMode: previous?.zoomMode ?? "fit-width", scrollOffset: previous?.scrollOffset ?? 0,
        notesVisible: previous?.notesVisible ?? true,
        layoutMode: previous?.layoutMode ?? (previous ? "single-page" : "continuous"),
      };
      positionRef.current = position;
      savedPositionRef.current = JSON.stringify(position);
      setInitialAnchor({ pageNumber: position.pageNumber, scrollOffset: position.scrollOffset, layoutMode: position.layoutMode });
      pageNumberRef.current = position.pageNumber;
      setPageNumber(position.pageNumber); setPageInput(String(position.pageNumber));
      setScale(position.scale); setZoomMode(position.zoomMode); setNotesVisible(position.notesVisible);
      setPositionStatus("saved"); setPositionError(""); setPositionConflict(false); setDocument(loaded);
    };
    void openDocument().catch((error) => { if (!cancelled) setLoadError(errorText(error)); });
    return () => { cancelled = true; requestController.abort(); void destroyLoading?.().catch(() => undefined); };
  }, [attempt, paper.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      continuousRef.current?.capture();
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !query.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true); setSearchError("");
      void (async () => {
        const found: SearchMatch[] = [];
        const needle = query.trim().toLocaleLowerCase();
        for (let page = 1; page <= document.numPages; page += 1) {
          if (cancelled) return;
          let text = textCacheRef.current.get(page);
          if (text === undefined) {
            const content = await (await document.getPage(page)).getTextContent();
            text = content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/gu, " ");
            textCacheRef.current.set(page, text);
          }
          const normalized = text.toLocaleLowerCase();
          let from = 0;
          while (from < normalized.length) {
            const index = normalized.indexOf(needle, from);
            if (index < 0) break;
            found.push({ page, excerpt: `${index > 45 ? "…" : ""}${text.slice(Math.max(0, index - 45), index + needle.length + 75)}…` });
            from = index + needle.length;
          }
          if (!cancelled) setMatches([...found]);
        }
        if (!cancelled) { setMatchIndex(0); setSearching(false); }
      })().catch((error) => { if (!cancelled) { setSearchError(errorText(error)); setSearching(false); } });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [document, query]);

  const goToPage = (target: number) => {
    if (!document) return;
    const next = clamp(Math.round(target), 1, document.numPages);
    pageNumberRef.current = next;
    setPageNumber(next); setPageInput(String(next));
    updatePosition({ pageNumber: next, scrollOffset: 0, layoutMode: "continuous" });
    continuousRef.current?.navigate(next);
  };

  const moveMatch = (delta: number) => {
    if (!matches.length) return;
    const index = (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(index); goToPage(matches[index].page);
  };

  const changeScale = (delta: number) => {
    continuousRef.current?.prepareLayout();
    const next = clamp((zoomMode === "fit-width" ? effectiveScaleRef.current : scale) + delta, 0.25, 4);
    setScale(next); setZoomMode("custom"); updatePosition({ scale: next, zoomMode: "custom" });
  };

  const leave = async () => {
    if (importingRef.current) return;
    setLeaving(true);
    const [noteSaved, positionSaved] = await Promise.all([flushNote(), flushPosition()]);
    setLeaving(false);
    if (noteSaved && positionSaved) onBack();
  };

  const leaveChangedPdf = async () => {
    if (importingRef.current) return;
    setLeaving(true);
    const noteSaved = await flushNote();
    setLeaving(false);
    if (noteSaved) {
      // The old PDF's coordinates cannot apply to its replacement.
      positionRef.current = null;
      onBack();
    }
  };

  const reloadPdf = () => {
    if (importingRef.current || leaving) return;
    setAttempt((previous) => ({ count: previous.count + 1, archive: false }));
  };

  const openSource = async (url: string) => {
    setRecoveryError("");
    try {
      if (window.literatureDesktop) await window.literatureDesktop.openExternal(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      if (mountedRef.current) setRecoveryError(errorText(error));
    }
  };

  const importPdf = async (file?: File) => {
    if (importingRef.current || leaving) return;
    importingRef.current = true;
    setImporting(true); setRecoveryError("");
    try {
      const bridge = window.literatureDesktop;
      const grant = bridge && !file ? (await bridge.selectPdf())[0] : null;
      // Cancelling the file picker does not change this paper or its notes.
      if (!grant && !file) return;
      if (!mountedRef.current) return;
      if (!await flushNote()) {
        setRecoveryError("笔记尚未保存，请先重试保存笔记，再导入 PDF。当前笔记草稿已保留。");
        return;
      }
      if (!mountedRef.current) return;
      const imported = bridge && grant
        ? await bridge.importPdf(paper.id, grant.id) as PaperMutationResponse
        : await libraryRequest<PaperMutationResponse>(`/papers/${encodeURIComponent(paper.id)}/pdf/import`, {
          method: "POST", headers: { "Content-Type": "application/pdf" }, body: file,
        });
      if (!mountedRef.current) return;
      currentPaperRef.current = imported.paper;
      paperUpdatedRef.current?.(imported.paper);
      // The next load asks the service for the imported file's own reading version.
      positionRef.current = null;
      savedPositionRef.current = "";
      setAttempt((previous) => ({ count: previous.count + 1, archive: false }));
    } catch (error) {
      if (mountedRef.current) setRecoveryError(errorText(error));
    } finally {
      importingRef.current = false;
      if (mountedRef.current) setImporting(false);
    }
  };

  const sourceUrl = safePdfSourceUrl(paper.pdfUrl);
  const originalUrl = safePdfSourceUrl(paper.originalUrl);
  const noteStatusLabel = noteStatus === "saved" ? "已保存" : noteStatus === "saving" ? "正在保存…" : noteStatus === "failed" ? (draftCached ? "保存失败 · 本机草稿已保留" : "保存失败 · 当前输入已保留") : "等待保存…";

  return (
    <section className="pdf-reader" aria-label="论文阅读器">
      <header className="pdf-reader-heading">
        <button type="button" className="pdf-reader-back" onClick={() => void leave()} disabled={leaving || importing}>{leaving ? "保存中…" : "← 返回文献库"}</button>
        <button type="button" data-reader-navigation-toggle aria-pressed={navigationVisible} disabled={!document} onClick={() => { continuousRef.current?.prepareLayout(); setNavigationVisible(!navigationVisible); }}>{navigationVisible ? "收起目录" : "显示目录"}</button>
        <div className="pdf-reader-title"><strong title={paper.title}>{paper.zhTitle || paper.title}</strong><span title={paper.title}>{paper.title}</span></div>
        <button type="button" aria-pressed={notesVisible} onClick={() => { continuousRef.current?.prepareLayout(); setNotesVisible(!notesVisible); updatePosition({ notesVisible: !notesVisible }); }}>{notesVisible ? "收起笔记" : "显示笔记"}</button>
      </header>
      <div className="pdf-reader-toolbar">
        <div className="pdf-reader-page-controls">
          <button type="button" aria-label="上一页" disabled={!document || pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}>‹</button>
          <form onSubmit={(event) => { event.preventDefault(); const value = Number(pageInput); if (Number.isFinite(value)) goToPage(value); }}>
            <label htmlFor={`pdf-page-${paper.id}`}>页码</label>
            <input id={`pdf-page-${paper.id}`} inputMode="numeric" value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={() => setPageInput(String(pageNumber))} disabled={!document} />
            <span>/ {document?.numPages ?? "—"}</span>
          </form>
          <button type="button" aria-label="下一页" disabled={!document || pageNumber >= document.numPages} onClick={() => goToPage(pageNumber + 1)}>›</button>
        </div>
        <div className="pdf-reader-zoom-controls">
          <button type="button" aria-label="缩小" onClick={() => changeScale(-0.1)} disabled={!document || (zoomMode === "custom" && scale <= 0.25)}>−</button>
          <span>{zoomMode === "fit-width" ? "适应宽度" : `${Math.round(scale * 100)}%`}</span>
          <button type="button" aria-label="放大" onClick={() => changeScale(0.1)} disabled={!document || (zoomMode === "custom" && scale >= 4)}>＋</button>
          <button type="button" disabled={!document} aria-pressed={zoomMode === "fit-width"} onClick={() => { continuousRef.current?.prepareLayout(); setZoomMode("fit-width"); updatePosition({ zoomMode: "fit-width" }); }}>适应宽度</button>
        </div>
        <form className="pdf-reader-find" onSubmit={(event) => { event.preventDefault(); if (matches.length) goToPage(matches[matchIndex].page); }}>
          <input ref={searchInputRef} type="search" aria-label="查找 PDF 全文" placeholder="查找全文 ⌘F" value={query} onChange={(event) => { setQuery(event.target.value); setMatches([]); setSearching(Boolean(event.target.value.trim())); setSearchError(""); setMatchIndex(0); }} disabled={!document} />
          <button type="button" aria-label="上一个匹配" disabled={!matches.length} onClick={() => moveMatch(-1)}>↑</button>
          <button type="button" aria-label="下一个匹配" disabled={!matches.length} onClick={() => moveMatch(1)}>↓</button>
        </form>
      </div>
      {query.trim() && <div className="pdf-reader-search-status" role="status">
        <span>{searchError || (searching ? `正在检索全文 · 已找到 ${matches.length} 处` : matches.length ? `${matchIndex + 1} / ${matches.length} 处 · 第 ${matches[matchIndex]?.page} 页` : "未找到匹配文字；扫描版 PDF 需要先进行文字识别")}</span>
        {matches.length > 0 && <button type="button" onClick={() => goToPage(matches[matchIndex].page)}>{matches[matchIndex]?.excerpt}</button>}
      </div>}
      {positionStatus === "failed" && <div className="pdf-reader-position-error" role="alert"><span>阅读位置未保存：{positionError}</span>{positionConflict ? <div><button type="button" onClick={reloadPdf} disabled={importing}>重新载入 PDF</button><button type="button" disabled={leaving || importing} onClick={() => void leaveChangedPdf()}>保存笔记并返回</button></div> : <button type="button" onClick={() => void flushPosition()}>重试保存</button>}</div>}
      <div className={`pdf-reader-body${notesVisible ? " has-notes" : ""}${navigationVisible && document ? " has-navigation" : ""}`}>
        {navigationVisible && document && <PdfNavigation document={document} currentPage={pageNumber} onNavigate={goToPage} />}
        <div ref={viewportRef} className="pdf-reader-viewport">
          {loadError ? <div className="pdf-reader-empty" data-pdf-load-error role="alert"><strong>暂时无法打开 PDF</strong><p>{loadError}</p>
            <p className="pdf-reader-recovery-hint">可以重试下载。来源网站需要登录时，请在浏览器中打开页面，下载后导入这篇论文。导入会替换当前 PDF，保留论文资料和笔记。</p>
            <div className="pdf-reader-recovery-actions">
              <button type="button" data-pdf-retry onClick={reloadPdf} disabled={importing || leaving}>{sourceUrl ? "重试下载" : "重新打开 PDF"}</button>
              {sourceUrl && <button type="button" data-pdf-source onClick={() => void openSource(sourceUrl)} disabled={importing || leaving}>在浏览器打开 PDF 来源</button>}
              {originalUrl && originalUrl !== sourceUrl && <button type="button" data-pdf-original onClick={() => void openSource(originalUrl)} disabled={importing || leaving}>打开论文原文页面</button>}
              <button type="button" data-pdf-import onClick={() => { if (window.literatureDesktop) void importPdf(); else importInputRef.current?.click(); }} disabled={importing || leaving}>{importing ? "正在导入…" : "导入本地 PDF"}</button>
            </div>
            <input ref={importInputRef} className="pdf-reader-import-input" type="file" accept=".pdf,application/pdf" aria-label="为当前论文导入 PDF" disabled={importing || leaving} onChange={(event) => {
              const file = event.target.files?.[0]; event.target.value = "";
              if (file) void importPdf(file);
            }} />
            {recoveryError && <p className="pdf-reader-recovery-error" data-pdf-recovery-error role="alert">{recoveryError}</p>}
          </div>
            : !document ? <div className="pdf-reader-empty" role="status"><span className="pdf-reader-spinner" /><p>{loadMessage}</p></div>
            : <ContinuousPdfDocument ref={continuousRef} document={document} viewportRef={viewportRef}
              containerWidth={containerWidth} scale={scale} zoomMode={zoomMode} initialAnchor={initialAnchor}
              searchQuery={query} onScale={(value) => { effectiveScaleRef.current = value; }}
              onZoom={(value) => { setScale(value); setZoomMode("custom"); updatePosition({ scale: value, zoomMode: "custom" }); }}
              onAnchor={(anchor) => {
                if (pageNumberRef.current !== anchor.pageNumber) {
                  pageNumberRef.current = anchor.pageNumber;
                  setPageNumber(anchor.pageNumber); setPageInput(String(anchor.pageNumber));
                }
                updatePosition({ pageNumber: anchor.pageNumber, scrollOffset: anchor.scrollOffset, layoutMode: "continuous" });
              }} />}
        </div>
        {notesVisible && <aside className="pdf-reader-notes" aria-label="阅读笔记">
          <div className="pdf-reader-notes-heading"><strong>我的笔记</strong><span role="status" className={`is-${noteStatus}`}>{noteStatusLabel}</span></div>
          {initialDraft !== null && initialDraft !== (paper.note ?? "") && noteStatus !== "saved" && <p className="pdf-reader-draft-message">已恢复上次未保存的本机草稿。</p>}
          <textarea aria-label="我的阅读笔记" placeholder="记录你的想法、疑问和方法。笔记会自动保存。" value={note} disabled={leaving} onChange={(event) => {
            const value = event.target.value; noteRef.current = value; setNote(value); setNoteStatus("pending"); setNoteError("");
            setDraftCached(cacheNoteDraft(noteDraftKey, value));
            if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
            noteTimerRef.current = setTimeout(() => { void flushNoteRef.current(); }, 700);
          }} />
          {noteStatus === "failed" && <div className="pdf-reader-note-error" role="alert"><p>{noteError}</p><button type="button" onClick={() => void flushNote()}>重试保存笔记</button></div>}
          <details className="pdf-reader-summary"><summary>AI 总结</summary><p>{paper.aiSummary || "这篇论文尚未生成 AI 总结。"}</p></details>
        </aside>}
      </div>
    </section>
  );
}
