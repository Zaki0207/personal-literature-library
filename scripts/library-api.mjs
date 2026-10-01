#!/usr/bin/env node

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createLibraryRepository } from "./library-repository.mjs";
import { createAiService } from "./ai/ai-service.mjs";
import { MacOsKeychainCredentialStore } from "./ai/credential-store.mjs";
import { createAiProviders } from "./ai/providers.mjs";
import { createPaperIntakeService } from "./paper-intake.mjs";
import { createPdfArchiveService } from "./pdf-archive-service.mjs";
import { createLiteratureRadarService } from "./literature-radar.mjs";
import {
  assertMutationRequestOrigin,
  errorPayload,
  sendJson,
  sendNoContent,
} from "./library-api-http.mjs";
import { handleAiRoutes } from "./library-api-routes/ai.mjs";
import { handleCategoryRoutes } from "./library-api-routes/categories.mjs";
import { handlePaperRoutes } from "./library-api-routes/papers.mjs";
import { handleRadarRoutes } from "./library-api-routes/radar.mjs";

export const DEFAULT_API_PORT = 4317;
export const API_HOST = "127.0.0.1";

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

      if (!["GET", "HEAD"].includes(request.method ?? "")) {
        assertMutationRequestOrigin(request);
      }

      if (
        await handleRadarRoutes({
          request,
          response,
          pathname,
          repository,
          literatureRadarService,
        })
      ) {
        return;
      }
      if (
        await handleAiRoutes({ request, response, pathname, aiService })
      ) {
        return;
      }
      if (
        await handlePaperRoutes({
          request,
          response,
          pathname,
          repository,
          paperIntakeService,
          pdfArchiveService,
        })
      ) {
        return;
      }
      if (
        await handleCategoryRoutes({
          request,
          response,
          pathname,
          repository,
        })
      ) {
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
