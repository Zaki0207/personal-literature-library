#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DESKTOP_BUNDLE_ID = "com.personal-literature-library.desktop";
export const DESKTOP_APP_NAME = "我的文献库.app";
export const DEFAULT_RUNTIME_PATH = join(homedir(), "Library/Application Support/个人文献库/runtime.json");

// AppKit requests a normal macOS quit. It never sends a termination signal or
// forces an application past its existing save-before-quit handshake.
const applicationScript = `ObjC.import('AppKit');
function run(argv) {
  var applications = ObjC.unwrap($.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]));
  if (argv[1] === 'quit') {
    var target = applications.find(function (application) { return Number(application.processIdentifier) === Number(argv[2]); });
    return JSON.stringify(!target || Boolean(target.terminate));
  }
  return JSON.stringify(applications.map(function (application) {
    return {pid:Number(application.processIdentifier),path:ObjC.unwrap(application.bundleURL.path)};
  }));
}`;

export async function inspectApplication(applicationPath) {
  const info = await lstat(applicationPath);
  if (!info.isDirectory() || info.isSymbolicLink() || !applicationPath.endsWith(".app")) throw new Error("须指定真实的 .app 应用目录。");
  const { stdout } = await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(applicationPath, "Contents/Info.plist")]);
  const plist = JSON.parse(stdout);
  if (plist.CFBundleIdentifier !== DESKTOP_BUNDLE_ID || plist.CFBundleExecutable !== "我的文献库" || !/^\d+\.\d+\.\d+$/u.test(plist.CFBundleShortVersionString)) {
    throw new Error("应用标识或版本无效，不能覆盖安装。");
  }
  await access(join(applicationPath, "Contents/MacOS", plist.CFBundleExecutable), constants.X_OK);
  return { version: plist.CFBundleShortVersionString };
}

export async function listRunningApplications() {
  const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", applicationScript, DESKTOP_BUNDLE_ID, "list"], { timeout: 5000 });
  return JSON.parse(stdout);
}

export async function quitApplications(applications, { timeoutMs = 20_000 } = {}) {
  for (const application of applications) {
    const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", applicationScript, DESKTOP_BUNDLE_ID, "quit", String(application.pid)], { timeout: 5000 });
    if (!JSON.parse(stdout)) throw new Error("应用拒绝退出，请先保存当前编辑后重试更新。旧版仍保留。");
  }
  const deadline = Date.now() + timeoutMs;
  const pids = new Set(applications.map((application) => application.pid));
  do {
    if (!(await listRunningApplications()).some((application) => pids.has(application.pid))) return;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error("应用尚未退出，可能有未保存草稿或保存失败。请在应用中处理后重试，更新没有强制关闭旧版。");
}

export async function launchApplication(applicationPath, { env = process.env, args = [] } = {}) {
  const launchEnv = { ...env };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  delete launchEnv.LIBRARY_DESKTOP_DEV_URL;
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(join(applicationPath, "Contents/MacOS/我的文献库"), args, {
      cwd: dirname(applicationPath), env: launchEnv, detached: true, stdio: "ignore", shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolveLaunch(child.pid); });
  });
}

