import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell, utilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPaperId, parsePdfUrl, safeExternalUrl, validateApiRequest } from "../shared/security.mjs";
import { createQuitHandshake } from "../shared/quit-handshake.mjs";
import { createNavigationSmokePapers, navigationSmokeScript, noPdfNavigationSmokeScript, readerSmokeScript } from "../../scripts/desktop-smoke-fixture.mjs";
import { verifyDesktopLayout } from "../../scripts/desktop-layout-smoke.mjs";
import { verifyContinuousDesktopReader } from "../../scripts/desktop-continuous-smoke.mjs";
import { verifyDesktopIntakePrompt } from "../../scripts/desktop-intake-prompt-smoke.mjs";
import { INTAKE_DIAGNOSTIC_PREVIEW, verifyDesktopIntakeDiagnostic } from "../../scripts/desktop-intake-diagnostic-smoke.mjs";
import { PDF_RECOVERY_IMPORT_ID, PDF_RECOVERY_RETRY_ID, verifyDesktopPdfRecovery } from "../../scripts/desktop-pdf-recovery-smoke.mjs";
import { verifyDesktopDocumentImport } from "../../scripts/desktop-document-import-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rendererRoot = join(root, "dist-desktop/renderer");
const dataRoot = join(homedir(), "Library/Application Support/个人文献库");
const databasePath = process.env.LIBRARY_DB_PATH || join(dataRoot, "library.sqlite3");
const pdfRoot = process.env.LIBRARY_PDF_DIR || join(dataRoot, "pdfs");
const backupRoot = process.env.LIBRARY_BACKUP_DIR || join(homedir(), "Library/Mobile Documents/com~apple~CloudDocs/个人文献库备份");
const runtimePath = process.env.LIBRARY_RUNTIME_PATH || join(dataRoot, "runtime.json");
const devUrl = process.env.LIBRARY_DESKTOP_DEV_URL;
const smoke = process.env.LIBRARY_DESKTOP_SMOKE === "1";
const token = randomUUID();
const pending = new Map();
const requests = new Map();
const grants = new Map();
const readyWindows = new Set();
const commandQueues = new Map();
let service;
let serviceAddress;
let mainWindow;
let settingsWindow;
let quitting = false;
let shutdownStarted = false;
let shutdownComplete = false;
let serviceVersions;
let quitReady;
let smokeRequestPaths;
let smokeIntakePromptRequestPaths;
let smokeIntakePromptFailNextSave = false;
let smokeIntakeDiagnostic;
let smokePdfRecovery;
let smokeDocumentImportRequests;
const openingFiles = [];

