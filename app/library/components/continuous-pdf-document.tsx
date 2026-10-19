"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { capturePdfPoint, restorePdfPoint, type PdfZoomAnchor } from "../pdf-zoom-anchor.mjs";

export type PdfScrollAnchor = {
  pageNumber: number;
  scrollOffset: number;
  layoutMode?: "single-page" | "continuous";
};

export type ContinuousPdfHandle = {
  navigate: (pageNumber: number) => void;
  capture: () => void;
  prepareLayout: () => void;
};

type PageSize = { width: number; height: number };
type PageLayout = PageSize & { pageNumber: number; top: number; scale: number };
type Props = {
  document: PDFDocumentProxy;
  viewportRef: RefObject<HTMLDivElement | null>;
  containerWidth: number;
  scale: number;
  zoomMode: "fit-width" | "custom";
  initialAnchor: PdfScrollAnchor;
  searchQuery: string;
  onAnchor: (anchor: PdfScrollAnchor) => void;
  onScale: (scale: number) => void;
  onZoom: (scale: number) => void;
};

const PAGE_TOP_PADDING = 24;
const PAGE_GAP = 24;
const PAGE_FOOTER_HEIGHT = 28;
const PAGE_HORIZONTAL_PADDING = 32;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function buildLayouts(sizes: PageSize[], containerWidth: number, scale: number, zoomMode: Props["zoomMode"]) {
  const layouts: PageLayout[] = [];
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    const renderScale = zoomMode === "fit-width"
      ? clamp((containerWidth - PAGE_HORIZONTAL_PADDING * 2) / size.width, 0.25, 4)
      : scale;
    const previous = layouts[index - 1];
    layouts.push({
      pageNumber: index + 1, width: size.width * renderScale, height: size.height * renderScale,
      top: previous ? previous.top + previous.height + PAGE_FOOTER_HEIGHT + PAGE_GAP : PAGE_TOP_PADDING,
      scale: renderScale,
    });
  }
  return layouts;
}

async function pageSizes(document: PDFDocumentProxy, isCancelled: () => boolean) {
  const sizes: PageSize[] = new Array(document.numPages);
  let next = 1;
  const worker = async () => {
    while (next <= document.numPages && !isCancelled()) {
      const pageNumber = next++;
      const viewport = (await document.getPage(pageNumber)).getViewport({ scale: 1 });
      sizes[pageNumber - 1] = { width: viewport.width, height: viewport.height };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, document.numPages) }, worker));
  return sizes;
}