export async function waitForApplication(applicationPath, version, { runtimePath = DEFAULT_RUNTIME_PATH, expectedPid, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const executable = await realpath(join(applicationPath, "Contents/MacOS/我的文献库"));
  do {
    try {
      const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
      const url = new URL(runtime.apiUrl);
      if (typeof runtime.nodePath !== "string" || await realpath(runtime.nodePath) !== executable || runtime.appVersion !== version || !Number.isInteger(runtime.pid) || runtime.pid <= 0 ||
          (expectedPid !== undefined && runtime.pid !== expectedPid) ||
          typeof runtime.token !== "string" || !runtime.token || url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
          !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("等待新版运行状态。");
      process.kill(runtime.pid, 0);
      const response = await fetch(new URL("/api/health", url), {
        headers: { Authorization: `Bearer ${runtime.token}` }, redirect: "error", signal: AbortSignal.timeout(1000),
      });
      if (response.ok && (await response.json()).ok === true) return { pid: runtime.pid, version, applicationPath };
    } catch { /* A stale runtime file or a service still starting is not readiness. */ }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error("新版未在规定时间内启动并通过本地服务检查。");
}

export async function defaultInstallPath() {
  const systemPath = join("/Applications", DESKTOP_APP_NAME);
  const userPath = join(homedir(), "Applications", DESKTOP_APP_NAME);
  for (const path of [systemPath, userPath]) {
    try { await lstat(path); return path; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try { await access("/Applications", constants.W_OK); return systemPath; }
  catch { return userPath; }
}

export async function defaultPackagePath() {
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  return join(root, "release", metadata.version, "我的文献库-darwin-arm64", DESKTOP_APP_NAME);
}

export async function installDesktopApplication({ sourcePath, targetPath, runtimePath = DEFAULT_RUNTIME_PATH, progress = console.log }, overrides = {}) {
  const operations = {
    inspect: inspectApplication,
    verify: (path) => execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]),
    copy: (source, target) => execute("/usr/bin/ditto", [source, target]),
    running: listRunningApplications, quit: quitApplications, launch: launchApplication,
    ready: waitForApplication, rename, ...overrides,
  };
  const requestedSource = resolve(sourcePath);
  const requestedTarget = resolve(targetPath);
  if (!requestedTarget.endsWith(".app")) throw new Error("安装目标须是 .app 应用路径。");
  const assertSeparate = (source, target) => {
    if (source === target || source.startsWith(`${target}${sep}`) || target.startsWith(`${source}${sep}`)) throw new Error("安装源与目标不能相同或互相包含。");
  };
  assertSeparate(requestedSource, requestedTarget);
  const metadata = await operations.inspect(requestedSource);
  await operations.verify(requestedSource);
  const source = await realpath(requestedSource);
  await mkdir(dirname(requestedTarget), { recursive: true });
  const parent = await realpath(dirname(requestedTarget));
  const target = join(parent, basename(requestedTarget));
  assertSeparate(source, target);
  await access(parent, constants.W_OK);
  const lockPath = join(parent, ".personal-literature-library-update.lock");
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`另一个更新正在进行，或上次更新被中断。请先核对 ${lockPath}。`);
    throw error;
  }
  const id = randomUUID();
  const stage = join(parent, `.我的文献库-update-${id}.app`);
  const previous = join(parent, `.我的文献库-previous-${id}.app`);
  let oldMoved = false;
  let newMoved = false;
  let runningBefore = [];
  let stopped = false;
  try {
    const targetInfo = await lstat(target).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (targetInfo) await operations.inspect(target);
    progress(`准备安装 ${metadata.version}：${target}`);
    await operations.copy(source, stage);
    const staged = await operations.inspect(stage);
    if (staged.version !== metadata.version) throw new Error("安装暂存副本的版本不一致。");
    await operations.verify(stage);
    runningBefore = await operations.running();
    if (runningBefore.length) {
      progress("请求旧版正常退出，等待笔记保存和草稿检查…");
      await operations.quit(runningBefore);
      stopped = true;
    }
    if ((await operations.running()).length) throw new Error("文献应用仍在运行，已取消替换。请保存当前编辑后重试。");
    try { await operations.rename(target, previous); oldMoved = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await operations.rename(stage, target);
    newMoved = true;
    progress("新版已安装，正在启动并检查本地服务…");
    const expectedPid = await operations.launch(target);
    const result = await operations.ready(target, metadata.version, { runtimePath, expectedPid });
    if (oldMoved) await rm(previous, { recursive: true, force: true }).catch(() => progress(`更新成功，旧版备份暂保留在 ${previous}`));
    progress(`更新完成：${metadata.version}，新版已运行。`);
    return result;
  } catch (error) {
    try {
      if (newMoved) {
        const runningNew = (await operations.running()).filter((application) => resolve(application.path) === target);
        if (runningNew.length) await operations.quit(runningNew);
        if ((await operations.running()).some((application) => resolve(application.path) === target)) throw new Error("新版仍在运行，不能删除其应用包。");
        await rm(target, { recursive: true, force: true });
        newMoved = false;
      }
      if (oldMoved) { await operations.rename(previous, target); oldMoved = false; }
      if (stopped && runningBefore.length) await operations.launch(runningBefore[0].path);
    } catch (recoveryError) {
      throw new Error(`${error.message} 恢复未完成：${recoveryError.message}${oldMoved ? ` 旧版备份保留在 ${previous}。` : ""}`, { cause: error });
    }
    throw error;
  } finally {
    try { await rm(stage, { recursive: true, force: true }); }
    finally { await rm(lockPath, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("当前自动安装仅支持 Apple Silicon Mac。");
    const args = process.argv.slice(2);
    let targetArgument;
    let sourceArgument;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--target") {
        targetArgument = args[++index];
        if (!targetArgument || targetArgument.startsWith("--")) throw new Error("--target 须指定安装目标 .app 路径。");
      } else if (args[index].endsWith(".app") && !sourceArgument) sourceArgument = args[index];
      else throw new Error(`未知安装参数：${args[index]}`);
    }
    await installDesktopApplication({ sourcePath: sourceArgument || await defaultPackagePath(), targetPath: targetArgument || await defaultInstallPath() });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
