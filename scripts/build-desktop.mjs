#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} 失败（${signal || code}）。`)));
  });
}

export async function buildKeychainHelper() {
  if (process.platform !== "darwin") throw new Error("macOS 发布构建需要在 Mac 上预编译钥匙串助手。");
  const target = resolve(root, "dist-desktop/keychain-helper-v1");
  await mkdir(dirname(target), { recursive: true });
  const source = resolve(root, "scripts/ai/keychain-helper.swift");
  const [sourceInfo, targetInfo] = await Promise.all([stat(source), stat(target).catch(() => null)]);
  if (!targetInfo || sourceInfo.mtimeMs > targetInfo.mtimeMs) {
    await run("/usr/bin/xcrun", ["swiftc", source, "-O", "-target", "arm64-apple-macos13.0", "-o", target]);
    await chmod(target, 0o755);
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", target]);
  }
  return target;
}

export async function buildApplicationIcon() {
  const source = resolve(root, "desktop/assets/generate-icon.swift");
  const generator = resolve(root, "dist-desktop/generate-icon");
  const iconset = resolve(root, "dist-desktop/literature.iconset");
  const output = resolve(root, "dist-desktop/literature.icns");
  const [sourceInfo, outputInfo] = await Promise.all([stat(source), stat(output).catch(() => null)]);
  if (!outputInfo || sourceInfo.mtimeMs > outputInfo.mtimeMs) {
    await mkdir(dirname(generator), { recursive: true });
    await run("/usr/bin/xcrun", ["swiftc", source, "-O", "-o", generator]);
    await run(generator, [iconset]);
    await run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", output]);
  }
  return output;
}

export async function buildDesktop() {
  await build({ configFile: resolve(root, "desktop.vite.config.ts") });
  for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
    await cp(resolve(root, "node_modules/pdfjs-dist", directory), resolve(root, "dist-desktop/renderer/pdfjs", directory), { recursive: true });
  }
  await cp(resolve(root, "node_modules/pdfjs-dist/LICENSE"), resolve(root, "dist-desktop/renderer/pdfjs/LICENSE"));
  await buildKeychainHelper();
  await buildApplicationIcon();
  console.log("桌面构建完成：dist-desktop/renderer 和预编译钥匙串助手。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildDesktop().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