app.setName("我的文献库");
const userDataPath = process.env.LIBRARY_DESKTOP_USER_DATA || join(dataRoot, "desktop");
mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
app.setPath("userData", userDataPath);
protocol.registerSchemesAsPrivileged([
  { scheme: "literature", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: "literature-pdf", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function trustedUrl(value) {
  try {
    const url = new URL(value);
    return devUrl ? url.origin === new URL(devUrl).origin : url.protocol === "literature:" && url.hostname === "app";
  } catch { return false; }
}

function assertSender(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !trustedUrl(event.senderFrame.url) || !BrowserWindow.fromWebContents(event.sender)) {
    throw new Error("桌面接口只允许本应用主页面访问。");
  }
}

function command(value, window = mainWindow) {
  if (!window || window.isDestroyed()) return;
  const id = window.webContents.id;
  if (!readyWindows.has(id)) {
    commandQueues.set(id, [...(commandQueues.get(id) || []), value]);
    return;
  }
  window.webContents.send("literature:command", value);
}

function rpc(operation, payload = {}) {
  return new Promise((resolveResult, reject) => {
    if (!service || !service.pid) return reject(new Error("文献服务未运行。"));
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("本地文献服务响应超时。")); }, operation === "import-pdf" ? 180_000 : 15_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveResult(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    service.postMessage({ id, operation, payload });
  });
}

async function writeRuntime() {
  await mkdir(dirname(runtimePath), { recursive: true, mode: 0o700 });
  const temporary = `${runtimePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({
    apiUrl: serviceAddress.url, token, pid: process.pid, version: 1, appVersion: app.getVersion(),
    nodePath: process.execPath, electronRunAsNode: true,
  }, null, 2), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, runtimePath);
}

async function removeRuntime() {
  try {
    const existing = JSON.parse(await readFile(runtimePath, "utf8"));
    if (existing.token === token) await rm(runtimePath, { force: true });
  } catch (error) { if (error.code !== "ENOENT") console.error("无法移除本地连接状态。", error.message); }
}

async function startService() {
  const helperPath = app.isPackaged ? join(process.resourcesPath, "keychain-helper-v1") : join(root, "dist-desktop/keychain-helper-v1");
  await stat(helperPath);
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("文献库服务启动超时。")), 30_000);
    service = utilityProcess.fork(join(root, "desktop/service/entry.cjs"), [], {
      serviceName: "文献库服务", stdio: "pipe", cwd: app.isPackaged ? process.resourcesPath : root,
      env: { ...process.env, LIBRARY_SERVICE_TOKEN: token, LIBRARY_DB_PATH: databasePath,
        LIBRARY_PDF_DIR: pdfRoot, LIBRARY_BACKUP_DIR: backupRoot, LIBRARY_KEYCHAIN_HELPER: helperPath },
    });
    service.stdout?.on("data", (chunk) => process.stdout.write(chunk));
    service.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    service.on("message", (message) => {
      if (message.type === "ready") {
        clearTimeout(timer); serviceAddress = message.address; serviceVersions = message.versions; resolveReady();
      } else if (message.type === "fatal") {
        clearTimeout(timer); reject(new Error(message.error.message));
      } else if (message.id && pending.has(message.id)) {
        const task = pending.get(message.id); pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error.message));
        else task.resolve(message.result);
      }
    });
    service.on("exit", (code) => {
      clearTimeout(timer);
      const error = new Error(`本地文献服务已停止（${code}）。`);
      reject(error);
      for (const task of pending.values()) task.reject(error);
      pending.clear();
      void removeRuntime();
      if (!quitting) { dialog.showErrorBox("文献库服务停止", "请重新打开应用。已经保存的文献仍保存在本机。"); app.quit(); }
    });
  });
}

function contentPolicy() {
  const connect = devUrl ? "'self' ws://127.0.0.1:* literature-pdf:" : "'self' literature-pdf:";
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${connect}; worker-src 'self' blob:; frame-src literature-pdf:; object-src 'none'; base-uri 'none'; form-action 'none'`;
}

function registerProtocols() {
  protocol.handle("literature", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "app" || !["GET", "HEAD"].includes(request.method)) return new Response("Not found", { status: 404 });
      const pathname = decodeURIComponent(url.pathname);
      const target = resolve(rendererRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!target.startsWith(`${rendererRoot}${sep}`)) return new Response("Not found", { status: 404 });
      const real = await realpath(target);
      if (!real.startsWith(`${await realpath(rendererRoot)}${sep}`)) return new Response("Not found", { status: 404 });
      const result = await net.fetch(pathToFileURL(real).href);
      const headers = new Headers(result.headers);
      headers.set("Content-Security-Policy", contentPolicy());
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(request.method === "HEAD" ? null : result.body, { status: result.status, headers });
    } catch { return new Response("Not found", { status: 404 }); }
  });
  protocol.handle("literature-pdf", async (request) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
      const paperId = parsePdfUrl(request.url);
      const file = await rpc("pdf-file", { paperId });
      const { parsePdfRange } = await import("../../scripts/library-api-http.mjs");
      const rangeHeader = request.headers.get("range");
      const range = parsePdfRange(rangeHeader, file.sizeBytes);
      if (!range) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.sizeBytes}` } });
      const headers = {
        "Content-Type": "application/pdf", "Content-Length": String(range.end - range.start + 1),
        "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": devUrl ? new URL(devUrl).origin : "literature://app",
        ...(rangeHeader ? { "Content-Range": `bytes ${range.start}-${range.end}/${file.sizeBytes}` } : {}),
      };
      const stream = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(file.path, { start: range.start, end: range.end }));
      return new Response(stream, { status: rangeHeader ? 206 : 200, headers });
    } catch { return new Response("本地 PDF 不可用。", { status: 404 }); }
  });
}

async function grantPdf(filePath, owner) {
  const resolved = await realpath(filePath);
  const info = await stat(resolved);
  if (!info.isFile() || extname(resolved).toLowerCase() !== ".pdf" || info.size < 5 || info.size > 200 * 1024 * 1024) {
    throw new Error("请选择不超过 200 MiB 的 PDF 文件。");
  }
  const descriptor = await open(resolved, "r");
  try {
    const prefix = Buffer.alloc(Math.min(1024, info.size));
    const { bytesRead } = await descriptor.read(prefix, 0, prefix.length, 0);
    if (!prefix.subarray(0, bytesRead).includes(Buffer.from("%PDF-"))) throw new Error("所选文件不是有效 PDF。");
  } finally { await descriptor.close(); }
  const id = randomUUID();
  grants.set(id, { path: resolved, owner, expires: Date.now() + 30 * 60_000, size: info.size, mtimeMs: info.mtimeMs });
  return { id, name: basename(resolved), size: info.size };
}

async function selectPdf(window) {
  if (smoke && smokePdfRecovery) {
    const mode = smokePdfRecovery.selections.shift();
    smokePdfRecovery.selectedModes.push(mode);
    if (mode === "cancel") return [];
    if (mode === "invalid") return [await grantPdf(process.env.LIBRARY_DESKTOP_SMOKE_INVALID_PDF, window.webContents.id)];
    if (mode === "valid") return [await grantPdf(process.env.LIBRARY_DESKTOP_SMOKE_PDF, window.webContents.id)];
    throw new Error("离线 PDF 恢复验收未配置系统选取结果。");
  }
  const result = await dialog.showOpenDialog(window, { title: "导入论文 PDF", properties: ["openFile", "multiSelections"], filters: [{ name: "PDF 文档", extensions: ["pdf"] }] });
  if (result.canceled) return [];
  return Promise.all(result.filePaths.map((path) => grantPdf(path, window.webContents.id)));
}

function attachWindowSecurity(window) {
  const webContentsId = window.webContents.id;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/u.test(url)) { try { void shell.openExternal(safeExternalUrl(url)).catch(() => undefined); } catch { /* Reject invalid external URLs. */ } }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (trustedUrl(url)) return;
    event.preventDefault();
    if (/^https?:/u.test(url)) { try { void shell.openExternal(safeExternalUrl(url)).catch(() => undefined); } catch { /* Reject invalid external URLs. */ } }
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on("destroyed", () => {
    const id = webContentsId;
    readyWindows.delete(id); commandQueues.delete(id);
    for (const [key, grant] of grants) if (grant.owner === id) grants.delete(key);
    for (const [key, request] of requests) if (request.owner === id) { request.controller.abort(); requests.delete(key); }
  });
}

function createWindow({ settings = false, section = "ai" } = {}) {
  const window = new BrowserWindow({
    width: settings ? 980 : 1280, height: settings ? 780 : 860,
    minWidth: settings ? 760 : 920, minHeight: 640,
    title: settings ? "文献库设置" : "我的文献库", movable: true, resizable: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#19231f" : "#f7f8f4", show: false,
    webPreferences: { preload: join(root, "desktop/preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, ...(smoke ? { backgroundThrottling: false } : {}) },
  });
  // PDF pinch gestures zoom their content; the surrounding app keeps its scale.
  window.webContents.setZoomMode("disabled");
  void window.webContents.setVisualZoomLevelLimits(1, 1);
  attachWindowSecurity(window);
  // Keeping hidden windows alive preserves drafts and debounced saves when macOS closes a window.
  window.on("close", (event) => {
    if (!quitting) { event.preventDefault(); window.hide(); }
  });
  const url = devUrl ? new URL(devUrl) : new URL("literature://app/index.html");
  if (settings) url.searchParams.set("window", "settings");
  void window.loadURL(url.href);
  window.once("ready-to-show", () => { if (!smoke) window.show(); });
  if (settings) {
    settingsWindow = window; command({ type: "settings", section }, window);
    window.on("closed", () => { settingsWindow = null; });
  } else {
    mainWindow = window;
    window.on("closed", () => { mainWindow = null; });
  }
  return window;
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!smoke) { mainWindow.show(); mainWindow.focus(); }
  return mainWindow;
}

function showSettings(section = "ai") {
  if (!["general", "ai", "data"].includes(section)) throw new Error("设置分类无效。");
  if (!settingsWindow || settingsWindow.isDestroyed()) createWindow({ settings: true, section });
  else { command({ type: "settings", section }, settingsWindow); settingsWindow.show(); settingsWindow.focus(); }
}

async function performRequest(input, owner = 0) {
  const value = validateApiRequest({ ...input, path: typeof input?.path === "string" && input.path.startsWith("/") && !input.path.startsWith("/api/") ? `/api${input.path}` : input?.path });
  if (smoke && smokeDocumentImportRequests) {
    smokeDocumentImportRequests.push(`${value.method} ${value.path}`);
    if (value.path === "/api/paper-intake/analyze" || /^\/api\/radar\/(?:run|tasks)/u.test(value.path) || value.path.startsWith("/api/ai/")) throw new Error("普通 PDF 资料验收不得调用 AI 或文献雷达。");
  }
  if (smoke && smokeIntakeDiagnostic) {
    smokeIntakeDiagnostic.requestPaths.push(`${value.method} ${value.path}`);
    if (value.method === "POST" && value.path === "/api/paper-intake/analyze") {
      smokeIntakeDiagnostic.mockAnalyzeRequests += 1;
      await smokeIntakeDiagnostic.retryBarrier;
      return { status: 502, body: { error: {
        code: "INVALID_AI_RESULT", message: "AI 的最终答复没有包含完整的论文 JSON 资料，尚未添加论文。",
        details: { intakeDiagnostic: { reason: "最终答复缺少完整论文 JSON。", outputPreview: INTAKE_DIAGNOSTIC_PREVIEW, outputLength: 8000, truncated: true, model: "test-diagnostic-model" } },
      } } };
    }
    if (/\/api\/ai\/|\/api\/radar\/(?:run|tasks)/u.test(value.path) || (value.path === "/api/papers" && value.method === "POST")) throw new Error("AI 诊断验收不得调用付费 AI、雷达或创建论文。");
  }
  if (smoke && smokePdfRecovery) {
    smokePdfRecovery.requestPaths.push(`${value.method} ${value.path}`);
    if (/\/api\/paper-intake\/analyze$|\/api\/radar\/run$|\/api\/radar\/tasks$|\/api\/ai\//u.test(value.path) || (value.path === "/api/papers" && value.method === "POST")) throw new Error("PDF 恢复验收不得调用 AI 或新建论文。");
    const recoveryPaperId = [PDF_RECOVERY_RETRY_ID, PDF_RECOVERY_IMPORT_ID].find((id) => value.path === `/api/papers/${id}/pdf/archive`);
    if (recoveryPaperId && value.method === "POST") {
      smokePdfRecovery.archiveRequests.push({ paperId: recoveryPaperId, body: value.body === undefined ? null : JSON.parse(value.body) });
      if (smokePdfRecovery.retryReady && recoveryPaperId === PDF_RECOVERY_RETRY_ID) return { status: 200, body: await rpc("import-pdf", { paperId: recoveryPaperId, filePath: process.env.LIBRARY_DESKTOP_SMOKE_PDF }) };
      return { status: 502, body: { error: "PDF 来源服务返回了 502。", code: "PDF_SOURCE_HTTP_ERROR" } };
    }
  }
  if (smokeRequestPaths) {
    smokeRequestPaths.push(`${value.method} ${value.path}`);
    if (/\/pdf\/|\/api\/ai\/|\/paper-intake/u.test(value.path)) throw new Error("无 PDF 标题入口不得自动请求 PDF 或 AI。");
  }
  if (smokeIntakePromptRequestPaths) {
    smokeIntakePromptRequestPaths.push(`${value.method} ${value.path}`);
    if (value.path === "/api/paper-intake/analyze" || value.path === "/api/radar/run" || (value.path.startsWith("/api/ai/") && value.method !== "GET")) {
      throw new Error("提示词编辑验收不得触发 AI 调用。");
    }
    if (smokeIntakePromptFailNextSave && value.method === "PUT" && value.path === "/api/paper-intake/prompt-template") {
      smokeIntakePromptFailNextSave = false;
      return { status: 503, body: { error: "离线模拟保存失败，草稿应保留并可重试。" } };
    }
  }
  if (!serviceAddress) throw new Error("本地文献服务未就绪。");
  const controller = new AbortController();
  const key = `${owner}:${value.requestId || randomUUID()}`;
  if (requests.has(key)) throw new Error("请求 ID 已在使用。");
  requests.set(key, { owner, controller });
  try {
    const response = await fetch(`${serviceAddress.url}${value.path}`, {
      method: value.method, body: value.body, signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://127.0.0.1" }, redirect: "error",
    });
    return { status: response.status, body: await response.json() };
  } finally { requests.delete(key); }
}

function installIpc() {
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => { assertSender(event); return callback(event, ...args); });
  handle("literature:request", (event, input) => performRequest(input, event.sender.id));
  handle("literature:cancel-request", (event, id) => {
    if (typeof id !== "string") throw new Error("请求 ID 无效。");
    requests.get(`${event.sender.id}:${id}`)?.controller.abort();
  });
  handle("literature:open-external", (_event, value) => {
    const url = safeExternalUrl(value);
    if (smoke && smokePdfRecovery) { smokePdfRecovery.externalUrls.push(url); return; }
    return shell.openExternal(url);
  });
  handle("literature:select-pdf", (event) => selectPdf(BrowserWindow.fromWebContents(event.sender)));
  handle("literature:grant-dropped-pdf", (event, value) => {
    if (typeof value !== "string" || !value) throw new Error("无法读取拖入的 PDF。");
    return grantPdf(value, event.sender.id);
  });
  handle("literature:import-pdf", async (event, paperId, grantId) => {
    assertPaperId(paperId);
    const grant = grants.get(grantId);
    if (!grant || grant.owner !== event.sender.id || grant.expires < Date.now()) throw new Error("PDF 导入授权已失效，请重新选择文件。");
    const current = await stat(grant.path);
    if (current.size !== grant.size || current.mtimeMs !== grant.mtimeMs) throw new Error("PDF 文件发生变化，请重新选择。");
    if (smoke && smokePdfRecovery) {
      smokePdfRecovery.imports.push({ paperId, owner: event.sender.id });
      await smokePdfRecovery.importBarrier;
    }
    const result = await rpc("import-pdf", { paperId, filePath: grant.path });
    grants.delete(grantId); return result;
  });
  handle("literature:show-pdf", async (_event, paperId) => { const file = await rpc("pdf-file", { paperId: assertPaperId(paperId) }); shell.showItemInFolder(file.path); });
  handle("literature:show-data", async (_event, kind) => {
    const locations = { database: databasePath, pdf: pdfRoot, backups: backupRoot };
    if (!Object.hasOwn(locations, kind)) throw new Error("数据类型无效。");
    if (kind === "database") shell.showItemInFolder(locations[kind]);
    else { await mkdir(locations[kind], { recursive: true }); await shell.openPath(locations[kind]); }
  });
  handle("literature:settings", (_event, section) => showSettings(section));
  ipcMain.on("literature:ready", (event) => {
    assertSender(event); readyWindows.add(event.sender.id);
    for (const value of commandQueues.get(event.sender.id) || []) event.sender.send("literature:command", value);
    commandQueues.delete(event.sender.id);
  });
  ipcMain.on("literature:quit-ready", (event, response) => { assertSender(event); quitReady?.(event.sender.id, response); });
}

function installMenu() {
  const menuCommand = (type) => () => command({ type }, showMain());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "我的文献库", submenu: [{ role: "about", label: "关于我的文献库" }, { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => showSettings() }, { type: "separator" }, { role: "services" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit", label: "退出我的文献库" }] },
    { label: "文件", submenu: [{ label: "添加论文…", accelerator: "CmdOrCtrl+N", click: menuCommand("add-paper") }, { label: "导入 PDF…", accelerator: "CmdOrCtrl+O", click: async () => { try { const window = showMain(); const files = await selectPdf(window); if (files.length) command({ type: "import-pdf", files }, window); } catch (error) { dialog.showErrorBox("无法导入 PDF", error.message); } } }, { type: "separator" }, { role: "close", label: "关闭窗口" }] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }, { type: "separator" }, { label: "查找", accelerator: "CmdOrCtrl+F", click: menuCommand("search") }, { label: "命令搜索", accelerator: "CmdOrCtrl+K", click: menuCommand("command-search") }] },
    { label: "显示", submenu: [{ label: "完整文献卡片", click: () => command({ type: "view-mode", mode: "cards" }, showMain()) }, { label: "标题列表", click: () => command({ type: "view-mode", mode: "titles" }, showMain()) }, { label: "文献雷达", click: menuCommand("radar") }, { type: "separator" }, { role: "togglefullscreen" }, ...(!app.isPackaged ? [{ role: "toggleDevTools" }] : [])] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { label: "显示文献库", click: showMain }, { role: "front" }] },
    { label: "帮助", submenu: [{ label: "在 Finder 中显示数据", click: () => shell.showItemInFolder(databasePath) }, { label: "本地连接说明", click: () => showSettings("data") }] },
  ]));
}

async function openPendingFiles() {
  if (!openingFiles.length) return;
  const window = showMain();
  const files = [];
  for (const path of openingFiles.splice(0)) {
    try { files.push(await grantPdf(path, window.webContents.id)); }
    catch (error) { dialog.showErrorBox("无法导入 PDF", error.message); }
  }
  if (files.length) command({ type: "import-pdf", files }, window);
}

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const windows = BrowserWindow.getAllWindows().filter((window) => readyWindows.has(window.webContents.id));
  if (windows.length) {
    const handshake = createQuitHandshake(windows.map((window) => window.webContents.id));
    quitReady = handshake.acknowledge;
    for (const window of windows) command({ type: "save-before-quit", requestId: handshake.requestId }, window);
    const allowed = await handshake.result;
    quitReady = null;
    if (!allowed) {
      shutdownStarted = false;
      const window = windows.find((candidate) => !candidate.isDestroyed());
      if (window && !smoke) { window.show(); window.focus(); }
      return;
    }
  }
  quitting = true;
  for (const { controller } of requests.values()) controller.abort();
  await Promise.race([rpc("shutdown").catch(() => undefined), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000))]);
  service?.kill(); await removeRuntime(); shutdownComplete = true; app.quit();
}

async function runSmoke() {
  if (!process.env.LIBRARY_DB_PATH || !process.env.LIBRARY_DESKTOP_SMOKE_REPORT || !process.env.LIBRARY_DESKTOP_SMOKE_PDF || !process.env.LIBRARY_DESKTOP_SMOKE_LONG_PDF) throw new Error("桌面验证必须使用独立临时目录。");
  const health = await performRequest({ path: "/api/health" });
  if (health.status !== 200 || !health.body.ok) throw new Error("SQLite 验证失败。");
  const created = await performRequest({ path: "/api/papers", method: "POST", body: { id: "desktop-smoke", title: "Desktop runtime verification", zhTitle: "桌面运行验证", authors: "Test", institution: "Test", categoryIds: [], aiSummary: "离线测试：运行真实 PDF 阅读器。", note: "", date: "2026", source: "Test" } });
  if (created.status >= 400) throw new Error(JSON.stringify(created.body));
  for (const paper of createNavigationSmokePapers()) {
    const result = await performRequest({ path: "/api/papers", method: "POST", body: paper });
    if (result.status >= 400) throw new Error(JSON.stringify(result.body));
  }
  const longCreated = await performRequest({ path: "/api/papers", method: "POST", body: { id: "desktop-long-smoke", title: "Desktop long document runtime verification", authors: "Synthetic Test", institution: "Test", categoryIds: [], aiSummary: "40页离线合成PDF用于连续阅读懒渲染与无目录回退验收。", note: "", date: "2026", source: "Test" } });
  if (longCreated.status >= 400) throw new Error(JSON.stringify(longCreated.body));
  const window = mainWindow;
  if (window.webContents.isLoading()) await new Promise((resolveLoaded) => window.webContents.once("did-finish-load", resolveLoaded));
  // Real UI checks need an active compositor: a hidden macOS window pauses
  // requestAnimationFrame and can strand scroll-position and focus assertions.
  // This runner only operates on the isolated temporary library above.
  window.show(); window.focus(); window.webContents.focus();
  const windowBounds = window.getBounds();
  const contentBounds = window.getContentBounds();
  const nativeWindow = { movable: window.isMovable(), resizable: window.isResizable(), titleBarHeight: contentBounds.y - windowBounds.y };
  if (!nativeWindow.movable || !nativeWindow.resizable || nativeWindow.titleBarHeight <= 0) throw new Error(`原生标题栏验证失败：${JSON.stringify(nativeWindow)}`);
  window.setPosition(windowBounds.x + 12, windowBounds.y + 12, false);
  const movedBounds = window.getBounds();
  if (movedBounds.x !== windowBounds.x + 12 || movedBounds.y !== windowBounds.y + 12) throw new Error("原生窗口移动验证失败。");
  window.setPosition(windowBounds.x, windowBounds.y, false);
  nativeWindow.positionChanged = true;
  const grant = await grantPdf(process.env.LIBRARY_DESKTOP_SMOKE_PDF, window.webContents.id);
  await window.webContents.executeJavaScript(`window.literatureDesktop.importPdf('desktop-smoke', ${JSON.stringify(grant.id)})`);
  const longGrant = await grantPdf(process.env.LIBRARY_DESKTOP_SMOKE_LONG_PDF, window.webContents.id);
  await window.webContents.executeJavaScript(`window.literatureDesktop.importPdf('desktop-long-smoke', ${JSON.stringify(longGrant.id)})`);
  const renderer = await window.webContents.executeJavaScript(`(async () => {
    const bridge = window.literatureDesktop;
    const health = await bridge.request({path:'/api/health'});
    let denied = false;
    try { await bridge.request({path:'/api/../../secret'}); } catch { denied = true; }
    const pdf = await fetch(bridge.pdfUrl('desktop-smoke'), {headers:{Range:'bytes=0-4'}});
    const invalid = await fetch('literature-pdf://paper/not-present');
    let reusedImportDenied = false;
    try { await bridge.importPdf('desktop-smoke', ${JSON.stringify(grant.id)}); } catch { reusedImportDenied = true; }
    let syntheticFileDenied = false;
    try { await bridge.grantDroppedPdf(new File(['%PDF-1.4'], 'fake.pdf')); } catch { syntheticFileDenied = true; }
    return {node:typeof require,process:typeof process,health:health.status,denied,pdfStatus:pdf.status,pdfHeader:await pdf.text(),missing:invalid.status,reusedImportDenied,syntheticFileDenied,title:document.title};
  })()`);
  if (renderer.node !== "undefined" || renderer.process !== "undefined" || renderer.health !== 200 || !renderer.denied || renderer.pdfStatus !== 206 || renderer.pdfHeader !== "%PDF-" || renderer.missing !== 404 || !renderer.reusedImportDenied || !renderer.syntheticFileDenied) throw new Error(JSON.stringify(renderer));
  // The initial library query can precede fixture creation; refresh the production UI once.
  console.log("[desktop-smoke] fixtures imported; renderer refresh");
  await window.webContents.reload();
  await new Promise((resolveLoaded) => window.webContents.once("did-finish-load", resolveLoaded));
  console.log("[desktop-smoke] renderer ready; reader notes and save");
  const reader = await window.webContents.executeJavaScript(readerSmokeScript("Desktop runtime verification"));
  console.log("[desktop-smoke] reader save complete; continuous reading");
  const continuousReader = await verifyContinuousDesktopReader(window, { title: "Desktop runtime verification", longTitle: "Desktop long document runtime verification" });
  console.log("[desktop-smoke] continuous reader complete; library navigation");
  const navigation = await window.webContents.executeJavaScript(navigationSmokeScript("Desktop runtime verification"));
  const noPdfRequests = [];
  smokeRequestPaths = noPdfRequests;
  let noPdfNavigation;
  try { noPdfNavigation = await window.webContents.executeJavaScript(noPdfNavigationSmokeScript()); }
  finally { smokeRequestPaths = undefined; }
  if (noPdfRequests.some((path) => /\/pdf\/|\/api\/ai\/|\/paper-intake/u.test(path))) throw new Error(`无 PDF 标题入口发起了额外请求：${JSON.stringify(noPdfRequests)}`);
  noPdfNavigation.noAutomaticPdfOrAi = true;
  noPdfNavigation.requestPaths = noPdfRequests;
  console.log("[desktop-smoke] library navigation complete; intake prompt editing");
  const intakePromptRequests = [];
  smokeIntakePromptRequestPaths = intakePromptRequests;
  let intakePrompt;
  try { intakePrompt = await verifyDesktopIntakePrompt(window, { command, screenshotPath: process.env.LIBRARY_DESKTOP_SMOKE_PROMPT_SCREENSHOT, failNextSave: () => { smokeIntakePromptFailNextSave = true; } }); }
  finally { smokeIntakePromptRequestPaths = undefined; smokeIntakePromptFailNextSave = false; }
  if (intakePromptRequests.some((path) => /\/paper-intake\/analyze$|\/radar\/run$/u.test(path) || (/\/api\/ai\//u.test(path) && !path.startsWith("GET ")))) throw new Error(`提示词编辑触发了 AI 请求：${JSON.stringify(intakePromptRequests)}`);
  intakePrompt.noAiCalls = true;
  intakePrompt.requestPaths = intakePromptRequests;
  console.log("[desktop-smoke] intake prompt editing complete; final-answer error diagnostics");
  smokeIntakeDiagnostic = { requestPaths: [], mockAnalyzeRequests: 0, retryBarrier: undefined };
  let intakeDiagnostic;
  try {
    intakeDiagnostic = await verifyDesktopIntakeDiagnostic(window, {
      command, screenshotPath: process.env.LIBRARY_DESKTOP_SMOKE_DIAGNOSTIC_SCREENSHOT,
      protectDraftQuit: async () => {
        const handshake = createQuitHandshake([window.webContents.id], { timeoutMs: 3000 });
        let response;
        quitReady = (windowId, value) => { response = value; handshake.acknowledge(windowId, value); };
        try {
          command({ type: "save-before-quit", requestId: handshake.requestId }, window);
          if (await handshake.result || response?.allow !== false) throw new Error("格式错误后的论文线索未受到原生退出保护。");
        } finally { quitReady = null; }
      },
      holdRetry: () => {
        let release;
        smokeIntakeDiagnostic.retryBarrier = new Promise((resolveRetry) => { release = resolveRetry; });
        return () => { smokeIntakeDiagnostic.retryBarrier = undefined; release(); };
      },
    });
    if (smokeIntakeDiagnostic.mockAnalyzeRequests !== 2) throw new Error("格式错误触发了非用户点击的额外整理请求。");
    intakeDiagnostic.noPaidAiCalls = true;
    intakeDiagnostic.noPaperCreated = true;
    intakeDiagnostic.mockAnalyzeRequests = smokeIntakeDiagnostic.mockAnalyzeRequests;
    intakeDiagnostic.requestPaths = smokeIntakeDiagnostic.requestPaths;
  } finally { smokeIntakeDiagnostic = undefined; }
  console.log("[desktop-smoke] error diagnostics complete; PDF error recovery");
  smokePdfRecovery = { requestPaths: [], archiveRequests: [], externalUrls: [], selections: [], selectedModes: [], imports: [], retryReady: false, importBarrier: undefined };
  let pdfRecovery;
  try {
    pdfRecovery = await verifyDesktopPdfRecovery(window, {
      screenshotPath: process.env.LIBRARY_DESKTOP_SMOKE_RECOVERY_SCREENSHOT,
      verifyExternalUrls: async () => {
        const deadline = Date.now() + 3000;
        while (smokePdfRecovery.externalUrls.length < 2 && Date.now() < deadline) await new Promise((resolveRecorded) => setTimeout(resolveRecorded, 25));
        const expected = [`https://papers.example.test/recovery/${PDF_RECOVERY_RETRY_ID}.pdf`, "https://papers.example.test/recovery/article"];
        if (JSON.stringify(smokePdfRecovery.externalUrls) !== JSON.stringify(expected)) throw new Error("来源恢复没有安全打开准确来源与原文。");
      },
      retryReady: () => { smokePdfRecovery.retryReady = true; },
      select: (mode) => { smokePdfRecovery.selections.push(mode); },
      assertNoImports: () => { if (smokePdfRecovery.imports.length) throw new Error("取消／无效 PDF／笔记保存失败触发了实际导入。"); },
      holdImport: () => {
        let release;
        smokePdfRecovery.importBarrier = new Promise((resolveImport) => { release = resolveImport; });
        return release;
      },
      assertImportBoundToCurrentPaper: () => {
        if (smokePdfRecovery.imports.length !== 1 || smokePdfRecovery.imports[0].paperId !== PDF_RECOVERY_IMPORT_ID || smokePdfRecovery.imports[0].owner !== window.webContents.id) throw new Error("本地 PDF 导入未绑定到当前论文与窗口授权。");
      },
    });
    if (smokePdfRecovery.archiveRequests.some((request) => request.body?.force !== false)) throw new Error("PDF 恢复重试请求错误地强制覆盖本地副本。");
    pdfRecovery.noAiCalls = true;
    pdfRecovery.noPaperCreated = true;
    pdfRecovery.safeExternalUrlsRecorded = smokePdfRecovery.externalUrls;
    pdfRecovery.credentialLinkNeverOpened = smokePdfRecovery.externalUrls.length === 2;
    pdfRecovery.requestPaths = smokePdfRecovery.requestPaths;
    pdfRecovery.archiveRequests = smokePdfRecovery.archiveRequests;
    pdfRecovery.selectedModes = smokePdfRecovery.selectedModes;
    pdfRecovery.imports = smokePdfRecovery.imports;
  } finally { smokePdfRecovery = undefined; }
  console.log("[desktop-smoke] PDF recovery complete; ordinary PDF document import");
  const documentImportRequests = [];
  smokeDocumentImportRequests = documentImportRequests;
  let documentImport;
  try {
    const documentFiles = [
      await grantPdf(process.env.LIBRARY_DESKTOP_SMOKE_DOCUMENT_PDF, window.webContents.id),
      await grantPdf(process.env.LIBRARY_DESKTOP_SMOKE_LONG_PDF, window.webContents.id),
    ];
    documentImport = await verifyDesktopDocumentImport(window, {
      command, files: documentFiles,
      duplicateFile: await grantPdf(process.env.LIBRARY_DESKTOP_SMOKE_DOCUMENT_PDF, window.webContents.id),
      screenshotPath: process.env.LIBRARY_DESKTOP_SMOKE_DOCUMENT_SCREENSHOT,
    });
    documentImport.noAiCalls = true;
    documentImport.requestPaths = documentImportRequests;
  } finally { smokeDocumentImportRequests = undefined; }
  const layout = await verifyDesktopLayout(window, { command, showSettings: (section) => { showSettings(section); settingsWindow.show(); settingsWindow.focus(); return settingsWindow; } });
  console.log("[desktop-smoke] library layout complete; keychain and quit");
  const { MacOsKeychainCredentialStore } = await import("../../scripts/ai/credential-store.mjs");
  const credentialStore = new MacOsKeychainCredentialStore({ serviceName: "com.personal-literature-library.runtime-smoke", helperBinaryPath: app.isPackaged ? join(process.resourcesPath, "keychain-helper-v1") : join(root, "dist-desktop/keychain-helper-v1"), compileHelper: false });
  const missingCredential = await credentialStore.has(`smoke-${randomUUID()}`);
  if (missingCredential) throw new Error("临时钥匙串账户意外存在。");
  window.close();
  if (window.isDestroyed()) throw new Error("关闭窗口丢失了保留的界面状态。");
  await writeFile(process.env.LIBRARY_DESKTOP_SMOKE_REPORT, JSON.stringify({ ok: true, electron: process.versions.electron, serviceVersions, nativeWindow, renderer, reader, continuousReader, navigation, noPdfNavigation, intakePrompt, intakeDiagnostic, pdfRecovery, documentImport, layout, keychainHelper: true, closePreservedWindow: true, packaged: app.isPackaged }, null, 2));
  console.log("桌面运行验证通过：SQLite、utility process、受限 IPC、renderer 隔离与 PDF 范围读取。");
  if (process.env.LIBRARY_DESKTOP_SMOKE_KEEP_OPEN === "1") {
    mainWindow.show(); mainWindow.focus();
    console.log("临时文献库保持打开，可进行界面验收；通过菜单退出应用后清理测试目录。");
  } else app.quit();
}

