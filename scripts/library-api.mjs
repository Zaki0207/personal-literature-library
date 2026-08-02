#!/usr/bin/env node

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createLibraryRepository,
  NotFoundError,
  ValidationError,
} from "./library-repository.mjs";
import { createAiService } from "./ai/ai-service.mjs";
import { MacOsKeychainCredentialStore } from "./ai/credential-store.mjs";
import { createAiProviders } from "./ai/providers.mjs";
import { createPaperIntakeService } from "./paper-intake.mjs";
import { createPdfArchiveService } from "./pdf-archive-service.mjs";
import { createLiteratureRadarService } from "./literature-radar.mjs";

export const DEFAULT_API_PORT = 4317;
export const API_HOST = "127.0.0.1";

const MAX_BODY_BYTES = 1_048_576;
const ALLOWED_LOCAL_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
  "https://personal-literature-library-zhaozizyu.taxable-orbital-9dke.chatgpt.site",
]);

function allowedOrigin(origin) {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (ALLOWED_LOCAL_ORIGINS.has(url.origin)) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

function responseHeaders(request, extra = {}) {
  const origin = allowedOrigin(request.headers.origin);
  return {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...(origin
      ? {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
        }
      : {}),
    ...extra,
  };
}

function sendJson(response, request, statusCode, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    ...responseHeaders(request, extraHeaders),
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendNoContent(response, request) {
  const origin = allowedOrigin(request.headers.origin);
  response.writeHead(204, {
    "Cache-Control": "no-store",
    ...(origin
      ? {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
        }
      : {}),
    "Access-Control-Allow-Methods":
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  });
  response.end();
}

function sendRedirect(response, request, location) {
  response.writeHead(302, {
    ...responseHeaders(request, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": "0",
      Location: location,
      "Referrer-Policy": "no-referrer",
    }),
  });
  response.end();
}

function pdfFilename(title) {
  const name = String(title ?? "论文")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return `${name || "论文"}.pdf`;
}

function parsePdfRange(value, sizeBytes) {
  if (!value) return { start: 0, end: sizeBytes - 1 };
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/u);
  if (!match) return null;
  const [, startText, endText] = match;
  if (!startText && !endText) return null;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, sizeBytes - suffixLength),
      end: sizeBytes - 1,
    };
  }
  const start = Number(startText);
  const end = endText ? Number(endText) : sizeBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= sizeBytes
  ) {
    return null;
  }
  return { start, end: Math.min(end, sizeBytes - 1) };
}

function sendPdfFile(response, request, file, title) {
  const range = parsePdfRange(request.headers.range, file.sizeBytes);
  if (!range) {
    response.writeHead(416, {
      ...responseHeaders(request, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Range": `bytes */${file.sizeBytes}`,
        "Content-Length": "0",
        "Accept-Ranges": "bytes",
      }),
    });
    response.end();
    return;
  }
  const length = range.end - range.start + 1;
  const partial = Boolean(request.headers.range);
  const filename = pdfFilename(title);
  response.writeHead(partial ? 206 : 200, {
    ...responseHeaders(request, {
      "Content-Type": "application/pdf",
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      ...(partial
        ? { "Content-Range": `bytes ${range.start}-${range.end}/${file.sizeBytes}` }
        : {}),
      "Content-Disposition": `inline; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    }),
  });
  const stream = createReadStream(file.path, {
    start: range.start,
    end: range.end,
  });
  stream.once("error", () => response.destroy());
  stream.pipe(response);
}

function assertAiRequestOrigin(request) {
  const origin = request.headers.origin;
  if (origin && !allowedOrigin(origin)) {
    const error = new Error("AI 配置接口只接受本机页面请求。");
    error.statusCode = 403;
    error.code = "ORIGIN_NOT_ALLOWED";
    throw error;
  }
}

function assertPdfRequestOrigin(request) {
  const origin = request.headers.origin;
  if (origin && !allowedOrigin(origin)) {
    const error = new Error("PDF 归档接口只接受本机页面请求。");
    error.statusCode = 403;
    error.code = "ORIGIN_NOT_ALLOWED";
    throw error;
  }
}

function readPdfArchiveOptions(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new ValidationError("请求正文必须是 JSON 对象。");
  }
  const fields = Object.keys(input);
  if (fields.some((field) => field !== "force")) {
    throw new ValidationError("PDF 归档请求仅支持 force 字段。");
  }
  if (input.force !== undefined && typeof input.force !== "boolean") {
    throw new ValidationError("force 必须是布尔值。");
  }
  return { force: input.force === true };
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLocaleLowerCase("en").includes("application/json")) {
    throw new ValidationError("Content-Type 必须是 application/json。");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new ValidationError("请求正文不能超过 1 MiB。");
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    throw new ValidationError("请求正文不能为空。");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("请求正文不是有效的 JSON。");
  }
}

async function readOptionalJsonBody(request) {
  const contentLength = request.headers["content-length"];
  if (
    (contentLength === undefined || contentLength === "0") &&
    request.headers["transfer-encoding"] === undefined
  ) {
    return {};
  }
  return readJsonBody(request);
}

function routePaperId(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/papers/([^/]+)/${suffix}$`)
    : /^\/api\/papers\/([^/]+)$/;
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ValidationError("论文 ID 编码无效。");
  }
}

function routeCategoryId(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/categories/([^/]+)/${suffix}$`)
    : /^\/api\/categories\/([^/]+)$/;
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ValidationError("分类 ID 编码无效。");
  }
}

function routeAiConnection(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/ai/connections/([^/]+)/${suffix}$`)
    : /^\/api\/ai\/connections\/([^/]+)$/;
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ValidationError("AI 服务连接 ID 编码无效。");
  }
}

