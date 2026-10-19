import { readJsonBody, routePaperId, sendJson } from "../library-api-http.mjs";

export async function handleReadingRoutes({
  request, response, pathname, readingStateService,
}) {
  const paperId = routePaperId(pathname, "reading-position");
  if (paperId === null) return false;
  if (request.method === "GET") {
    const url = new URL(request.url ?? pathname, "http://127.0.0.1");
    const pdfVersion = url.searchParams.get("pdfVersion") || undefined;
    const result = await readingStateService.getPosition(paperId, { pdfVersion });
    sendJson(response, request, 200, result);
    return true;
  }
  if (request.method === "PUT") {
    const result = await readingStateService.savePosition(paperId, await readJsonBody(request));
    sendJson(response, request, 200, result);
    return true;
  }
  return false;
}
