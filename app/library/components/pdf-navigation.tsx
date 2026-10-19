"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import "./pdf-navigation.css";

type OutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];
type PdfNavigationProps = {
  document: PDFDocumentProxy;
  currentPage: number;
  onNavigate: (page: number) => void;
};

function PdfThumbnail({ document, page, selected, onNavigate, scrollRoot }: {
  document: PDFDocumentProxy;
  page: number;
  selected: boolean;
  onNavigate: (page: number) => void;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nearby, setNearby] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [aspectRatio, setAspectRatio] = useState(612 / 792);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), {
      root: scrollRoot.current, rootMargin: "180px 0px",
    });
    observer.observe(button);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!nearby) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    const render = async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled) return;
      setStatus("loading");
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: 124 / base.width });
      setAspectRatio(base.width / base.height);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法绘制缩略图。");
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (!cancelled) setStatus("ready");
    };
    void render().catch(() => { if (!cancelled) setStatus("failed"); });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [document, page, nearby]);

  return (
    <button ref={buttonRef} type="button" className={`pdf-thumbnail${selected ? " is-current" : ""}`}
      data-thumbnail-page={page} aria-label={`前往第 ${page} 页`} aria-current={selected ? "page" : undefined}
      onClick={() => onNavigate(page)}>
      <span className="pdf-thumbnail-image" style={{ aspectRatio }}>
        {nearby && <canvas ref={canvasRef} aria-hidden="true" />}
        {status !== "ready" && <span className="pdf-thumbnail-placeholder">{status === "failed" ? "预览不可用" : page}</span>}
      </span>
      <span>第 {page} 页</span>
    </button>
  );
}

function OutlineList({ items, onSelect }: { items: OutlineItem[]; onSelect: (item: OutlineItem) => void }) {
  return <ul className="pdf-outline-list">
    {items.map((item, index) => {
      const title = item.title.trim() || "未命名章节";
      const children = item.items as OutlineItem[];
      const link = <button type="button" className="pdf-outline-link" data-outline-title={title}
        disabled={!item.dest} onClick={() => onSelect(item)} title={!item.dest ? "此条目没有文档内页码" : title}>
        {title}
      </button>;
      return <li key={`${index}:${title}`}>
        {children.length ? <div className="pdf-outline-group">
          {link}
          <details open>
            <summary aria-label={`展开或收起“${title}”的子章节`}><span aria-hidden="true">⌄</span></summary>
            <OutlineList items={children} onSelect={onSelect} />
          </details>
        </div> : link}
      </li>;
    })}
  </ul>;
}

export function PdfNavigation(props: PdfNavigationProps) {
  return <PdfNavigationContent key={props.document.fingerprints[0]} {...props} />;
}

function PdfNavigationContent({ document, currentPage, onNavigate }: PdfNavigationProps) {
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [tab, setTab] = useState<"outline" | "pages">("outline");
  const [outlineError, setOutlineError] = useState("");
  const [destinationError, setDestinationError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const activeDocumentRef = useRef<PDFDocumentProxy | null>(null);

  useEffect(() => {
    let cancelled = false;
    activeDocumentRef.current = document;
    void document.getOutline().then((items) => {
      if (cancelled) return;
      setOutline(items ?? []);
      if (!items?.length) setTab("pages");
    }).catch(() => {
      if (cancelled) return;
      setOutline([]); setOutlineError("章节目录暂时无法读取，可使用缩略图导航。"); setTab("pages");
    });
    return () => { cancelled = true; activeDocumentRef.current = null; };
  }, [document]);

  useLayoutEffect(() => {
    if (tab !== "pages") return;
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>(`[data-thumbnail-page="${currentPage}"]`);
    if (!list || !selected) return;
    const top = selected.offsetTop;
    const bottom = top + selected.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [currentPage, tab]);

  const selectOutline = async (item: OutlineItem) => {
    setDestinationError("");
    try {
      const destination = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
      if (activeDocumentRef.current !== document) return;
      if (!Array.isArray(destination) || !destination.length) throw new Error("没有文档内目标页码。");
      const reference: unknown = destination[0];
      const pageIndex = typeof reference === "number"
        ? reference
        : reference && typeof reference === "object" && "num" in reference && "gen" in reference
          && Number.isInteger(reference.num) && Number.isInteger(reference.gen)
          ? await document.getPageIndex(reference as { num: number; gen: number })
          : -1;
      if (activeDocumentRef.current !== document) return;
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.numPages) throw new Error("目标页码超出文档范围。");
      onNavigate(pageIndex + 1);
    } catch {
      if (activeDocumentRef.current === document) setDestinationError("无法定位这个章节，请从缩略图或页码跳转。");
    }
  };

  return <aside className="pdf-reader-navigation" aria-label="PDF 目录与页面导航">
    <div className="pdf-navigation-tabs" role="tablist" aria-label="导航方式" onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "outline" : event.key === "End" ? "pages" : tab === "outline" ? "pages" : "outline";
      setTab(next);
      event.currentTarget.querySelector<HTMLButtonElement>(`#pdf-${next === "outline" ? "outline" : "pages"}-tab`)?.focus();
    }}>
      <button id="pdf-outline-tab" type="button" role="tab" tabIndex={tab === "outline" ? 0 : -1} aria-selected={tab === "outline"} aria-controls="pdf-outline-panel"
        onClick={() => setTab("outline")}>目录</button>
      <button id="pdf-pages-tab" type="button" role="tab" tabIndex={tab === "pages" ? 0 : -1} aria-selected={tab === "pages"} aria-controls="pdf-pages-panel"
        onClick={() => setTab("pages")}>缩略图</button>
    </div>
    {tab === "outline" ? <div className="pdf-navigation-content" id="pdf-outline-panel" role="tabpanel" aria-labelledby="pdf-outline-tab">
      {outline === null ? <p className="pdf-navigation-message" role="status">正在读取目录…</p>
        : outline.length ? <OutlineList items={outline} onSelect={(item) => { void selectOutline(item); }} />
          : <p className="pdf-navigation-message">{outlineError || "这个 PDF 没有内置章节目录，可切换到缩略图浏览页面。"}</p>}
      {destinationError && <p className="pdf-navigation-message" role="status">{destinationError}</p>}
    </div> : <div ref={listRef} className="pdf-navigation-content pdf-thumbnails" id="pdf-pages-panel" role="tabpanel" aria-labelledby="pdf-pages-tab">
      {outline !== null && !outline.length && <p className="pdf-navigation-message">{outlineError || "无内置目录，显示页面缩略图。"}</p>}
      {Array.from({ length: document.numPages }, (_, index) => <PdfThumbnail key={index + 1}
        document={document} page={index + 1} selected={currentPage === index + 1} onNavigate={onNavigate} scrollRoot={listRef} />)}
    </div>}
  </aside>;
}