function routeAiModel(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/ai/models/([^/]+)/${suffix}$`)
    : /^\/api\/ai\/models\/([^/]+)$/;
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ValidationError("AI 模型配置 ID 编码无效。");
  }
}

function routeRadarItem(pathname, suffix) {
  const pattern = new RegExp(`^/api/radar/items/([^/]+)/${suffix}$`);
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ValidationError("文献雷达条目 ID 编码无效。");
  }
}

function errorPayload(error) {
  return {
    error: {
      code: error.code ?? "INTERNAL_ERROR",
      message:
        error.statusCode && error.message
          ? error.message
          : "本地文献库发生内部错误。",
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function createRequestHandler(
  repository,
  aiService,
  paperIntakeService,
  pdfArchiveService,
  literatureRadarService,
) {
  return async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        sendNoContent(response, request);
        return;
      }

      const url = new URL(request.url ?? "/", `http://${API_HOST}`);
      const pathname =
        url.pathname.length > 1 && url.pathname.endsWith("/")
          ? url.pathname.slice(0, -1)
          : url.pathname;

      if (request.method === "GET" && pathname === "/api/library") {
        sendJson(response, request, 200, repository.getLibrary());
        return;
      }

      if (request.method === "GET" && pathname === "/api/categories") {
        sendJson(response, request, 200, repository.getCategories());
        return;
      }

      if (request.method === "GET" && pathname === "/api/health") {
        sendJson(response, request, 200, {
          ok: true,
          integrity: repository.integrityCheck(),
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/ai/settings") {
        assertAiRequestOrigin(request);
        sendJson(response, request, 200, await aiService.getSettings());
        return;
      }

      if (request.method === "GET" && pathname === "/api/radar") {
        assertAiRequestOrigin(request);
        sendJson(response, request, 200, literatureRadarService.getState());
        return;
      }

      if (request.method === "POST" && pathname === "/api/radar/run") {
        assertAiRequestOrigin(request);
        const result = await literatureRadarService.run(
          await readJsonBody(request),
        );
        sendJson(response, request, 200, result);
        return;
      }

      const discardRadarItemId = routeRadarItem(pathname, "discard");
      if (request.method === "POST" && discardRadarItemId !== null) {
        assertAiRequestOrigin(request);
        await repository.discardRadarItem(discardRadarItemId);
        sendJson(response, request, 200, repository.getRadarState());
        return;
      }

      const restoreRadarItemId = routeRadarItem(pathname, "restore");
      if (request.method === "POST" && restoreRadarItemId !== null) {
        assertAiRequestOrigin(request);
        await repository.restoreRadarItem(restoreRadarItemId);
        sendJson(response, request, 200, repository.getRadarState());
        return;
      }

      const addRadarItemId = routeRadarItem(pathname, "add");
      if (request.method === "POST" && addRadarItemId !== null) {
        assertAiRequestOrigin(request);
        const item = repository.getRadarItem(addRadarItemId);
        if (!item) throw new NotFoundError("未找到文献雷达条目。");
        if (item.status !== "pending") {
          const error = new Error("只有待审核论文可以加入知识库。");
          error.statusCode = 409;
          error.code = "CONFLICT";
          throw error;
        }
        const created = await repository.createPaper({
          title: item.title,
          zhTitle: item.zhTitle,
          authors: item.authors,
          institution: item.institution,
          source: item.source,
          date: item.date,
          aiSummary: item.aiSummary,
          originalUrl: item.originalUrl,
          pdfUrl: item.pdfUrl,
          hasPdf: Boolean(item.pdfUrl),
          identifiers: item.identifiers,
        });
        await repository.markRadarItemAdded(addRadarItemId, created.paper.id);
        sendJson(response, request, 201, {
          paper: created.paper,
          library: repository.getLibrary(),
          radar: repository.getRadarState(),
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/paper-intake/analyze") {
        assertAiRequestOrigin(request);
        const result = await paperIntakeService.analyze(
          await readJsonBody(request),
        );
        sendJson(response, request, 200, result);
        return;
      }

      if (request.method === "POST" && pathname === "/api/ai/connections") {
        assertAiRequestOrigin(request);
        const result = await aiService.verifyAndSave(
          null,
          await readJsonBody(request),
        );
        sendJson(response, request, 200, result);
        return;
      }

      const verifyAiConnection = routeAiConnection(pathname, "models/verify");
      if (request.method === "POST" && verifyAiConnection !== null) {
        assertAiRequestOrigin(request);
        const result = await aiService.verifyAndSave(
          verifyAiConnection,
          await readJsonBody(request),
        );
        sendJson(response, request, 200, result);
        return;
      }

      const activeAiModel = routeAiModel(pathname, "active");
      if (request.method === "PUT" && activeAiModel !== null) {
        assertAiRequestOrigin(request);
        const result = await aiService.setActiveModel(activeAiModel);
        sendJson(response, request, 200, result);
        return;
      }

      const aiModel = routeAiModel(pathname);
      if (request.method === "DELETE" && aiModel !== null) {
        assertAiRequestOrigin(request);
        const result = await aiService.deleteModel(aiModel);
        sendJson(response, request, 200, result);
        return;
      }

      const aiConnection = routeAiConnection(pathname);
      if (request.method === "PATCH" && aiConnection !== null) {
        assertAiRequestOrigin(request);
        const result = await aiService.updateConnection(
          aiConnection,
          await readJsonBody(request),
        );
        sendJson(response, request, 200, result);
        return;
      }

      if (request.method === "DELETE" && aiConnection !== null) {
        assertAiRequestOrigin(request);
        const result = await aiService.deleteConnection(aiConnection);
        sendJson(response, request, 200, result);
        return;
      }

      if (request.method === "POST" && pathname === "/api/papers") {
        const result = await repository.createPaper(
          await readJsonBody(request),
        );
        sendJson(response, request, 201, result);
        return;
      }

      const openPdfId = routePaperId(pathname, "pdf/open");
      if (request.method === "GET" && openPdfId !== null) {
        const paper = repository.getPaper(openPdfId);
        if (!paper) throw new NotFoundError("未找到论文。");
        const localPdf = await pdfArchiveService.getLocalPdf(openPdfId);
        if (localPdf) {
          sendPdfFile(response, request, localPdf, paper.title);
          return;
        }
        if (paper.pdfUrl) {
          sendRedirect(response, request, paper.pdfUrl);
          return;
        }
        const error = new Error("该论文尚未保存本地 PDF，也没有可访问的 PDF 来源链接。");
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
        return;
      }

      if (request.method === "DELETE" && archivePdfId !== null) {
        assertPdfRequestOrigin(request);
        const result = await pdfArchiveService.removeLocalPdf(archivePdfId);
        sendJson(response, request, 200, result);
        return;
      }

      const importPdfId = routePaperId(pathname, "pdf/import");
      if (request.method === "POST" && importPdfId !== null) {
        assertPdfRequestOrigin(request);
        const result = await pdfArchiveService.importPdf(importPdfId, request);
        sendJson(response, request, 200, result);
        return;
      }

      if (request.method === "POST" && pathname === "/api/categories") {
        const result = await repository.createCategory(
          await readJsonBody(request),
        );
        sendJson(response, request, 201, result);
        return;
      }

      if (request.method === "PUT" && pathname === "/api/categories/reorder") {
        const result = await repository.reorderCategories(
          await readJsonBody(request),
        );
        sendJson(response, request, 200, result);
        return;
      }

      const restoreCategoryId = routeCategoryId(pathname, "restore");
      if (request.method === "POST" && restoreCategoryId !== null) {
        const result = await repository.restoreCategory(restoreCategoryId);
        sendJson(response, request, 200, result);
        return;
      }

      const categoryId = routeCategoryId(pathname);
      if (request.method === "PATCH" && categoryId !== null) {
        const result = await repository.updateCategory(
          categoryId,
          await readJsonBody(request),
        );
        sendJson(response, request, 200, result);
        return;
      }

      if (request.method === "DELETE" && categoryId !== null) {
        const result = await repository.deleteCategory(
          categoryId,
          await readOptionalJsonBody(request),
        );
        sendJson(response, request, 200, result);
        return;
      }

      const restoreId = routePaperId(pathname, "restore");
      if (request.method === "POST" && restoreId !== null) {
        const result = await repository.restorePaper(restoreId);
        sendJson(response, request, 200, result);
        return;
      }

      const paperId = routePaperId(pathname);
      if (request.method === "PATCH" && paperId !== null) {
        const result = await repository.updatePaper(
          paperId,
          await readJsonBody(request),
        );
        sendJson(response, request, 200, result);
        return;
      }

      if (request.method === "DELETE" && paperId !== null) {
        const result = await repository.deletePaper(paperId);
        sendJson(response, request, 200, result);
        return;
      }

      sendJson(response, request, 404, {
        error: {
          code: "ROUTE_NOT_FOUND",
          message: "未找到请求的本地 API。",
        },
      });
    } catch (error) {
      const statusCode =
        Number.isInteger(error?.statusCode) && error.statusCode >= 400
          ? error.statusCode
          : 500;
      if (statusCode === 500) {
        console.error("[library-api]", error);
      }
      if (!response.headersSent) {
        sendJson(response, request, statusCode, errorPayload(error));
      } else {
        response.destroy();
      }
    }
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, API_HOST);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

export async function createLibraryApi({
  port = DEFAULT_API_PORT,
  repository,
  dbPath,
  backupDir,
  seedPath,
  now,
  aiService,
  credentialStore,
  aiFetch,
  metadataFetch,
  pdfArchiveService,
  literatureRadarService,
  pdfDirectory,
  pdfFetch,
  allowPrivatePdfNetwork,
} = {}) {
  const ownsRepository = !repository;
  const libraryRepository =
    repository ??
    (await createLibraryRepository({
      ...(dbPath ? { dbPath } : {}),
      ...(backupDir ? { backupDir } : {}),
      ...(seedPath !== undefined ? { seedPath } : {}),
      ...(now ? { now } : {}),
    }));
  const localAiService =
    aiService ??
    createAiService({
      repository: libraryRepository,
      credentialStore:
        credentialStore ?? new MacOsKeychainCredentialStore(),
      providers: createAiProviders({
        ...(aiFetch ? { fetchImpl: aiFetch } : {}),
      }),
    });
  const paperIntakeService = createPaperIntakeService({
    repository: libraryRepository,
    aiService: localAiService,
    ...(metadataFetch ? { fetchImpl: metadataFetch } : {}),
  });
  const localPdfArchiveService =
    pdfArchiveService ??
    createPdfArchiveService({
      repository: libraryRepository,
      ...(pdfDirectory ? { pdfDirectory } : {}),
      ...(pdfFetch ? { fetchImpl: pdfFetch } : {}),
      ...(allowPrivatePdfNetwork ? { allowPrivateNetwork: true } : {}),
    });
  const localLiteratureRadarService =
    literatureRadarService ??
    createLiteratureRadarService({
      repository: libraryRepository,
      aiService: localAiService,
    });
  const server = createServer(
    createRequestHandler(
      libraryRepository,
      localAiService,
      paperIntakeService,
      localPdfArchiveService,
      localLiteratureRadarService,
    ),
  );
  let started = false;
  let closed = false;

  return {
    repository: libraryRepository,
    aiService: localAiService,
    paperIntakeService,
    pdfArchiveService: localPdfArchiveService,
    literatureRadarService: localLiteratureRadarService,
    server,

    async listen(overridePort = port) {
      if (closed) throw new Error("本地 API 已关闭。");
      if (!started) {
        await listen(server, overridePort);
        started = true;
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("无法确定本地 API 地址。");
      }
      return {
        host: API_HOST,
        port: address.port,
        url: `http://${API_HOST}:${address.port}`,
      };
    },

    address() {
      const address = server.address();
      if (!address || typeof address === "string") return null;
      return {
        host: API_HOST,
        port: address.port,
        url: `http://${API_HOST}:${address.port}`,
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      await closeServer(server);
      if (ownsRepository) await libraryRepository.close();
    },
  };
}

export async function startLibraryApi(options = {}) {
  const api = await createLibraryApi(options);
  const address = await api.listen();
  return { ...api, addressInfo: address };
}

async function main() {
  const portText = process.env.LIBRARY_API_PORT;
  const port =
    portText === undefined ? DEFAULT_API_PORT : Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("LIBRARY_API_PORT 必须是 0 到 65535 之间的整数。");
  }

  const api = await createLibraryApi({
    port,
    ...(process.env.LIBRARY_DB_PATH
      ? { dbPath: process.env.LIBRARY_DB_PATH }
      : {}),
    ...(process.env.LIBRARY_BACKUP_DIR
      ? { backupDir: process.env.LIBRARY_BACKUP_DIR }
      : {}),
    ...(process.env.LIBRARY_SEED_PATH
      ? { seedPath: process.env.LIBRARY_SEED_PATH }
      : {}),
    ...(process.env.LIBRARY_PDF_DIR
      ? { pdfDirectory: process.env.LIBRARY_PDF_DIR }
      : {}),
  });
  const address = await api.listen();
  console.log(`本地文献库 API：${address.url}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await api.close();
  };
  process.once("SIGINT", async () => {
    await shutdown();
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    await shutdown();
    process.exit(143);
  });
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