app.on("open-file", (event, filePath) => { event.preventDefault(); openingFiles.push(filePath); if (serviceAddress) void openPendingFiles(); });
app.on("window-all-closed", () => { /* macOS keeps the service running until explicit quit. */ });
app.on("activate", () => { if (serviceAddress) showMain(); });
app.on("before-quit", (event) => { if (!shutdownComplete) { event.preventDefault(); void shutdown(); } });

if (!app.requestSingleInstanceLock({ databasePath })) { shutdownComplete = true; app.quit(); }
else {
  app.on("second-instance", (_event, argv) => { openingFiles.push(...argv.filter((arg) => extname(arg).toLowerCase() === ".pdf")); if (serviceAddress) { showMain(); void openPendingFiles(); } });
  app.whenReady().then(async () => {
    if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/?$/u.test(devUrl)) throw new Error("桌面开发地址必须位于本机。");
    await startService(); await writeRuntime(); registerProtocols(); installIpc(); installMenu(); createWindow();
    await openPendingFiles();
    if (smoke) await runSmoke();
  }).catch(async (error) => {
    console.error("桌面启动失败：", error.message);
    if (smoke && process.env.LIBRARY_DESKTOP_SMOKE_REPORT) await writeFile(process.env.LIBRARY_DESKTOP_SMOKE_REPORT, JSON.stringify({ ok: false, error: error.message }));
    if (!smoke) dialog.showErrorBox("无法打开文献库", error.message);
    quitting = true;
    await rpc("shutdown").catch(() => undefined);
    service?.kill();
    await removeRuntime();
    shutdownComplete = true;
    app.exit(1);
  });
}
