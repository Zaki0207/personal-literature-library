export const MIN_PDF_SCALE = 0.25;
export const MAX_PDF_SCALE = 64;

export function clampPdfScale(scale) {
  return Math.min(MAX_PDF_SCALE, Math.max(MIN_PDF_SCALE, scale));
}

export function stepPdfScale(scale, direction) {
  return clampPdfScale(Math.round(scale * (direction > 0 ? 1.25 : 0.8) * 1000) / 1000);
}

export function parsePdfScale(value) {
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?\s*%?$/u.test(text)) return null;
  const scale = Number(text.replace(/\s*%$/u, "")) / 100;
  return Number.isFinite(scale) && scale >= MIN_PDF_SCALE && scale <= MAX_PDF_SCALE ? scale : null;
}

/** Keep normal pages in one canvas; large pages retain full resolution in visible tiles. */
export function pdfRenderTiles(page, visible, pixelRatio) {
  const { width, height } = page;
  if (width * height * pixelRatio ** 2 <= 16_000_000 && Math.max(width, height) * pixelRatio <= 8192) {
    return [{ key: "page", left: 0, top: 0, width, height }];
  }
  const tileSize = 512;
  const margin = 128;
  const left = Math.max(0, visible.left - margin);
  const top = Math.max(0, visible.top - margin);
  const right = Math.min(width, visible.left + visible.width + margin);
  const bottom = Math.min(height, visible.top + visible.height + margin);
  const tiles = [];
  for (let y = Math.floor(top / tileSize) * tileSize; y < bottom; y += tileSize) {
    for (let x = Math.floor(left / tileSize) * tileSize; x < right; x += tileSize) {
      tiles.push({ key: `${x}:${y}`, left: x, top: y, width: Math.min(tileSize, width - x), height: Math.min(tileSize, height - y) });
    }
  }
  return tiles;
}
