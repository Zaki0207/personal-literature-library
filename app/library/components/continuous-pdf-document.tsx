"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject, ReactNode } from "react";
import type { PdfNotePoint } from "./pdf-sticky-notes";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { capturePdfPoint, restorePdfPoint, type PdfZoomAnchor } from "../pdf-zoom-anchor.mjs";
import { clampPdfScale, pdfRenderTiles, type PdfRenderTile } from "../../../lib/pdf-zoom.mjs";
import { alignPdfTextLayer } from "../../../lib/pdf-text-layer.mjs";
import { resolvePdfDestination, type PdfDestination } from "../../../lib/pdf-links.mjs";
import { PdfLinkLayer } from "./pdf-link-layer";

export type PdfScrollAnchor = {
  pageNumber: number;
  scrollOffset: number;
  layoutMode?: "single-page" | "continuous";
};

export type ContinuousPdfHandle = {
  navigate: (pageNumber: number, position?: { xRatio?: number; yRatio?: number }) => void;
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
  initialScrollLeft?: number;
  searchQuery: string;
  onAnchor: (anchor: PdfScrollAnchor) => void;
  onScale: (scale: number) => void;
  onZoom: (scale: number) => void;
  onLinkError: (message: string) => void;
  addingSticky?: boolean;
  onStickyPoint?: (point: PdfNotePoint) => void;
  renderPageOverlay?: (pageNumber: number) => ReactNode;
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
      ? clampPdfScale((containerWidth - PAGE_HORIZONTAL_PADDING * 2) / size.width)
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
  document, viewportRef, containerWidth, scale, zoomMode, initialAnchor, initialScrollLeft, searchQuery, onAnchor, onScale, onZoom, onLinkError, addingSticky, onStickyPoint, renderPageOverlay,
}, ref) {
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [metadataError, setMetadataError] = useState("");
  const [metadataAttempt, setMetadataAttempt] = useState(0);
  const anchorRef = useRef<PdfScrollAnchor>(initialAnchor);
  const layoutsRef = useRef<PageLayout[]>([]);
  const onAnchorRef = useRef(onAnchor);
  const onScaleRef = useRef(onScale);
  const onZoomRef = useRef(onZoom);
  const onLinkErrorRef = useRef(onLinkError);
  const destinationRequestRef = useRef(0);
  const scrollingFrameRef = useRef<number | null>(null);
  const settlingFrameRef = useRef<number | null>(null);
  const restoringRef = useRef(false);
  const initiallyRestoredRef = useRef(false);
  const pointAnchorRef = useRef<PdfZoomAnchor | null>(null);
  const horizontalAnchorRef = useRef<{ pageNumber: number; ratio: number; viewportX?: number } | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const zoomTargetRef = useRef<number | null>(null);
  const submittedZoomRef = useRef<number | null>(null);
  const zoomModeRef = useRef(zoomMode);

  useEffect(() => { onAnchorRef.current = onAnchor; onScaleRef.current = onScale; onZoomRef.current = onZoom; onLinkErrorRef.current = onLinkError; }, [onAnchor, onScale, onZoom, onLinkError]);
  useEffect(() => () => { destinationRequestRef.current += 1; }, [document]);

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
    const firstRestore = !initiallyRestoredRef.current;
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
      const horizontal = horizontalAnchorRef.current;
      if (firstRestore || horizontal) {
        const target = currentLayouts[(horizontal?.pageNumber ?? layout.pageNumber) - 1] ?? layout;
        const pageLeft = (viewport.scrollWidth - target.width) / 2;
        viewport.scrollLeft = clamp(firstRestore && initialScrollLeft !== undefined && !horizontal ? initialScrollLeft : pageLeft + (horizontal?.ratio ?? 0.5) * target.width - (horizontal?.viewportX ?? viewport.clientWidth / 2), 0, Math.max(0, viewport.scrollWidth - viewport.clientWidth));
        horizontalAnchorRef.current = null;
      }
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
  }, [capture, viewportRef, scale, containerWidth, initialScrollLeft]);

  useLayoutEffect(() => {
    zoomModeRef.current = zoomMode;
    if (zoomMode === "custom" && submittedZoomRef.current !== null && Math.abs(scale - submittedZoomRef.current) < 1e-10) submittedZoomRef.current = null;
    layoutsRef.current = layouts;
    restore();
  }, [layouts, restore, zoomMode, scale]);

  const navigate = useCallback((pageNumber: number, position?: { xRatio?: number; yRatio?: number }) => {
    destinationRequestRef.current += 1;
    // Explicit page navigation wins over a pinch frame still waiting to commit.
    pointAnchorRef.current = null;
    submittedZoomRef.current = null;
    if (zoomFrameRef.current !== null) { cancelAnimationFrame(zoomFrameRef.current); zoomFrameRef.current = null; }
    const target = clamp(Math.round(pageNumber), 1, document.numPages);
    const height = layoutsRef.current[target - 1]?.height ?? 1;
    anchorRef.current = { pageNumber: target, scrollOffset: clamp((position?.yRatio ?? 0) - (position ? 16 / height : 0), 0, 1), layoutMode: "continuous" };
    horizontalAnchorRef.current = { pageNumber: target, ratio: position?.xRatio ?? 0.5, ...(position?.xRatio === undefined ? {} : { viewportX: 16 }) };
    restore();
  }, [document.numPages, restore]);

  const followDestination = useCallback(async (destination: PdfDestination) => {
    const request = ++destinationRequestRef.current;
    onLinkErrorRef.current("");
    try {
      const target = await resolvePdfDestination(document, destination);
      if (request !== destinationRequestRef.current) return;
      navigate(target.pageNumber, target);
      viewportRef.current?.focus({ preventScroll: true });
    } catch (error) {
      if (request === destinationRequestRef.current) onLinkErrorRef.current(error instanceof Error ? error.message : "无法定位这个 PDF 引用。");
    }
  }, [document, navigate, viewportRef]);

  useImperativeHandle(ref, () => ({
    navigate,
    capture,
    prepareLayout() {
      // Toolbar and sidebar actions supersede an in-flight pinch gesture.
      pointAnchorRef.current = null;
      submittedZoomRef.current = null;
      if (zoomFrameRef.current !== null) { cancelAnimationFrame(zoomFrameRef.current); zoomFrameRef.current = null; }
      if (settlingFrameRef.current !== null) { cancelAnimationFrame(settlingFrameRef.current); settlingFrameRef.current = null; }
      restoringRef.current = false;
      capture();
      const viewport = viewportRef.current;
      const layout = layoutsRef.current[anchorRef.current.pageNumber - 1];
      if (viewport && layout) {
        const pageLeft = (viewport.scrollWidth - layout.width) / 2;
        horizontalAnchorRef.current = { pageNumber: layout.pageNumber, ratio: clamp((viewport.scrollLeft + viewport.clientWidth / 2 - pageLeft) / layout.width, 0, 1) };
      }
    },
  }), [capture, navigate, viewportRef]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scroll = () => {
      if (restoringRef.current || scrollingFrameRef.current !== null) return;
      horizontalAnchorRef.current = null;
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
      const next = clampPdfScale(base * Math.exp(-deltaPixels * 0.01));
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
  return <div className={`pdf-reader-pages${addingSticky ? " is-adding-sticky" : ""}`} style={{ width: maxWidth + PAGE_HORIZONTAL_PADDING * 2 }}
    onClickCapture={(event) => {
      if (!addingSticky || !(event.target instanceof HTMLElement) || event.target.closest("button, [data-pdf-sticky-pin]")) return;
      const page = event.target.closest<HTMLElement>(".pdf-reader-page-surface");
      if (!page) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = page.getBoundingClientRect();
      onStickyPoint?.({ pageNumber: Number(page.dataset.pageNumber), xRatio: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), yRatio: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) });
    }}>
    {layouts.map((layout) => <ContinuousPdfPage key={layout.pageNumber} document={document} viewportRef={viewportRef} layout={layout} searchQuery={searchQuery} onDestination={followDestination} onLinkError={onLinkError} overlay={renderPageOverlay?.(layout.pageNumber)} />)}
  </div>;
});

