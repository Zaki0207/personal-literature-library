export type PdfPageGeometry = {
  pageNumber: number;
  top: number;
  width: number;
  height: number;
  scale?: number;
};

export type PdfZoomAnchor = {
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  viewportX: number;
  viewportY: number;
};

export function capturePdfPoint(layouts: readonly PdfPageGeometry[], geometry: {
  scrollTop: number;
  scrollLeft: number;
  viewportWidth: number;
  clientX: number;
  clientY: number;
  /** Scrollport content origin; include clientLeft/clientTop for borders. */
  viewportLeft: number;
  viewportTop: number;
  /** Actual scroll content width, including fixed page-frame padding. */
  contentWidth: number;
}): PdfZoomAnchor | null;

export function restorePdfPoint(anchor: PdfZoomAnchor | null, layout: PdfPageGeometry | undefined, geometry: {
  contentWidth: number;
  viewportWidth: number;
  contentHeight?: number;
  viewportHeight?: number;
}): { scrollTop: number; scrollLeft: number } | null;
