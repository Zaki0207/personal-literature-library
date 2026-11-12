const clamp = (value) => Math.min(1, Math.max(0, value));
const viewportRectangle = (viewport, rectangle) => [
  ...viewport.convertToViewportPoint(rectangle[0], rectangle[1]),
  ...viewport.convertToViewportPoint(rectangle[2], rectangle[3]),
];

export function safePdfLinkUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Link hit areas use the page viewport, including crop boxes and rotation. */
export function pdfLinkRectangles(annotation, viewport) {
  const quads = annotation.quadPoints;
  const rectangles = [];
  if (quads && quads.length >= 8 && quads.length % 8 === 0) {
    for (let index = 0; index < quads.length; index += 8) {
      const points = Array.from(quads.slice(index, index + 8));
      if (!points.every(Number.isFinite)) continue;
      rectangles.push([Math.min(points[0], points[2], points[4], points[6]), Math.min(points[1], points[3], points[5], points[7]),
        Math.max(points[0], points[2], points[4], points[6]), Math.max(points[1], points[3], points[5], points[7])]);
    }
  } else if (Array.isArray(annotation.rect) && annotation.rect.length === 4 && annotation.rect.every(Number.isFinite)) rectangles.push(annotation.rect);
  return rectangles.flatMap((rectangle) => {
    const [x1, y1, x2, y2] = viewportRectangle(viewport, rectangle);
    const left = clamp(Math.min(x1, x2) / viewport.width);
    const top = clamp(Math.min(y1, y2) / viewport.height);
    const right = clamp(Math.max(x1, x2) / viewport.width);
    const bottom = clamp(Math.max(y1, y2) / viewport.height);
    return right > left && bottom > top ? [{ left, top, width: right - left, height: bottom - top }] : [];
  });
}

/** Resolve both named and explicit destinations into scale-independent page coordinates. */
export async function resolvePdfDestination(document, input) {
  const destination = typeof input === "string" ? await document.getDestination(input) : input;
  if (!Array.isArray(destination) || destination.length < 2) throw new Error("PDF 中没有这个链接的目标位置。");
  const reference = destination[0];
  const pageIndex = Number.isInteger(reference) ? reference
    : reference && Number.isInteger(reference.num) && Number.isInteger(reference.gen)
      ? await document.getPageIndex(reference) : -1;
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.numPages) throw new Error("PDF 链接的目标页码无效。");
  const mode = destination[1]?.name;
  if (["Fit", "FitB"].includes(mode)) return { pageNumber: pageIndex + 1, yRatio: 0 };
  if (!["XYZ", "FitH", "FitBH", "FitV", "FitBV", "FitR"].includes(mode)) throw new Error("PDF 链接的目标位置格式无法识别。");
  const page = await document.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const [pageLeft, , , pageTop] = page.view;
  let x = pageLeft;
  let y = pageTop;
  if (mode === "XYZ") { x = destination[2] ?? pageLeft; y = destination[3] ?? pageTop; }
  else if (["FitH", "FitBH"].includes(mode)) y = destination[2] ?? pageTop;
  else if (["FitV", "FitBV"].includes(mode)) x = destination[2] ?? pageLeft;
  else {
    if (!destination.slice(2, 6).every(Number.isFinite) || destination.length < 6) throw new Error("PDF 链接的目标区域无效。");
    const box = viewportRectangle(viewport, destination.slice(2, 6));
    return { pageNumber: pageIndex + 1, xRatio: clamp(Math.min(box[0], box[2]) / viewport.width), yRatio: clamp(Math.min(box[1], box[3]) / viewport.height) };
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("PDF 链接的目标坐标无效。");
  const [left, top] = viewport.convertToViewportPoint(x, y);
  // A null horizontal destination keeps the page centered at ordinary zoom.
  const hasHorizontal = mode === "XYZ" ? destination[2] != null : ["FitV", "FitBV"].includes(mode);
  return { pageNumber: pageIndex + 1, ...(hasHorizontal || page.rotate % 180 !== 0 ? { xRatio: clamp(left / viewport.width) } : {}), yRatio: clamp(top / viewport.height) };
}
