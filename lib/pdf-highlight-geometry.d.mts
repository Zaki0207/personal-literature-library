export type HighlightRect = { pageNumber: number; xRatio: number; yRatio: number; widthRatio: number; heightRatio: number };
export function pdfHighlightRectsOverlap(first: HighlightRect, second: HighlightRect): boolean;
