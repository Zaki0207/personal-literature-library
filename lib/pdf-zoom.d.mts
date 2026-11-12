export const MIN_PDF_SCALE: number;
export const MAX_PDF_SCALE: number;
export function clampPdfScale(scale: number): number;
export function stepPdfScale(scale: number, direction: number): number;
export function parsePdfScale(value: string): number | null;
export type PdfRenderTile = { key: string; left: number; top: number; width: number; height: number };
export function pdfRenderTiles(page: { width: number; height: number }, visible: { left: number; top: number; width: number; height: number }, pixelRatio: number): PdfRenderTile[];
