/** Small deterministic PDFs for desktop smoke tests; no external dependencies. */

function pdfString(value) {
  return `(${String(value).replace(/[\\()]/gu, "\\$&")})`;
}

function documentBytes(objects, { catalogId = 1, infoId } = {}) {
  const chunks = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [0];
  let length = chunks[0].length;
  for (let index = 0; index < objects.length; index += 1) {
    const body = objects[index];
    if (typeof body !== "string") throw new Error("PDF fixture object is missing.");
    offsets.push(length);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    chunks.push(chunk);
    length += chunk.length;
  }
  const xref = length;
  const entries = offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  chunks.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R${infoId ? ` /Info ${infoId} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`,
    "latin1",
  ));
  return Buffer.concat(chunks);
}

function pageStream(lines) {
  const content = lines.map(({ text, y, size = 16 }) =>
    `BT /F1 ${size} Tf 50 ${y} Td ${pdfString(text)} Tj ET`,
  ).join("\n");
  return `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
}

function pageObjects(texts, dimensions = []) {
  const objects = [null, null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const pages = [];
  for (const [index, lines] of texts.entries()) {
    const pageId = objects.length + 1;
    const streamId = pageId + 1;
    pages.push(pageId);
    const [width, height] = dimensions[index] ?? [612, 792];
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    objects.push(pageStream(lines));
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] >>`;
  return { objects, pages };
}

/** Three searchable pages with an expanded nested outline and named destination. */
export function createSmokePdf() {
  const labels = [
    "Gaussian reconstruction reader smoke page one",
    "Dynamic reconstruction reader smoke page two",
    "Spectral analysis reader smoke page three",
  ];
  const { objects, pages } = pageObjects(labels.map((text, index) => [
    { text, y: index === 2 ? 560 : 740 },
    { text: `Reader smoke middle anchor page ${index + 1}`, y: index === 2 ? 300 : 380 },
    { text: `Synthetic document footer ${index + 1}`, y: 65, size: 12 },
  ]), [[612, 792], [612, 792], [792, 612]]);
  const outlineRoot = objects.length + 1;
  const first = outlineRoot + 1;
  const nestedDynamic = first + 1;
  const nestedSpectral = first + 2;
  const last = first + 3;
  const destinations = first + 4;
  const info = destinations + 1;
  objects[0] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineRoot} 0 R /PageMode /UseOutlines /Names << /Dests ${destinations} 0 R >> >>`;
  objects.push(`<< /Type /Outlines /First ${first} 0 R /Last ${last} 0 R /Count 4 >>`);
  objects.push(`<< /Title ${pdfString("1. Gaussian Reconstruction")} /Parent ${outlineRoot} 0 R /Next ${last} 0 R /First ${nestedDynamic} 0 R /Last ${nestedSpectral} 0 R /Count 2 /Dest [${pages[0]} 0 R /XYZ 0 740 null] >>`);
  objects.push(`<< /Title ${pdfString("1.1 Dynamic Reconstruction")} /Parent ${first} 0 R /Next ${nestedSpectral} 0 R /Dest ${pdfString("dynamic-method")} >>`);
  objects.push(`<< /Title ${pdfString("1.2 Spectral Analysis")} /Parent ${first} 0 R /Prev ${nestedDynamic} 0 R /Dest [${pages[2]} 0 R /XYZ 0 380 null] >>`);
  objects.push(`<< /Title ${pdfString("2. Spectral Results")} /Parent ${outlineRoot} 0 R /Prev ${first} 0 R /Dest [${pages[2]} 0 R /XYZ 0 560 null] >>`);
  objects.push(`<< /Names [${pdfString("dynamic-method")} [${pages[1]} 0 R /XYZ 0 380 null]] >>`);
  objects.push(`<< /Title ${pdfString("Desktop searchable PDF outline fixture")} /Producer ${pdfString("Personal Literature Library smoke tests")} >>`);
  return documentBytes(objects, { infoId: info });
}

/** A searchable long document with no outline, to verify bounded page rendering. */
export function createLongSmokePdf({ pageCount = 40 } = {}) {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 1000) {
    throw new Error("Smoke PDF pageCount must be an integer from 1 to 1000.");
  }
  const { objects } = pageObjects(Array.from({ length: pageCount }, (_, index) => {
    const number = index + 1;
    return [
      { text: `Continuous reading smoke page ${number} of ${pageCount}`, y: 740 },
      { text: `Long document unique anchor page ${String(number).padStart(3, "0")} middle`, y: 380 },
      { text: `Long document footer page ${number}`, y: 65, size: 12 },
    ];
  }));
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  return documentBytes(objects);
}

/** Embedded citation links, precise destinations, backlinks and a rotated page. */
export function createLinkedSmokePdf() {
  const { objects, pages } = pageObjects([
    [{ text: "Citation [1]", y: 700 }, { text: "Same page section", y: 650 }, { text: "Rotated target [2]", y: 600 },
      { text: "External DOI", y: 550 }, { text: "Broken citation [9]", y: 500 }, { text: "Unsafe script link", y: 450 }, { text: "Section target", y: 300 }],
    [{ text: "Bibliography", y: 740 }, { text: "Reference [1] (back)", y: 380 }],
    [{ text: "Rotated page", y: 740 }, { text: "Rotated backlink", y: 650 }, { text: "Rotated target", y: 350 }],
    [{ text: "Last page after references", y: 740 }],
  ]);
  objects[pages[2] - 1] = objects[pages[2] - 1].replace("/Type /Page ", "/Type /Page /Rotate 90 ");
  const addLink = (pageIndex, label, rect, action) => {
    const id = objects.length + 1;
    objects.push(`<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /Contents ${pdfString(label)} ${action} >>`);
    const index = pages[pageIndex] - 1;
    if (objects[index].includes("/Annots")) objects[index] = objects[index].replace(/\/Annots \[([^\]]*)\]/u, (_, refs) => `/Annots [${refs} ${id} 0 R]`);
    else objects[index] = objects[index].replace("/Contents", `/Annots [${id} 0 R] /Contents`);
  };
  addLink(0, "Citation [1]", "50 694 150 716", `/A << /S /GoTo /D ${pdfString("reference.one")} >>`);
  addLink(0, "Same page section", "50 644 205 666", `/Dest [${pages[0]} 0 R /XYZ 50 315 null]`);
  addLink(0, "Rotated target [2]", "50 594 205 616", `/Dest [${pages[2]} 0 R /XYZ 280 350 null]`);
  addLink(0, "External DOI", "50 544 170 566", `/A << /S /URI /URI ${pdfString("https://doi.org/10.0000/test")} >>`);
  addLink(0, "Broken citation [9]", "50 494 205 516", `/Dest ${pdfString("missing.reference")}`);
  addLink(0, "Unsafe script link", "50 444 205 466", `/A << /S /URI /URI ${pdfString("javascript:alert(1)")} >>`);
  addLink(1, "Reference [1] (back)", "50 374 225 396", `/Dest [${pages[0]} 0 R /XYZ 50 710 null]`);
  addLink(2, "Rotated backlink", "50 644 205 666", `/Dest [${pages[0]} 0 R /FitH 710]`);
  const destinations = objects.length + 1;
  objects.push(`<< /Names [${pdfString("reference.one")} [${pages[1]} 0 R /XYZ 50 395 null]] >>`);
  objects[0] = `<< /Type /Catalog /Pages 2 0 R /Names << /Dests ${destinations} 0 R >> >>`;
  return documentBytes(objects);
}
