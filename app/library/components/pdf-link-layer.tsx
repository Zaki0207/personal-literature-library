"use client";

import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { pdfLinkRectangles, safePdfLinkUrl, type PdfDestination } from "../../../lib/pdf-links.mjs";

type Link = {
  id: string;
  url: string | null;
  destination: PdfDestination | null;
  label: string;
  rectangles: ReturnType<typeof pdfLinkRectangles>;
};

export function PdfLinkLayer({ document, pageNumber, onDestination, onError }: {
  document: PDFDocumentProxy;
  pageNumber: number;
  onDestination: (destination: PdfDestination) => void;
  onError: (message: string) => void;
}) {
  const [links, setLinks] = useState<Link[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [page, pdfjs] = await Promise.all([document.getPage(pageNumber), import("pdfjs-dist")]);
      const annotations = await page.getAnnotations({ intent: "display" });
      const viewport = page.getViewport({ scale: 1 });
      const result: Link[] = [];
      for (const annotation of annotations) {
        // Hidden (2) and NoView (32) annotations have no on-screen hit area.
        if (annotation.annotationType !== pdfjs.AnnotationType.LINK || (annotation.annotationFlags & 34)) continue;
        const url = safePdfLinkUrl(annotation.url);
        const destination = !annotation.url && (typeof annotation.dest === "string" || Array.isArray(annotation.dest)) ? annotation.dest : null;
        if (!url && !destination) continue;
        const label = annotation.contentsObj?.str || annotation.overlaidText || (url ? `在浏览器打开 ${url}` : "跳转到文档内引用");
        result.push({ id: annotation.id, url, destination, label, rectangles: pdfLinkRectangles(annotation, viewport) });
      }
      if (!cancelled) { setLinks(result); setFailed(false); }
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [document, pageNumber, attempt]);

  return <div className="pdf-reader-link-layer" data-pdf-link-page={pageNumber}>
    {links.flatMap((link) => link.rectangles.map((rectangle, index) => <a
      key={`${link.id}:${index}`} data-pdf-link-id={link.id} data-pdf-link-kind={link.url ? "external" : "internal"}
      href={link.url ?? `#pdf-link-${encodeURIComponent(link.id)}`} target={link.url ? "_blank" : undefined} rel={link.url ? "noopener noreferrer" : undefined}
      aria-label={link.label} title={link.label}
      style={{ left: `${rectangle.left * 100}%`, top: `${rectangle.top * 100}%`, width: `${rectangle.width * 100}%`, height: `${rectangle.height * 100}%` }}
      onClick={(event) => {
        if (link.destination) { event.preventDefault(); onDestination(link.destination); }
        else if (link.url && window.literatureDesktop) {
          event.preventDefault();
          void window.literatureDesktop.openExternal(link.url).catch((error) => onError(error instanceof Error ? error.message : "无法打开这个 PDF 链接。"));
        }
      }}
    />))}
    {failed && <button type="button" className="pdf-reader-links-error" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>链接读取失败，点击重试</button>}
  </div>;
}
