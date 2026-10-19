#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectApplication, installDesktopApplication, launchApplication, listRunningApplications, quitApplications } from "./install-desktop.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [oldArgument, newArgument] = process.argv.slice(2);
if (!oldArgument?.endsWith(".app") || !newArgument?.endsWith(".app")) throw new Error("须指定旧版和新版 .app 路径；全部操作使用独立临时安装及文献库。");
const oldApplication = resolve(oldArgument);
const newApplication = resolve(newArgument);
const oldMetadata = await inspectApplication(oldApplication);
const newMetadata = await inspectApplication(newApplication);
const temporary = await realpath(await mkdtemp(join(tmpdir(), "literature-update-smoke-")));
const targetPath = join(temporary, "我的文献库.app");
const runtimePath = join(temporary, "runtime.json");
const env = { ...process.env, LIBRARY_DB_PATH: join(temporary, "library.sqlite3"), LIBRARY_PDF_DIR: join(temporary, "pdfs"), LIBRARY_BACKUP_DIR: join(temporary, "backups"), LIBRARY_RUNTIME_PATH: runtimePath, LIBRARY_DESKTOP_USER_DATA: join(temporary, "desktop") };
delete env.LIBRARY_DESKTOP_SMOKE;
const portServer = createServer();
await new Promise((ready) => portServer.listen(0, "127.0.0.1", ready));
const debugPort = portServer.address().port;
await new Promise((closed) => portServer.close(closed));
const launch = (path) => launchApplication(path, { env, args: [`--remote-debugging-port=${debugPort}`] });
const running = async () => (await listRunningApplications()).filter((application) => resolve(application.path) === targetPath);
const quit = (applications) => quitApplications(applications, { timeoutMs: 1500 });

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000;
  do {
    try { const value = await predicate(); if (value) return value; }
    catch { /* Service and renderer can still be starting. */ }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`更新验收超时：${label}`);
}

async function connectRenderer() {
  const page = await waitFor(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return pages.find((item) => item.type === "page" && item.url.startsWith("literature://app"));
  }, "查找临时应用页面");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((opened, reject) => { socket.addEventListener("open", opened, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message));
    else task.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("临时应用页面已关闭。")); }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    evaluate: async (expression) => {
      const id = ++nextId;
      const result = await new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("临时页面验收超时。")); }, 15_000);
        pending.set(id, { resolve: resolveResult, reject, timer });
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
  };
}

const draftScript = `(async () => {
  const wait = async (predicate) => {
    for (let attempt = 0; attempt < 150; attempt++) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('临时添加界面尚未就绪');
  };
  const button = await wait(() => [...document.querySelectorAll('.topbar button')].find(item => item.textContent.includes('添加论文')));
  button.click();
  const input = await wait(() => document.querySelector('.paper-intake-reference textarea'));
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Synthetic offline update draft; never submit to AI');
  input.dispatchEvent(new Event('input', {bubbles:true}));
  await new Promise(resolve => setTimeout(resolve, 150));
  return input.value;
})()`;
const clearDraftScript = `(async () => {
  const modal = document.querySelector('.paper-intake-modal');
  if (!modal) return true;
  const input = modal.querySelector('.paper-intake-reference textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
  input.dispatchEvent(new Event('input', {bubbles:true}));
  await new Promise(resolve => setTimeout(resolve, 100));
  modal.querySelector('.modal-close[aria-label="关闭"]').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  return !document.querySelector('.paper-intake-modal');
})()`;

let renderer;
try {
  console.log("[update-smoke] preparing isolated old application");
  await promisify(execFile)("/usr/bin/ditto", [oldApplication, targetPath]);
  const oldPid = await launch(targetPath);
  await waitFor(async () => {
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    if (runtime.pid !== oldPid || runtime.nodePath !== join(targetPath, "Contents/MacOS/我的文献库")) return false;
    const response = await fetch(new URL("/api/health", runtime.apiUrl), { headers: { Authorization: `Bearer ${runtime.token}` } });
    return response.ok && (await response.json()).ok;
  }, "旧版临时服务启动");
  renderer = await connectRenderer();
  await waitFor(() => renderer.evaluate("Boolean(document.querySelector('.topbar') && window.literatureDesktop)"), "旧版真实界面就绪");
  console.log("[update-smoke] checking normal quit with an unsaved draft");
  const draft = await renderer.evaluate(draftScript);
  await assert.rejects(installDesktopApplication({ sourcePath: newApplication, targetPath, runtimePath }, { running, quit, launch }), /尚未退出|拒绝退出/u);
  assert.equal((await inspectApplication(targetPath)).version, oldMetadata.version);
  assert.equal((await running())[0]?.pid, oldPid);
  assert.equal(await renderer.evaluate("document.querySelector('.paper-intake-reference textarea')?.value"), draft);
  assert.equal(await renderer.evaluate(clearDraftScript), true);
  renderer.close(); renderer = null;
  console.log("[update-smoke] draft cleared; checking replacement and restart");
  const result = await installDesktopApplication({ sourcePath: newApplication, targetPath, runtimePath }, { running, quit, launch });
  assert.equal(result.version, newMetadata.version);
  assert.notEqual(result.pid, oldPid);
  assert.equal((await running()).some((application) => application.pid === oldPid), false);
  assert.equal((await inspectApplication(targetPath)).version, newMetadata.version);
  renderer = await connectRenderer();
  await waitFor(() => renderer.evaluate("Boolean(document.querySelector('.topbar'))"), "新版真实界面启动");
  const library = await renderer.evaluate("window.literatureDesktop.request({path:'/api/library'}).then(response => ({status:response.status,papers:response.body.papers.length}))");
  assert.deepEqual(library, { status: 200, papers: 0 });
  const report = { ok: true, oldVersion: oldMetadata.version, newVersion: newMetadata.version, draftRefusedQuit: true, draftPreserved: true, oldProcessExited: true, newProcessAndServiceReady: true, newRendererReady: true, stableInstallPath: true, isolatedEmptyLibrary: true, noAiCalls: true };
  await writeFile(join(root, "release", `${newMetadata.version}-update-verification.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (renderer) {
    await renderer.evaluate(clearDraftScript).catch(() => undefined);
    renderer.close();
  }
  const applications = await running();
  if (applications.length) await quitApplications(applications);
  if ((await running()).length) throw new Error(`临时应用尚未退出，保留其应用和测试数据：${temporary}`);
  await rm(temporary, { recursive: true, force: true });
}