function ContinuousPdfPage({ document, viewportRef, layout, searchQuery, onDestination, onLinkError, overlay }: {
  document: PDFDocumentProxy; viewportRef: RefObject<HTMLDivElement | null>; layout: PageLayout; searchQuery: string;
  onDestination: (destination: PdfDestination) => void; onLinkError: (message: string) => void;
  overlay?: ReactNode;
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
      {nearViewport ? <PdfPageCanvas document={document} viewportRef={viewportRef} layout={layout} searchQuery={searchQuery} /> : <div className="pdf-reader-page-placeholder" aria-label={`第 ${layout.pageNumber} 页待渲染`} />}
      {nearViewport && <PdfLinkLayer document={document} pageNumber={layout.pageNumber} onDestination={onDestination} onError={onLinkError} />}
      {nearViewport && overlay}
    </div>
    <span className="pdf-reader-page-footer">第 {layout.pageNumber} 页</span>
  </div>;
}

function PdfPageCanvas({ document, viewportRef, layout, searchQuery }: { document: PDFDocumentProxy; viewportRef: RefObject<HTMLDivElement | null>; layout: PageLayout; searchQuery: string }) {
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [tiles, setTiles] = useState<PdfRenderTile[]>([]);
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
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const surface = textLayerRef.current?.parentElement;
      if (!surface) return;
      const pageBounds = surface.getBoundingClientRect();
      const viewBounds = viewport.getBoundingClientRect();
      const next = pdfRenderTiles(layout, {
        left: viewBounds.left + viewport.clientLeft - pageBounds.left,
        top: viewBounds.top + viewport.clientTop - pageBounds.top,
        width: viewport.clientWidth, height: viewport.clientHeight,
      }, Math.min(window.devicePixelRatio || 1, 2));
      setTiles((previous) => previous.length === next.length && previous.every((tile, index) => {
        const other = next[index];
        return tile.key === other.key && tile.width === other.width && tile.height === other.height;
      }) ? previous : next);
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    viewport.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => { observer.disconnect(); viewport.removeEventListener("scroll", schedule); if (frame !== null) cancelAnimationFrame(frame); };
  }, [layout, viewportRef]);

  useEffect(() => {
    let cancelled = false;
    let cancelText: (() => void) | null = null;
    const render = async () => {
      const page = await document.getPage(layout.pageNumber);
      if (cancelled) return;
      setRendered(false); setError("");
      const viewport = page.getViewport({ scale: layout.scale });
      const textContainer = textLayerRef.current;
      if (!textContainer) return;
      textContainer.replaceChildren();
      textContainer.style.setProperty("--scale-factor", String(layout.scale));
      textContainer.style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit));
      const [pdfjs, textContent] = await Promise.all([import("pdfjs-dist"), page.getTextContent()]);
      // A newer scale may already own this container while text extraction ran.
      if (cancelled) return;
      const textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textContainer, viewport });
      cancelText = () => textLayer.cancel();
      await textLayer.render();
      if (cancelled) return;
      alignPdfTextLayer(textLayer, textContent, textContainer, viewport);
      highlight(); setRendered(true);
    };
    void render().catch((error) => {
      if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) setError(error instanceof Error ? error.message : "页面渲染失败。");
    });
    return () => { cancelled = true; cancelText?.(); };
  }, [document, layout.pageNumber, layout.scale, attempt, highlight]);

  return <>
    {tiles.map((tile) => <PdfCanvasTile key={`${layout.scale}:${tile.key}`} document={document} pageNumber={layout.pageNumber} scale={layout.scale} tile={tile} />)}
    <div ref={textLayerRef} className="pdf-reader-text-layer" />
    {error ? <div className="pdf-reader-page-error" role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>重试第 {layout.pageNumber} 页</button></div> : !rendered && <div className="pdf-reader-page-placeholder" role="status">正在渲染第 {layout.pageNumber} 页…</div>}
  </>;
}

