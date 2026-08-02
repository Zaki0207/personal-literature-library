#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createLibraryApi,
  DEFAULT_API_PORT,
} from "./library-api.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const VINEXT_EXECUTABLE = resolve(
  PROJECT_DIRECTORY,
  "node_modules",
  ".bin",
  "vinext",
);

export async function startLocalDevelopment({
  port = DEFAULT_API_PORT,
  dbPath,
  backupDir,
  seedPath,
  pdfDirectory,
  pdfFetch,
  frontendArgs = ["dev"],
  spawnFrontend = true,
} = {}) {
  const api = await createLibraryApi({
    port,
    ...(dbPath ? { dbPath } : {}),
    ...(backupDir ? { backupDir } : {}),
    ...(seedPath !== undefined ? { seedPath } : {}),
    ...(pdfDirectory ? { pdfDirectory } : {}),
    ...(pdfFetch ? { pdfFetch } : {}),
  });
  const address = await api.listen();

  let frontend = null;
  let closed = false;
  if (spawnFrontend) {
    frontend = spawn(VINEXT_EXECUTABLE, frontendArgs, {
      cwd: PROJECT_DIRECTORY,
      stdio: "inherit",
      env: {
        ...process.env,
        NEXT_PUBLIC_LIBRARY_API_URL: address.url,
        VITE_LIBRARY_API_URL: address.url,
        WRANGLER_LOG_PATH:
          process.env.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
      },
    });
  }

  return {
    api,
    address,
    frontend,
    async close(signal = "SIGTERM") {
      if (closed) return;
      closed = true;
      if (frontend && frontend.exitCode === null && !frontend.killed) {
        frontend.kill(signal);
      }
      await api.close();
    },
  };
}

async function main() {
  const portText = process.env.LIBRARY_API_PORT;
  const port =
    portText === undefined ? DEFAULT_API_PORT : Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("LIBRARY_API_PORT 必须是 0 到 65535 之间的整数。");
  }

  const local = await startLocalDevelopment({
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
  console.log(`本地文献数据库：${local.api.repository.dbPath}`);
  console.log(`iCloud 备份目录：${local.api.repository.backupDir}`);
  console.log(`PDF 本地目录：${local.api.pdfArchiveService.pdfDirectory}`);
  console.log(`本地文献库 API：${local.address.url}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await local.close(signal);
  };

  process.once("SIGINT", async () => {
    await shutdown("SIGINT");
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    await shutdown("SIGTERM");
    process.exit(143);
  });

  local.frontend?.once("error", async (error) => {
    console.error("无法启动前端开发服务器：", error);
    await shutdown();
    process.exitCode = 1;
  });
  local.frontend?.once("exit", async (code, signal) => {
    await shutdown();
    if (!shuttingDown || (code !== 0 && signal === null)) {
      process.exitCode = code ?? 1;
    }
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
