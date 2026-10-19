#!/usr/bin/env node
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { buildDesktop, run } from "./build-desktop.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("首版安装包须在 Apple Silicon Mac 上构建。Intel 版本尚未验证。");
const electronZipArgument = process.argv.indexOf("--electron-zip-dir");
const electronZipValue = electronZipArgument === -1 ? undefined : process.argv[electronZipArgument + 1];
if (electronZipArgument !== -1 && (!electronZipValue || electronZipValue.startsWith("--"))) throw new Error("--electron-zip-dir 须指定包含当前版本 Electron ZIP 的目录。");
const electronZipDir = electronZipValue ? resolve(electronZipValue) : undefined;
if (!process.argv.includes("--skip-build")) await buildDesktop();
const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const stage = resolve(root, "dist-desktop/package");
const output = resolve(root, "release");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const path of ["desktop", "scripts", "lib", "LICENSE", "dist-desktop/renderer", "node_modules/undici"]) {
  await cp(resolve(root, path), resolve(stage, path), {
    recursive: true,
    filter: (source) => source !== resolve(root, "scripts/enrich-literature.mjs"),
  });
}
await writeFile(resolve(stage, "package.json"), JSON.stringify({ name: metadata.name, version: metadata.version, type: "module", main: "desktop/main/index.mjs", description: "本地优先的个人文献工作台", dependencies: { undici: metadata.dependencies.undici } }, null, 2));
const paths = await packager({
  dir: stage, out: resolve(output, metadata.version), name: "我的文献库", platform: "darwin", arch: "arm64",
  electronVersion: metadata.devDependencies.electron, overwrite: true, asar: true,
  ...(electronZipDir ? { electronZipDir } : {}),
  icon: resolve(root, "dist-desktop/literature.icns"),
  appBundleId: "com.personal-literature-library.desktop", appVersion: metadata.version,
  darwinDarkModeSupport: true, extraResource: [resolve(root, "dist-desktop/keychain-helper-v1")],
  extendInfo: {
    LSMinimumSystemVersion: "13.0",
    CFBundleDocumentTypes: [{ CFBundleTypeName: "PDF Document", CFBundleTypeRole: "Viewer", LSHandlerRank: "Alternate", LSItemContentTypes: ["com.adobe.pdf"] }],
    NSHumanReadableCopyright: "个人文献库",
  },
  prune: false,
});
const applicationPath = resolve(paths[0], "我的文献库.app");
// Apple Silicon binaries require an ad hoc seal. This is not Developer ID signing or notarization.
await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", applicationPath]);
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", applicationPath]);
const dmgRoot = resolve(root, "dist-desktop/dmg");
await rm(dmgRoot, { recursive: true, force: true });
await mkdir(dmgRoot, { recursive: true });
await run("/usr/bin/ditto", [applicationPath, resolve(dmgRoot, "我的文献库.app")]);
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", resolve(dmgRoot, "我的文献库.app")]);
await symlink("/Applications", resolve(dmgRoot, "Applications"));
const dmgPath = resolve(output, `我的文献库-${metadata.version}-arm64.dmg`);
await rm(dmgPath, { force: true });
await run("/usr/bin/hdiutil", ["create", "-volname", "我的文献库", "-srcfolder", dmgRoot, "-format", "UDZO", "-ov", dmgPath]);
await writeFile(resolve(output, "发布说明.txt"), "这是 Apple Silicon macOS 13+ 本地测试版。\n应用仅作 ad hoc 签章，尚未经过 Developer ID 签名与 Apple 公证。\n应用包含 Node 运行时与预编译钥匙串助手，运行不需要 Node、npm 或 Xcode。\n现有文献库、PDF 和钥匙串账户沿用原位置。数据库快照不包含 PDF。\n");
console.log(`应用：${applicationPath}\n安装包：${dmgPath}\n当前产物尚未经过 Developer ID 签名与 Apple 公证。`);
