/* eslint-disable @typescript-eslint/no-require-imports -- Utility process boots CommonJS before dynamically loading ESM services. */
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");
const { createReadStream } = require("node:fs");
const { realpath } = require("node:fs/promises");

let api;
let closing = false;
const parent = process.parentPort;
async function main() {
  const root = resolve(__dirname, "../..");
  const { createLibraryApi } = await import(pathToFileURL(resolve(root, "scripts/library-api.mjs")));
  const { MacOsKeychainCredentialStore } = await import(pathToFileURL(resolve(root, "scripts/ai/credential-store.mjs")));
  api = await createLibraryApi({
    port: 0,
    requestToken: process.env.LIBRARY_SERVICE_TOKEN,
    dbPath: process.env.LIBRARY_DB_PATH,
    backupDir: process.env.LIBRARY_BACKUP_DIR,
    pdfDirectory: process.env.LIBRARY_PDF_DIR,
    seedPath: process.env.LIBRARY_SEED_PATH || null,
    credentialStore: new MacOsKeychainCredentialStore({
      helperBinaryPath: process.env.LIBRARY_KEYCHAIN_HELPER,
      compileHelper: false,
    }),
  });
  const address = await api.listen();
  parent.postMessage({ type: "ready", address, versions: process.versions });
}

async function getPdfFile(paperId) {
  const paper = api.repository.getPaper(paperId);
  if (!paper) throw new Error("未找到论文。");
  const file = await api.pdfArchiveService.getLocalPdf(paperId);
  if (!file) throw new Error("论文尚未归档本地 PDF。");
  const [path, root] = await Promise.all([realpath(file.path), realpath(api.pdfArchiveService.pdfDirectory)]);
  if (!path.startsWith(`${root}/`)) throw new Error("PDF 文件超出归档目录。");
  return { ...file, path, title: paper.title };
}

parent.on("message", async ({ data }) => {
  const { id, operation, payload } = data ?? {};
  try {
    if (operation === "shutdown") {
      if (!closing) {
        closing = true;
        await api?.close();
      }
      parent.postMessage({ id, result: true });
      setImmediate(() => process.exit(0));
      return;
    }
    if (!api || closing) throw new Error("文献服务尚未就绪。");
    let result;
    if (operation === "pdf-file") result = await getPdfFile(payload.paperId);
    else if (operation === "import-pdf") result = await api.pdfArchiveService.importPdf(payload.paperId, createReadStream(payload.filePath));
    else throw new Error("未知文献服务操作。");
    parent.postMessage({ id, result });
  } catch (error) {
    parent.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});

main().catch((error) => {
  parent.postMessage({ type: "fatal", error: { message: error.message, code: error.code } });
  process.exitCode = 1;
});
