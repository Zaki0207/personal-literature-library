import assert from "node:assert/strict";
import test from "node:test";
import { pdfLinkRectangles, resolvePdfDestination, safePdfLinkUrl } from "../lib/pdf-links.mjs";
import { createLinkedSmokePdf } from "../scripts/desktop-pdf-fixture.mjs";
import { fileURLToPath } from "node:url";

function mockDocument(rotation = 0) {
  const viewport = {
    width: rotation ? 792 : 612, height: rotation ? 612 : 792,
    convertToViewportPoint: (x, y) => rotation ? [y, x] : [x, 792 - y],
  };
  const document = {
    numPages: 4,
    getDestination: async (name) => name === "ref.one" ? [{ num: 12, gen: 0 }, { name: "XYZ" }, 50, 395, null] : null,
    getPageIndex: async (ref) => { assert.deepEqual(ref, { num: 12, gen: 0 }); return 1; },
    getPage: async () => ({ view: [0, 0, 612, 792], rotate: rotation, getViewport: () => viewport }),
  };
  return { document, viewport };
}

test("named citations and explicit page references resolve to the exact reference position", async () => {
  const { document } = mockDocument();
  assert.deepEqual(await resolvePdfDestination(document, "ref.one"), { pageNumber: 2, xRatio: 50 / 612, yRatio: 397 / 792 });
  assert.deepEqual(await resolvePdfDestination(document, [0, { name: "XYZ" }, null, 315, null]), { pageNumber: 1, yRatio: 477 / 792 });
  assert.deepEqual(await resolvePdfDestination(document, [2, { name: "FitH" }, 710]), { pageNumber: 3, yRatio: 82 / 792 });
  assert.deepEqual(await resolvePdfDestination(document, [0, { name: "Fit" }]), { pageNumber: 1, yRatio: 0 });
});

test("destinations and clickable regions account for page rotation", async () => {
  const { document, viewport } = mockDocument(90);
  assert.deepEqual(await resolvePdfDestination(document, [2, { name: "XYZ" }, 280, 350, null]), { pageNumber: 3, xRatio: 350 / 792, yRatio: 280 / 612 });
  const [box] = pdfLinkRectangles({ rect: [50, 644, 205, 666] }, viewport);
  assert.equal(box.left, 644 / 792);
  assert.equal(box.top, 50 / 612);
  assert.ok(Math.abs(box.width - 22 / 792) < 1e-12);
});

test("multiline link hit regions leave the gap between lines selectable", () => {
  const { viewport } = mockDocument();
  const boxes = pdfLinkRectangles({ quadPoints: new Float32Array([50, 716, 150, 716, 50, 694, 150, 694, 50, 676, 150, 676, 50, 654, 150, 654]) }, viewport);
  assert.equal(boxes.length, 2);
  assert.ok(boxes[0].top + boxes[0].height < boxes[1].top);
  assert.deepEqual(pdfLinkRectangles({ rect: [0, NaN, 1, 2] }, viewport), []);
  assert.deepEqual(pdfLinkRectangles({ rect: [-100, -100, -50, -50] }, viewport), []);
});

test("broken destinations report an error without inventing a page", async () => {
  const { document } = mockDocument();
  for (const destination of ["missing", [], [-1, { name: "Fit" }], [4, { name: "Fit" }], [0, { name: "Unknown" }], [0, { name: "XYZ" }, 0, Infinity, null], [0, { name: "FitR" }, 10]]) {
    await assert.rejects(resolvePdfDestination(document, destination));
  }
});

test("external links allow web URLs and reject embedded scripts, local files and credentials", () => {
  assert.equal(safePdfLinkUrl("https://doi.org/10.0000/test"), "https://doi.org/10.0000/test");
  for (const value of ["javascript:alert(1)", "file:///tmp/test.pdf", "data:text/html,test", "https://user:secret@example.test/", "not a url", null]) assert.equal(safePdfLinkUrl(value), null);
});

test("installed PDF.js resolves real embedded citations and rotated annotation geometry", async () => {
  const { getDocument, AnnotationType } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(createLinkedSmokePdf()), standardFontDataUrl: fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)) });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const annotations = await page.getAnnotations({ intent: "display" });
    const citation = annotations.find((item) => item.contentsObj.str === "Citation [1]");
    assert.equal(citation.annotationType, AnnotationType.LINK);
    const boxes = pdfLinkRectangles(citation, page.getViewport({ scale: 1 }));
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].left, 50 / 612);
    assert.equal(boxes[0].top, 76 / 792);
    assert.deepEqual(await resolvePdfDestination(document, citation.dest), { pageNumber: 2, xRatio: 50 / 612, yRatio: 397 / 792 });
    const rotated = annotations.find((item) => item.contentsObj.str === "Rotated target [2]");
    assert.deepEqual(await resolvePdfDestination(document, rotated.dest), { pageNumber: 3, xRatio: 350 / 792, yRatio: 280 / 612 });
  } finally { await task.destroy(); }
});