/** All page geometry stays mounted; only canvases near the viewport allocate memory. */
export const ContinuousPdfDocument = forwardRef<ContinuousPdfHandle, Props>(function ContinuousPdfDocument({
  document, viewportRef, containerWidth, scale, zoomMode, initialAnchor, searchQuery, onAnchor, onScale, onZoom,
}, ref) {
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [metadataError, setMetadataError] = useState("");
  const [metadataAttempt, setMetadataAttempt] = useState(0);
  const anchorRef = useRef<PdfScrollAnchor>(initialAnchor);
  const layoutsRef = useRef<PageLayout[]>([]);
  const onAnchorRef = useRef(onAnchor);
  const onScaleRef = useRef(onScale);
  const onZoomRef = useRef(onZoom);
  const scrollingFrameRef = useRef<number | null>(null);
  const settlingFrameRef = useRef<number | null>(null);
  const restoringRef = useRef(false);
  const initiallyRestoredRef = useRef(false);
  const pointAnchorRef = useRef<PdfZoomAnchor | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const zoomTargetRef = useRef<number | null>(null);
  const submittedZoomRef = useRef<number | null>(null);
  const zoomModeRef = useRef(zoomMode);

  useEffect(() => { onAnchorRef.current = onAnchor; onScaleRef.current = onScale; onZoomRef.current = onZoom; }, [onAnchor, onScale, onZoom]);

  useEffect(() => {
    let cancelled = false;
    void pageSizes(document, () => cancelled).then((result) => {
      if (!cancelled) { setSizes(result); setMetadataError(""); }
    }).catch((error) => {
      if (!cancelled) setMetadataError(error instanceof Error ? error.message : "无法读取 PDF 分页信息。");
    });
    return () => { cancelled = true; };
  }, [document, metadataAttempt]);

  const layouts = useMemo(() => buildLayouts(sizes, containerWidth, scale, zoomMode), [sizes, containerWidth, scale, zoomMode]);

  const capture = useCallback(() => {
    const viewport = viewportRef.current;
    const currentLayouts = layoutsRef.current;
    if (!viewport || !currentLayouts.length || !initiallyRestoredRef.current || restoringRef.current) return;
    const marker = viewport.scrollTop + 32;
    let low = 0;
    let high = currentLayouts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (currentLayouts[middle].top <= marker) low = middle;
      else high = middle - 1;
    }
    const maximumScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const layout = maximumScroll > 0 && viewport.scrollTop >= maximumScroll - 1 ? currentLayouts[currentLayouts.length - 1] : currentLayouts[low];
    const anchor: PdfScrollAnchor = {
      pageNumber: layout.pageNumber,
      scrollOffset: clamp((viewport.scrollTop - layout.top) / layout.height, 0, 1),
      layoutMode: "continuous",
    };
    anchorRef.current = anchor;
    if (zoomFrameRef.current === null && !pointAnchorRef.current) zoomTargetRef.current = layout.scale;
    onScaleRef.current(layout.scale);
    onAnchorRef.current(anchor);
  }, [viewportRef]);

  const restore = useCallback(() => {
    const viewport = viewportRef.current;
    const currentLayouts = layoutsRef.current;
    if (!viewport || !currentLayouts.length) return;
    // Restoring collapsed notes can change the viewport in the same commit.
    // Wait for its real width before consuming a legacy fit-width coordinate.
    if (Math.abs(viewport.clientWidth - containerWidth) > 1) return;
    initiallyRestoredRef.current = true;
    const anchor = anchorRef.current;
    const layout = currentLayouts[clamp(anchor.pageNumber, 1, currentLayouts.length) - 1];
    const point = pointAnchorRef.current;
    if (point) {
      const coordinates = restorePdfPoint(point, currentLayouts[point.pageNumber - 1], {
        contentWidth: Math.max(viewport.clientWidth, currentLayouts.reduce((width, page) => Math.max(width, page.width), 0) + PAGE_HORIZONTAL_PADDING * 2),
        viewportWidth: viewport.clientWidth, contentHeight: viewport.scrollHeight, viewportHeight: viewport.clientHeight,
      });
      if (coordinates) { viewport.scrollLeft = coordinates.scrollLeft; viewport.scrollTop = coordinates.scrollTop; }
      const pointScale = currentLayouts[point.pageNumber - 1]?.scale;
      const finalTarget = zoomTargetRef.current;
      // React may commit one pinch frame while the next frame is already
      // queued. Retain the original PDF point until its final scale lands.
      if (zoomFrameRef.current === null && finalTarget !== null && pointScale !== undefined && Math.abs(pointScale - finalTarget) < 1e-10) pointAnchorRef.current = null;
      restoringRef.current = false;
      capture();
    } else {
      // Legacy single-page offsets refer to that page's scrollable overflow,
      // including its old padding and footer. Convert once, retaining its page.
      const ratio = anchor.layoutMode === "single-page"
        ? clamp(anchor.scrollOffset * Math.max(0, layout.height + 80 - viewport.clientHeight) / layout.height, 0, 1)
        : anchor.scrollOffset;
      anchorRef.current = { pageNumber: layout.pageNumber, scrollOffset: ratio, layoutMode: "continuous" };
      restoringRef.current = true;
      viewport.scrollTop = layout.top + ratio * layout.height;
      onScaleRef.current(layout.scale);
      onAnchorRef.current(anchorRef.current);
    }
    restoringRef.current = true;
    if (zoomFrameRef.current === null && !pointAnchorRef.current) zoomTargetRef.current = currentLayouts[anchorRef.current.pageNumber - 1]?.scale ?? scale;
    if (settlingFrameRef.current !== null) cancelAnimationFrame(settlingFrameRef.current);
    settlingFrameRef.current = requestAnimationFrame(() => {
      restoringRef.current = false;
      capture();
    });
  }, [capture, viewportRef, scale, containerWidth]);

  useLayoutEffect(() => {
    zoomModeRef.current = zoomMode;
    if (zoomMode === "custom" && submittedZoomRef.current !== null && Math.abs(scale - submittedZoomRef.current) < 1e-10) submittedZoomRef.current = null;
    layoutsRef.current = layouts;
    restore();
  }, [layouts, restore, zoomMode, scale]);

  useImperativeHandle(ref, () => ({
    navigate(pageNumber) {
      // Explicit page navigation wins over a pinch frame still waiting to commit.
      pointAnchorRef.current = null;
      submittedZoomRef.current = null;
      if (zoomFrameRef.current !== null) { cancelAnimationFrame(zoomFrameRef.current); zoomFrameRef.current = null; }
      anchorRef.current = { pageNumber: clamp(Math.round(pageNumber), 1, document.numPages), scrollOffset: 0, layoutMode: "continuous" };
      restore();
    },
    capture,
    prepareLayout() {
      // Toolbar and sidebar actions supersede an in-flight pinch gesture.
      pointAnchorRef.current = null;
      submittedZoomRef.current = null;
      if (zoomFrameRef.current !== null) { cancelAnimationFrame(zoomFrameRef.current); zoomFrameRef.current = null; }
      if (settlingFrameRef.current !== null) { cancelAnimationFrame(settlingFrameRef.current); settlingFrameRef.current = null; }
      restoringRef.current = false;
      capture();
    },
  }), [capture, document.numPages, restore]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scroll = () => {
      if (restoringRef.current || scrollingFrameRef.current !== null) return;
      scrollingFrameRef.current = requestAnimationFrame(() => { scrollingFrameRef.current = null; capture(); });
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      // Chromium represents macOS trackpad pinching as a Ctrl+wheel event.
      // A non-passive listener prevents whole-window browser zooming.
      event.preventDefault(); event.stopPropagation();
      const currentLayouts = layoutsRef.current;
      if (!currentLayouts.length || !initiallyRestoredRef.current) return;
      const pendingPoint = pointAnchorRef.current;
      let point = pendingPoint;
      if (!point) {
        const bounds = viewport.getBoundingClientRect();
        point = capturePdfPoint(currentLayouts, {
          scrollTop: viewport.scrollTop, scrollLeft: viewport.scrollLeft, viewportWidth: viewport.clientWidth,
          clientX: event.clientX, clientY: event.clientY,
          viewportLeft: bounds.left + viewport.clientLeft, viewportTop: bounds.top + viewport.clientTop,
          contentWidth: viewport.scrollWidth,
        });
      }
      if (!point) return;
      // Fit-width pages can have different scales: start with the page under
      // the pointer, then accumulate subsequent ticks from this frame's target.
      const pageScale = currentLayouts[point.pageNumber - 1]?.scale ?? 1;
      const base = pendingPoint ? zoomTargetRef.current ?? pageScale : pageScale;
      const deltaPixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      const next = clamp(base * Math.exp(-deltaPixels * 0.01), 0.25, 4);
      if (next === base) return;
      pointAnchorRef.current = point;
      zoomTargetRef.current = next;
      if (zoomFrameRef.current === null) zoomFrameRef.current = requestAnimationFrame(() => {
        zoomFrameRef.current = null;
        const target = zoomTargetRef.current;
        if (target === null) return;
        const renderedScale = layoutsRef.current[(pointAnchorRef.current?.pageNumber ?? 1) - 1]?.scale;
        const submissionPending = submittedZoomRef.current !== null && (renderedScale === undefined || Math.abs(submittedZoomRef.current - renderedScale) >= 1e-10);
        if (!submissionPending && zoomModeRef.current === "custom" && renderedScale !== undefined && Math.abs(target - renderedScale) < 1e-10) {
          // Equal opposite ticks need no React commit; discard their old point.
          pointAnchorRef.current = null;
          zoomTargetRef.current = renderedScale;
          capture();
          return;
        }
        submittedZoomRef.current = target;
        onZoomRef.current(target);
      });
    };
    viewport.addEventListener("scroll", scroll, { passive: true });
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => {
      viewport.removeEventListener("scroll", scroll);
      viewport.removeEventListener("wheel", wheel);
      if (scrollingFrameRef.current !== null) cancelAnimationFrame(scrollingFrameRef.current);
      if (settlingFrameRef.current !== null) cancelAnimationFrame(settlingFrameRef.current);
      if (zoomFrameRef.current !== null) cancelAnimationFrame(zoomFrameRef.current);
    };
  }, [capture, viewportRef]);

  if (metadataError) return <div className="pdf-reader-empty" role="alert"><strong>无法准备连续页面</strong><p>{metadataError}</p><button type="button" onClick={() => setMetadataAttempt((value) => value + 1)}>重试分页</button></div>;
  if (!layouts.length) return <div className="pdf-reader-empty" role="status"><span className="pdf-reader-spinner" /><p>正在准备连续页面…</p></div>;
  const maxWidth = layouts.reduce((maximum, layout) => Math.max(maximum, layout.width), 0);
  return <div className="pdf-reader-pages" style={{ width: maxWidth + PAGE_HORIZONTAL_PADDING * 2 }}>
    {layouts.map((layout) => <ContinuousPdfPage key={layout.pageNumber} document={document} viewportRef={viewportRef} layout={layout} searchQuery={searchQuery} />)}
  </div>;
});

