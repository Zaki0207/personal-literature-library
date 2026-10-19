import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installDesktopApplication, waitForApplication } from "../scripts/install-desktop.mjs";

async function fixture(t, { installed = true, running = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "literature-update-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "release/我的文献库.app");
  const targetPath = join(root, "Applications/我的文献库.app");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(join(sourcePath, "version"), "0.1.8");
  if (installed) {
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(targetPath, "version"), "0.1.7");
  }
  const state = { applications: running && installed ? [{ pid: 123, path: targetPath }] : [], events: [] };
  const operations = {
    inspect: async (path) => ({ version: await readFile(join(path, "version"), "utf8") }),
    verify: async (path) => { state.events.push(`verify:${await readFile(join(path, "version"), "utf8")}`); },
    copy: (source, target) => cp(source, target, { recursive: true }),
    running: async () => [...state.applications],
    quit: async () => { state.events.push("quit"); state.applications = []; },
    launch: async (path) => { state.events.push(`launch:${await readFile(join(path, "version"), "utf8")}`); state.applications = [{ pid: 456, path }]; return 456; },
    ready: async (path, version, { expectedPid }) => {
      assert.equal(await readFile(join(path, "version"), "utf8"), version);
      assert.equal(expectedPid, 456);
      state.events.push("ready"); return { version, applicationPath: path, pid: expectedPid };
    },
  };
  const options = { sourcePath, targetPath, runtimePath: join(root, "runtime.json"), progress: () => {} };
  return { root, sourcePath, targetPath, state, operations, options };
}

test("desktop update verifies the staged app before a normal quit, replaces it, and starts the new version", async (t) => {
  const f = await fixture(t);
  const dataPath = join(f.root, "library.sqlite3");
  await writeFile(dataPath, "existing library outside the application");
  const result = await installDesktopApplication(f.options, f.operations);
  assert.equal(result.version, "0.1.8");
  assert.deepEqual(f.state.events, ["verify:0.1.8", "verify:0.1.8", "quit", "launch:0.1.8", "ready"]);
  assert.equal(await readFile(join(f.sourcePath, "version"), "utf8"), "0.1.8");
  assert.equal(await readFile(dataPath, "utf8"), "existing library outside the application");
  assert.deepEqual(await readdir(join(f.root, "Applications")), ["我的文献库.app"]);
});

test("desktop install starts a new application when no previous copy exists", async (t) => {
  const f = await fixture(t, { installed: false, running: false });
  await installDesktopApplication(f.options, f.operations);
  assert.equal(f.state.events.includes("quit"), false);
  assert.equal(await readFile(join(f.targetPath, "version"), "utf8"), "0.1.8");
});

test("a refused quit leaves the running old application and its bundle intact", async (t) => {
  const f = await fixture(t);
  f.operations.quit = async () => { throw new Error("unsaved draft prevents quit"); };
  await assert.rejects(installDesktopApplication(f.options, f.operations), /unsaved draft/u);
  assert.equal(await readFile(join(f.targetPath, "version"), "utf8"), "0.1.7");
  assert.deepEqual(f.state.applications, [{ pid: 123, path: f.targetPath }]);
  assert.equal(f.state.events.some((event) => event.startsWith("launch:")), false);
  assert.deepEqual(await readdir(join(f.root, "Applications")), ["我的文献库.app"]);
});

test("a corrupt staged copy aborts before requesting any quit", async (t) => {
  const f = await fixture(t);
  let verifications = 0;
  f.operations.verify = async () => { if (++verifications === 2) throw new Error("invalid signature"); };
  await assert.rejects(installDesktopApplication(f.options, f.operations), /invalid signature/u);
  assert.equal(await readFile(join(f.targetPath, "version"), "utf8"), "0.1.7");
  assert.deepEqual(f.state.events, []);
});

test("a failed replacement restores the old bundle and relaunches the old application", async (t) => {
  const f = await fixture(t);
  f.operations.rename = async (source, target) => {
    if (source.includes("-update-")) throw new Error("replacement failed");
    return rename(source, target);
  };
  await assert.rejects(installDesktopApplication(f.options, f.operations), /replacement failed/u);
  assert.equal(await readFile(join(f.targetPath, "version"), "utf8"), "0.1.7");
  assert.equal(f.state.events.at(-1), "launch:0.1.7");
  assert.deepEqual(await readdir(join(f.root, "Applications")), ["我的文献库.app"]);
});

