#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import electronPath from "electron";
import { buildKeychainHelper } from "./build-desktop.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await buildKeychainHelper();
const port = Number(process.env.LIBRARY_DESKTOP_PORT || 5179);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("桌面开发端口无效。");
const server = await createServer({ configFile: resolve(root, "desktop.vite.config.ts"), server: { port } });
await server.listen();
const env = { ...process.env, LIBRARY_DESKTOP_DEV_URL: `http://127.0.0.1:${port}` };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [root], { cwd: root, stdio: "inherit", env, shell: false });
let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true; child.kill(signal || "SIGTERM"); await server.close();
}
child.once("exit", async (code) => { await stop(); process.exitCode = code ?? 1; });
child.once("error", async (error) => { console.error(error.message); await stop(); process.exitCode = 1; });
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
console.log(`桌面开发界面：${env.LIBRARY_DESKTOP_DEV_URL}`);
