const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function requireFinite(values) {
  if (values.some((value) => !Number.isFinite(value))) throw new TypeError("PDF zoom geometry must contain finite coordinates.");
}

/** Capture the PDF point below a pointer in viewport CSS pixels, before relayout. */
export function capturePdfPoint(layouts, {
  scrollTop,
  scrollLeft,
  viewportWidth,
  clientX,
  clientY,
  viewportLeft,
  viewportTop,
  contentWidth,
}) {
  if (!layouts.length) return null;
  requireFinite([scrollTop, scrollLeft, viewportWidth, clientX, clientY, viewportLeft, viewportTop, contentWidth]);
  const viewportX = clamp(clientX - viewportLeft, 0, viewportWidth);
  const viewportY = Math.max(0, clientY - viewportTop);
  const contentY = scrollTop + viewportY;
  let nearest = null;
  let nearestDistance = Infinity;
  for (const page of layouts) {
    requireFinite([page.pageNumber, page.top, page.width, page.height]);
    if (page.width <= 0 || page.height <= 0) continue;
    const distance = Math.max(page.top - contentY, contentY - page.top - page.height, 0);
    if (distance < nearestDistance) { nearest = page; nearestDistance = distance; }
  }
  if (!nearest) return null;
  const pageLeft = (contentWidth - nearest.width) / 2;
  return {
    pageNumber: nearest.pageNumber,
    xRatio: clamp((scrollLeft + viewportX - pageLeft) / nearest.width, 0, 1),
    yRatio: clamp((contentY - nearest.top) / nearest.height, 0, 1),
    viewportX,
    viewportY,
  };
}

/** Place the captured PDF point at the same screen coordinate after relayout. */
export function restorePdfPoint(anchor, layout, {
  contentWidth,
  viewportWidth,
  contentHeight,
  viewportHeight,
}) {
  if (!anchor || !layout || layout.pageNumber !== anchor.pageNumber) return null;
  requireFinite([anchor.xRatio, anchor.yRatio, anchor.viewportX, anchor.viewportY, layout.top, layout.width, layout.height, contentWidth, viewportWidth]);
  if (layout.width <= 0 || layout.height <= 0) return null;
  const pageLeft = (contentWidth - layout.width) / 2;
  const requestedLeft = pageLeft + clamp(anchor.xRatio, 0, 1) * layout.width - anchor.viewportX;
  const requestedTop = layout.top + clamp(anchor.yRatio, 0, 1) * layout.height - anchor.viewportY;
  const maxLeft = Math.max(0, contentWidth - viewportWidth);
  const maxTop = contentHeight === undefined || viewportHeight === undefined
    ? Infinity : Math.max(0, contentHeight - viewportHeight);
  if (maxTop !== Infinity) requireFinite([contentHeight, viewportHeight]);
  return {
    scrollLeft: clamp(requestedLeft, 0, maxLeft),
    scrollTop: clamp(requestedTop, 0, maxTop),
  };
}