test("a failed new startup quits the new app gracefully before restoring the old one", async (t) => {
  const f = await fixture(t);
  f.operations.ready = async () => { throw new Error("startup failed"); };
  await assert.rejects(installDesktopApplication(f.options, f.operations), /startup failed/u);
  assert.equal(await readFile(join(f.targetPath, "version"), "utf8"), "0.1.7");
  assert.deepEqual(f.state.events.slice(-3), ["launch:0.1.8", "quit", "launch:0.1.7"]);
});

test("if a failed new app refuses to quit, both its running bundle and the old backup are preserved", async (t) => {
  const f = await fixture(t);
  const quit = f.operations.quit;
  f.operations.quit = async (applications) => {
    if (applications.some((application) => application.pid === 456)) throw new Error("new app refused quit");
    return quit(applications);
  };
  f.operations.ready = async () => { throw new Error("startup failed"); };
  await assert.rejects(installDesktopApplication(f.options, f.operations), /旧版备份保留/u);
  assert.equal(await readFile(join(f.targetPath, "version"), "utf8"), "0.1.8");
  const backup = (await readdir(join(f.root, "Applications"))).find((name) => name.includes("-previous-"));
  assert.equal(await readFile(join(f.root, "Applications", backup, "version"), "utf8"), "0.1.7");
  assert.deepEqual(f.state.applications, [{ pid: 456, path: f.targetPath }]);
});

test("an existing update lock prevents concurrent replacement and is left intact", async (t) => {
  const f = await fixture(t);
  const lock = join(f.root, "Applications/.personal-literature-library-update.lock");
  await mkdir(lock);
  await assert.rejects(installDesktopApplication(f.options, f.operations), /另一个更新/u);
  assert.equal(await readFile(join(f.targetPath, "version"), "utf8"), "0.1.7");
  assert.equal((await readdir(join(f.root, "Applications"))).includes(".personal-literature-library-update.lock"), true);
});

test("a malformed existing bundle is not overwritten even when its metadata is missing", async (t) => {
  const f = await fixture(t);
  await rm(join(f.targetPath, "version"));
  await assert.rejects(installDesktopApplication(f.options, f.operations), { code: "ENOENT" });
  assert.equal((await readdir(join(f.root, "Applications"))).includes("我的文献库.app"), true);
  assert.equal(f.state.events.includes("quit"), false);
});

test("filesystem aliases cannot make the installer overwrite its own source", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "release-alias");
  await symlink(join(f.root, "release"), alias);
  await assert.rejects(installDesktopApplication({ ...f.options, targetPath: join(alias, "我的文献库.app") }, f.operations), /不能相同/u);
  assert.equal(await readFile(join(f.sourcePath, "version"), "utf8"), "0.1.8");
  assert.equal(f.state.events.includes("quit"), false);
});

test("readiness requires the installed path, exact launched PID, version, and authenticated health response", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "literature-update-ready-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    assert.equal(request.url, "/api/health");
    assert.equal(request.headers.authorization, "Bearer test-only-token");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((closed) => server.close(closed)));
  const applicationPath = join(root, "我的文献库.app");
  await mkdir(join(applicationPath, "Contents/MacOS"), { recursive: true });
  await writeFile(join(applicationPath, "Contents/MacOS/我的文献库"), "test executable");
  const runtimePath = join(root, "runtime.json");
  const runtime = { apiUrl: `http://127.0.0.1:${server.address().port}`, token: "test-only-token", pid: process.pid, appVersion: "0.1.8", nodePath: join(applicationPath, "Contents/MacOS/我的文献库") };
  await writeFile(runtimePath, JSON.stringify({ ...runtime, nodePath: "/old/version/我的文献库" }));
  await assert.rejects(waitForApplication(applicationPath, "0.1.8", { runtimePath, timeoutMs: 1 }), /未在规定时间/u);
  await writeFile(runtimePath, JSON.stringify(runtime));
  await assert.rejects(waitForApplication(applicationPath, "0.1.8", { runtimePath, expectedPid: process.pid + 1, timeoutMs: 1 }), /未在规定时间/u);
  assert.equal(calls, 0);
  const result = await waitForApplication(applicationPath, "0.1.8", { runtimePath, expectedPid: process.pid, timeoutMs: 1000 });
  assert.equal(result.pid, process.pid);
  assert.equal(calls, 1);
  const alias = join(root, "installed-app-alias");
  await symlink(applicationPath, alias);
  await writeFile(runtimePath, JSON.stringify({ ...runtime, nodePath: join(alias, "Contents/MacOS/我的文献库") }));
  assert.equal((await waitForApplication(applicationPath, "0.1.8", { runtimePath, expectedPid: process.pid, timeoutMs: 1000 })).pid, process.pid);
  assert.equal(calls, 2);
});
