import type { PageViewport, TextLayer } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api.js";

export function alignPdfTextLayer(textLayer: TextLayer, textContent: TextContent, container: HTMLDivElement, viewport: PageViewport): void;
