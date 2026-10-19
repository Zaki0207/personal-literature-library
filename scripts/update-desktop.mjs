#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./build-desktop.mjs";
import { defaultInstallPath, DESKTOP_APP_NAME, installDesktopApplication } from "./install-desktop.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("当前自动更新仅支持 Apple Silicon Mac。");
  const args = process.argv.slice(2);
  const packageArguments = [];
  let targetPath;
  for (let index = 0; index < args.length; index += 1) {
    if (["--target", "--electron-zip-dir"].includes(args[index])) {
      const option = args[index];
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${option} 须指定路径。`);
      if (option === "--target") targetPath = resolve(value);
      else packageArguments.push(option, value);
    } else throw new Error(`未知更新参数：${args[index]}`);
  }
  console.log("构建并打包新版；旧版可继续使用…");
  await run(process.execPath, [join(root, "scripts/package-desktop.mjs"), ...packageArguments]);
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const sourcePath = join(root, "release", metadata.version, "我的文献库-darwin-arm64", DESKTOP_APP_NAME);
  console.log("使用隔离临时库验证实际安装包…");
  await run(process.execPath, [join(root, "scripts/smoke-desktop.mjs"), sourcePath], {
    env: { ...process.env, LIBRARY_DESKTOP_SMOKE_REPORT_COPY: join(root, "release", `${metadata.version}-verification.json`) },
  });
  await installDesktopApplication({ sourcePath, targetPath: targetPath || await defaultInstallPath() });
} catch (error) { console.error(error.message); process.exitCode = 1; }
