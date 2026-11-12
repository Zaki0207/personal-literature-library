import assert from "node:assert/strict";
import test from "node:test";
import { parsePdfScale, stepPdfScale, pdfRenderTiles } from "../lib/pdf-zoom.mjs";

test("百分比输入支持超过400%的倍率，并拒绝无效或越界输入", () => {
  for (const [input, expected] of [["25%", 0.25], [" 125.5 % ", 1.255], ["800", 8], ["6400%", 64]]) {
    assert.equal(parsePdfScale(input), expected);
  }
  for (const input of ["", "适应宽度", "0%", "24.99%", "6401%", "100abc", "Infinity", "-100", "1e3"]) {
    assert.equal(parsePdfScale(input), null, input);
  }
  assert.equal(stepPdfScale(4, 1), 5);
  assert.equal(stepPdfScale(60, 1), 64);
  assert.equal(stepPdfScale(0.3, -1), 0.25);
});

test("6400%横向及纵向滚动只分配可见区域画布，分块覆盖完整且像素数有界", () => {
  const page = { width: 612 * 64, height: 792 * 64 };
  for (const offset of [{ left: 19000, top: 25000 }, { left: page.width - 1100, top: page.height - 800 }]) {
    const visible = { ...offset, width: 1100, height: 800 };
    const tiles = pdfRenderTiles(page, visible, 2);
    assert.ok(tiles.length > 0 && tiles.length <= 20);
    assert.ok(tiles.every((tile) => tile.width <= 512 && tile.height <= 512 && tile.left >= 0 && tile.top >= 0 && tile.left + tile.width <= page.width && tile.top + tile.height <= page.height));
    assert.ok(tiles.reduce((pixels, tile) => pixels + tile.width * tile.height * 4, 0) <= 20 * 1024 * 1024);
    for (let y = visible.top; y < visible.top + visible.height; y += 50) {
      for (let x = visible.left; x < visible.left + visible.width; x += 50) {
        assert.ok(tiles.some((tile) => x >= tile.left && x < tile.left + tile.width && y >= tile.top && y < tile.top + tile.height));
      }
    }
  }
  assert.equal(pdfRenderTiles(page, { left: 0, top: -2000, width: 1000, height: 800 }, 2).length, 0);
  assert.equal(pdfRenderTiles(page, { left: page.width + 2000, top: 0, width: 1000, height: 800 }, 2).length, 0);
});

test("普通页面保持单画布，超长窄页也会分块以避免超过canvas边长限制", () => {
  assert.deepEqual(pdfRenderTiles({ width: 612, height: 792 }, { left: 0, top: 0, width: 900, height: 600 }, 2), [
    { key: "page", left: 0, top: 0, width: 612, height: 792 },
  ]);
  assert.ok(pdfRenderTiles({ width: 100, height: 20000 }, { left: 0, top: 10000, width: 900, height: 600 }, 1).every((tile) => tile.height <= 512));
});
