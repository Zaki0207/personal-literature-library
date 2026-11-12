import { readJsonBody, sendJson } from "../library-api-http.mjs";

export async function handlePdfNoteRoutes({ request, response, pathname, pdfNotesService }) {
  const match = /^\/api\/papers\/([a-zA-Z0-9_-]{1,128})\/pdf-(notes|highlights)(?:\/([a-zA-Z0-9_-]{1,128}))?$/u.exec(pathname);
  if (!match) return false;
  const [, paperId, kind, id] = match;
  const highlights = kind === "highlights";
  let result;
  if (!id && request.method === "GET") {
    const pdfVersion = new URL(request.url, "http://127.0.0.1").searchParams.get("pdfVersion");
    result = highlights ? await pdfNotesService.listHighlights(paperId, pdfVersion) : await pdfNotesService.list(paperId, pdfVersion);
  } else if (id && request.method === "PUT") {
    const body = await readJsonBody(request);
    result = highlights ? await pdfNotesService.saveHighlight(paperId, id, body) : await pdfNotesService.save(paperId, id, body);
  } else if (id && request.method === "DELETE") {
    const body = await readJsonBody(request);
    result = highlights ? await pdfNotesService.removeHighlight(paperId, id, body) : await pdfNotesService.remove(paperId, id, body);
  } else return false;
  sendJson(response, request, 200, result);
  return true;
}
