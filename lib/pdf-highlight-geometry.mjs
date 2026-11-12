export function pdfHighlightRectsOverlap(first, second) {
  if (first.pageNumber !== second.pageNumber) return false;
  const width = Math.min(first.xRatio + first.widthRatio, second.xRatio + second.widthRatio) - Math.max(first.xRatio, second.xRatio);
  const height = Math.min(first.yRatio + first.heightRatio, second.yRatio + second.heightRatio) - Math.max(first.yRatio, second.yRatio);
  // Ignore tiny rounding overlaps and the edges of text boxes on adjacent lines.
  return width > Math.min(.0005, Math.min(first.widthRatio, second.widthRatio) * .1)
    && height > Math.min(first.heightRatio, second.heightRatio) * .5;
}