function PdfCanvasTile({ document, pageNumber, scale, tile }: { document: PDFDocumentProxy; pageNumber: number; scale: number; tile: PdfRenderTile }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { left, top, width, height } = tile;
  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    const canvas = canvasRef.current;
    const render = async () => {
      const page = await document.getPage(pageNumber);
      if (cancelled || !canvas) return;
      setReady(false); setError("");
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(width * pixelRatio);
      canvas.height = Math.ceil(height * pixelRatio);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建 PDF 页面画布。");
      task = page.render({ canvas, canvasContext: context, viewport: page.getViewport({ scale }),
        transform: [pixelRatio, 0, 0, pixelRatio, -left * pixelRatio, -top * pixelRatio] });
      await task.promise;
      if (!cancelled) setReady(true);
    };
    void render().catch((error) => {
      if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) setError(error instanceof Error ? error.message : "页面渲染失败。");
    });
    return () => { cancelled = true; task?.cancel(); if (canvas) { canvas.width = 0; canvas.height = 0; } };
  }, [document, pageNumber, scale, left, top, width, height, attempt]);
  return <div className="pdf-reader-canvas-tile" style={{ left, top, width, height }}>
    <canvas ref={canvasRef} aria-label={`论文第 ${pageNumber} 页`} data-pdf-tile-ready={ready} style={{ width, height }} />
    {error && <div className="pdf-reader-page-error" role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>重试第 {pageNumber} 页</button></div>}
  </div>;
}
