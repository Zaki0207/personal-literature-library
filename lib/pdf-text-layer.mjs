/** Align selectable text to PDF baselines using the browser's actual CSS font metrics. */
export function alignPdfTextLayer(textLayer, textContent, container, viewport) {
  const scale = viewport.scale * viewport.userUnit;
  const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
  // TextLayer uses unrotated page coordinates, then rotates the whole layer.
  // Its default dimensions also depend on viewer CSS variables we do not use.
  container.style.width = `${pageWidth * scale}px`;
  container.style.height = `${pageHeight * scale}px`;

  const minFontSize = Number.parseFloat(container.ownerDocument.defaultView.getComputedStyle(container).getPropertyValue("--min-font-size")) || 1;
  const runs = [];
  let index = 0;
  for (const item of textContent.items) {
    if (typeof item.str !== "string") continue;
    const span = textLayer.textDivs[index++];
    if (!span?.isConnected) continue;
    const marker = container.ownerDocument.createElement("i");
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText = "display:inline-block;position:static;width:0;height:0;margin:0;padding:0;border:0;font-size:0;line-height:0;vertical-align:baseline";
    runs.push({ item, span, marker, transform: span.style.transform });
  }

  const transform = container.style.transform;
  let metrics;
  try {
    // Batch writes and reads: one layout measures every run at its CSS size.
    // Measuring at devicePixelRatio * fontSize drifts with macOS optical fonts;
    // estimating ascent from generic font bounds shifts the whole selection.
    container.style.transform = "none";
    for (const { span, marker } of runs) { span.style.transform = "none"; span.append(marker); }
    metrics = runs.map(({ span, marker }) => {
      const bounds = span.getBoundingClientRect();
      return { width: bounds.width, baseline: (marker.getBoundingClientRect().top - bounds.top) / minFontSize };
    });
  } finally {
    container.style.transform = transform;
    for (const { span, marker, transform } of runs) { marker.remove(); span.style.transform = transform; }
  }

  for (let index = 0; index < runs.length; index += 1) {
    const { item, span } = runs[index];
    const { width, baseline } = metrics[index];
    const vertical = Boolean(textContent.styles[item.fontName]?.vertical);
    const angle = Math.atan2(-item.transform[1], item.transform[0]) + (vertical ? Math.PI / 2 : 0);
    const x = (item.transform[4] - pageX) * scale;
    const y = (pageY + pageHeight - item.transform[5]) * scale;
    span.style.left = `${x + baseline * Math.sin(angle)}px`;
    span.style.top = `${y - baseline * Math.cos(angle)}px`;
    const targetWidth = (vertical ? item.height : item.width) * scale;
    if (width > 0 && targetWidth > 0) span.style.setProperty("--scale-x", String(targetWidth * minFontSize / width));
  }
}