function ContinuousPdfPage({ document, viewportRef, layout, searchQuery }: {
  document: PDFDocumentProxy; viewportRef: RefObject<HTMLDivElement | null>; layout: PageLayout; searchQuery: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  useEffect(() => {
    const frame = frameRef.current;
    const viewport = viewportRef.current;
    if (!frame || !viewport) return;
    const observer = new IntersectionObserver(([entry]) => setNearViewport(entry.isIntersecting), { root: viewport, rootMargin: "100% 0px" });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [viewportRef]);
  return <div ref={frameRef} className="pdf-reader-page-frame" data-page-number={layout.pageNumber} style={{ width: layout.width }}>
    <div className="pdf-reader-page-surface" data-page-number={layout.pageNumber} style={{ width: layout.width, height: layout.height }}>
      {nearViewport ? <PdfPageCanvas document={document} layout={layout} searchQuery={searchQuery} /> : <div className="pdf-reader-page-placeholder" aria-label={`第 ${layout.pageNumber} 页待渲染`} />}
    </div>
    <span className="pdf-reader-page-footer">第 {layout.pageNumber} 页</span>
  </div>;
}

function PdfPageCanvas({ document, layout, searchQuery }: { document: PDFDocumentProxy; layout: PageLayout; searchQuery: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const queryRef = useRef(searchQuery);

  const highlight = useCallback(() => {
    const query = queryRef.current.trim().toLocaleLowerCase();
    for (const span of textLayerRef.current?.querySelectorAll("span") ?? []) {
      span.classList.toggle("pdf-search-highlight", Boolean(query && span.textContent?.toLocaleLowerCase().includes(query)));
    }
  }, []);

  useEffect(() => { queryRef.current = searchQuery; highlight(); }, [searchQuery, highlight]);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let cancelText: (() => void) | null = null;
    const render = async () => {
      const page = await document.getPage(layout.pageNumber);
      if (cancelled) return;
      setRendered(false); setError("");
      const viewport = page.getViewport({ scale: layout.scale });
      const canvas = canvasRef.current;
      const textContainer = textLayerRef.current;
      if (!canvas || !textContainer) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      // Large engineering pages at 400% must not exhaust the renderer's canvas memory.
      const pixelRatio = Math.min(ratio, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      textContainer.replaceChildren();
      textContainer.style.setProperty("--scale-factor", String(layout.scale));
      textContainer.style.setProperty("--total-scale-factor", String(layout.scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建 PDF 页面画布。");
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      await renderTask.promise;
      if (cancelled) return;
      const [pdfjs, textContent] = await Promise.all([import("pdfjs-dist"), page.getTextContent()]);
      // A newer scale may already own this container while text extraction ran.
      if (cancelled) return;
      const textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textContainer, viewport });
      cancelText = () => textLayer.cancel();
      await textLayer.render();
      if (cancelled) return;
      highlight(); setRendered(true);
    };
    void render().catch((error) => {
      if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) setError(error instanceof Error ? error.message : "页面渲染失败。");
    });
    return () => { cancelled = true; renderTask?.cancel(); cancelText?.(); };
  }, [document, layout.pageNumber, layout.scale, attempt, highlight]);

  return <>
    <canvas ref={canvasRef} aria-label={`论文第 ${layout.pageNumber} 页`} />
    <div ref={textLayerRef} className="pdf-reader-text-layer" />
    {error ? <div className="pdf-reader-page-error" role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>重试第 {layout.pageNumber} 页</button></div> : !rendered && <div className="pdf-reader-page-placeholder" role="status">正在渲染第 {layout.pageNumber} 页…</div>}
  </>;
}
