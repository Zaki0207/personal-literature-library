import assert from "node:assert/strict";
import test from "node:test";
import { capturePdfPoint, restorePdfPoint } from "../app/library/pdf-zoom-anchor.mjs";

function screenPoint(anchor, page, contentWidth, scroll) {
  return {
    x: (contentWidth - page.width) / 2 + anchor.xRatio * page.width - scroll.scrollLeft,
    y: page.top + anchor.yRatio * page.height - scroll.scrollTop,
  };
}

test("pinch keeps a PDF point at its screen position when centered pages grow into horizontal overflow", () => {
  const oldPage = { pageNumber: 2, top: 868, width: 612, height: 792 };
  const anchor = capturePdfPoint([oldPage], {
    scrollTop: 900, scrollLeft: 0, viewportWidth: 900,
    clientX: 540, clientY: 380, viewportLeft: 100, viewportTop: 80,
    contentWidth: 900,
  });
  const newPage = { pageNumber: 2, top: 1660, width: 1224, height: 1584 };
  const scroll = restorePdfPoint(anchor, newPage, { contentWidth: 1288, viewportWidth: 900 });
  assert.ok(scroll.scrollLeft > 0);
  assert.ok(scroll.scrollTop > 900);
  const screen = screenPoint(anchor, newPage, 1288, scroll);
  assert.ok(Math.abs(screen.x - anchor.viewportX) < 1e-9);
  assert.ok(Math.abs(screen.y - anchor.viewportY) < 1e-9);
});

test("anchor restoration accounts for fixed gaps, unequal page dimensions and existing horizontal scroll", () => {
  const layouts = [
    { pageNumber: 1, top: 28, width: 900, height: 1100 },
    { pageNumber: 2, top: 1180, width: 700, height: 950 },
    { pageNumber: 3, top: 2182, width: 1200, height: 800 },
  ];
  const before = { scrollTop: 1300, scrollLeft: 240, viewportWidth: 800, clientX: 600, clientY: 330, viewportLeft: 90, viewportTop: 50, contentWidth: 1264 };
  const anchor = capturePdfPoint(layouts, before);
  assert.equal(anchor.pageNumber, 2);
  const enlarged = { pageNumber: 2, top: 2280, width: 1400, height: 1900 };
  const after = restorePdfPoint(anchor, enlarged, { contentWidth: 2464, viewportWidth: 800 });
  const screen = screenPoint(anchor, enlarged, 2464, after);
  assert.ok(Math.abs(screen.x - 510) < 1e-9);
  assert.ok(Math.abs(screen.y - 280) < 1e-9);
  // Fixed 28 px padding and 52 px gap must not be multiplied with the page scale.
  assert.notEqual(after.scrollTop, before.scrollTop * 2 + anchor.viewportY);
});

test("an off-page gesture anchors the nearest page edge and clamps unavoidable scroll boundaries", () => {
  const layouts = [{ pageNumber: 1, top: 28, width: 612, height: 792 }, { pageNumber: 2, top: 872, width: 612, height: 792 }];
  const base = { scrollTop: 800, scrollLeft: 0, viewportWidth: 900, clientX: 0, viewportLeft: 0, viewportTop: 0, contentWidth: 900 };
  const previousEdge = capturePdfPoint(layouts, { ...base, clientY: 30 });
  assert.equal(previousEdge.pageNumber, 1);
  assert.equal(previousEdge.xRatio, 0);
  assert.equal(previousEdge.yRatio, 1);
  const followingEdge = capturePdfPoint(layouts, { ...base, clientY: 60 });
  assert.equal(followingEdge.pageNumber, 2);
  assert.equal(followingEdge.yRatio, 0);
  const reduced = { pageNumber: 2, top: 476, width: 306, height: 396 };
  const clamped = restorePdfPoint(followingEdge, reduced, { contentWidth: 900, viewportWidth: 900, contentHeight: 900, viewportHeight: 800 });
  assert.equal(clamped.scrollLeft, 0);
  assert.equal(clamped.scrollTop, 100);
});

test("zooming in and back out restores the original scroll when both axes have room", () => {
  const page = { pageNumber: 2, top: 1500, width: 1100, height: 1500 };
  const viewport = { scrollTop: 1750, scrollLeft: 200, viewportWidth: 700, clientX: 450, clientY: 350, viewportLeft: 100, viewportTop: 50, contentWidth: 1464 };
  const anchor = capturePdfPoint([page], viewport);
  const doubled = { pageNumber: 2, top: 2920, width: 2200, height: 3000 };
  const scaled = restorePdfPoint(anchor, doubled, { contentWidth: 2864, viewportWidth: 700 });
  const recaptured = capturePdfPoint([doubled], { ...viewport, ...scaled, contentWidth: 2864 });
  const restored = restorePdfPoint(recaptured, page, { contentWidth: 1464, viewportWidth: 700 });
  assert.ok(Math.abs(restored.scrollTop - viewport.scrollTop) < 1e-9);
  assert.ok(Math.abs(restored.scrollLeft - viewport.scrollLeft) < 1e-9);
});

test("empty or missing page geometry has no anchor and invalid finite coordinates are rejected", () => {
  assert.equal(capturePdfPoint([], {}), null);
  assert.equal(restorePdfPoint(null, undefined, {}), null);
  assert.throws(() => capturePdfPoint([{ pageNumber: 1, top: 28, width: 612, height: 792 }], {
    scrollTop: 0, scrollLeft: 0, viewportWidth: 900, clientX: NaN, clientY: 0, viewportLeft: 0, viewportTop: 0, contentWidth: 900,
  }), /finite coordinates/u);
});
