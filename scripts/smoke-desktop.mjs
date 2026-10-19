#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { createLongSmokePdf, createSmokePdf } from "./desktop-smoke-fixture.mjs";
import { seedPdfRecoverySmoke } from "./desktop-pdf-recovery-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(resolve(tmpdir(), "literature-desktop-smoke-"));
const pdf = resolve(temp, "smoke.pdf");
const longPdf = resolve(temp, "long-smoke.pdf");
const documentPdf = resolve(temp, "中文博客阅读摘录.pdf");
const invalidPdf = resolve(temp, "invalid-smoke.pdf");
const reportPath = resolve(temp, "report.json");
await writeFile(pdf, createSmokePdf());
await writeFile(longPdf, createLongSmokePdf());
await writeFile(documentPdf, createSmokePdf());
await seedPdfRecoverySmoke({ dbPath: resolve(temp, "library.sqlite3"), backupDir: resolve(temp, "backups"), invalidPdfPath: invalidPdf });
const packaged = process.argv.find((argument) => argument.endsWith(".app"));
const interactive = process.argv.includes("--interactive");
const executable = packaged ? resolve(packaged, "Contents/MacOS/我的文献库") : electronPath;
const env = { ...process.env, LIBRARY_DB_PATH: resolve(temp, "library.sqlite3"), LIBRARY_BACKUP_DIR: resolve(temp, "backups"), LIBRARY_PDF_DIR: resolve(temp, "pdfs"), LIBRARY_RUNTIME_PATH: resolve(temp, "runtime.json"), LIBRARY_DESKTOP_USER_DATA: resolve(temp, "desktop"), LIBRARY_DESKTOP_SMOKE: "1", LIBRARY_DESKTOP_SMOKE_REPORT: reportPath, LIBRARY_DESKTOP_SMOKE_PDF: pdf, LIBRARY_DESKTOP_SMOKE_LONG_PDF: longPdf, LIBRARY_DESKTOP_SMOKE_DOCUMENT_PDF: documentPdf, LIBRARY_DESKTOP_SMOKE_INVALID_PDF: invalidPdf };
if (interactive) env.LIBRARY_DESKTOP_SMOKE_KEEP_OPEN = "1";
delete env.ELECTRON_RUN_AS_NODE;
delete env.LIBRARY_DESKTOP_DEV_URL;
let exitCode;
if (interactive) console.log(`界面验收使用独立临时文献库：${temp}`);
try {
  exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(executable, packaged ? [] : [root], { cwd: root, stdio: "inherit", env, shell: false });
    const timer = interactive ? null : setTimeout(() => { child.kill("SIGKILL"); reject(new Error("桌面验证超过 120 秒。")); }, 120_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolveExit(code); });
  });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (exitCode !== 0 || !report.ok) throw new Error(`桌面验证失败：${JSON.stringify(report)}`);
  if (process.env.LIBRARY_DESKTOP_SMOKE_REPORT_COPY) await writeFile(resolve(process.env.LIBRARY_DESKTOP_SMOKE_REPORT_COPY), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
