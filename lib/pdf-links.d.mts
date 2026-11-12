import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";

export type PdfDestination = string | unknown[];
export type PdfLinkTarget = { pageNumber: number; xRatio?: number; yRatio: number };
export function safePdfLinkUrl(value: unknown): string | null;
export function pdfLinkRectangles(annotation: { rect?: unknown; quadPoints?: ArrayLike<number> & { slice(start: number, end: number): ArrayLike<number> } }, viewport: PageViewport): { left: number; top: number; width: number; height: number }[];
export function resolvePdfDestination(document: PDFDocumentProxy, destination: PdfDestination): Promise<PdfLinkTarget>;
