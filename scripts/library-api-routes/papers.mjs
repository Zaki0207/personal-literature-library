import { NotFoundError } from "../library-repository.mjs";
import {
  assertAiRequestOrigin,
  assertPdfRequestOrigin,
  readJsonBody,
  readOptionalJsonBody,
  readPdfArchiveOptions,
  routePaperId,
  sendJson,
  sendPdfFile,
  sendRedirect,
} from "../library-api-http.mjs";

export async function handlePaperRoutes({
  request,
  response,
  pathname,
  repository,
  paperIntakeService,
  pdfArchiveService,
}) {
  if (request.method === "GET" && pathname === "/api/library") {
    sendJson(response, request, 200, repository.getLibrary());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, request, 200, {
      ok: true,
      integrity: repository.integrityCheck(),
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/paper-intake/analyze") {
    assertAiRequestOrigin(request);
    const result = await paperIntakeService.analyze(
      await readJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }

  if (request.method === "POST" && pathname === "/api/papers") {
    const result = await repository.createPaper(await readJsonBody(request));
    sendJson(response, request, 201, result);
    return true;
  }

  const openPdfId = routePaperId(pathname, "pdf/open");
  if (request.method === "GET" && openPdfId !== null) {
    const paper = repository.getPaper(openPdfId);
    if (!paper) throw new NotFoundError("未找到论文。");
    const localPdf = await pdfArchiveService.getLocalPdf(openPdfId);
    if (localPdf) {
      sendPdfFile(response, request, localPdf, paper.title);
      return true;
    }
    if (paper.pdfUrl) {
      sendRedirect(response, request, paper.pdfUrl);
      return true;
    }
    const error = new Error(
      "该论文尚未保存本地 PDF，也没有可访问的 PDF 来源链接。",
    );
    error.statusCode = 404;
    error.code = "PDF_SOURCE_UNAVAILABLE";
    throw error;
  }

  const archivePdfId = routePaperId(pathname, "pdf/archive");
  if (request.method === "POST" && archivePdfId !== null) {
    assertPdfRequestOrigin(request);
    const options = readPdfArchiveOptions(await readOptionalJsonBody(request));
    const result = await pdfArchiveService.archive(archivePdfId, options);
    sendJson(response, request, 200, result);
    return true;
  }
  if (request.method === "DELETE" && archivePdfId !== null) {
    assertPdfRequestOrigin(request);
    const result = await pdfArchiveService.removeLocalPdf(archivePdfId);
    sendJson(response, request, 200, result);
    return true;
  }

  const importPdfId = routePaperId(pathname, "pdf/import");
  if (request.method === "POST" && importPdfId !== null) {
    assertPdfRequestOrigin(request);
    const result = await pdfArchiveService.importPdf(importPdfId, request);
    sendJson(response, request, 200, result);
    return true;
  }

  const restoreId = routePaperId(pathname, "restore");
  if (request.method === "POST" && restoreId !== null) {
    const result = await repository.restorePaper(restoreId);
    sendJson(response, request, 200, result);
    return true;
  }

  const paperId = routePaperId(pathname);
  if (request.method === "PATCH" && paperId !== null) {
    const result = await repository.updatePaper(
      paperId,
      await readJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }
  if (request.method === "DELETE" && paperId !== null) {
    const result = await repository.deletePaper(paperId);
    sendJson(response, request, 200, result);
    return true;
  }

  return false;
}
